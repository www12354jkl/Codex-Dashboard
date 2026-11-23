
import { execFile, spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, inflateRawSync } from "node:zlib";
import { createDefaultUpdateStatus } from "../shared/mock.js";
import type { OverlayConfig, UpdateProgress, UpdateStatus } from "../shared/types.js";
// @ts-expect-error The standalone Node helper is JavaScript. Its public signature is declared below.
import { stageAndSwapDirectory as swap } from "./applyStaged.mjs";

export const stageAndSwapDirectory: (
  target: string, staged: string, afterSwap?: () => void | Promise<void>
) => Promise<void> = swap;

export function parseGithubRepo(value: string): string | null {
  const match = /^(?:(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:))?([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]{1,100})\/?$/i.exec(value.trim());
  if (!match) return null;
  const name = match[2]!.replace(/\.git$/i, "");
  return name && name !== "." && name !== ".." ? match[1] + "/" + name : null;
}

function parseVersion(value: string) {
  const pattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  const match = pattern.exec(value.trim());
  const pre = match?.[4]?.split(".");
  if (!match || pre?.some(part => /^0\d+$/.test(part))) throw new Error("Invalid semantic version: " + value);
  return { core: match.slice(1, 4).map(BigInt), pre };
}

export function compareSemver(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const order = (x: string | bigint, y: string | bigint) => x < y ? -1 : x > y ? 1 : 0;
  for (let i = 0; i < left.core.length; i++) {
    const cmp = order(left.core[i]!, right.core[i]!);
    if (cmp) return cmp;
  }
  if (!left.pre || !right.pre) return Number(!left.pre) - Number(!right.pre);
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]!;
    const y = right.pre[i]!;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    const cmp = xNumeric && yNumeric ? order(BigInt(x), BigInt(y))
      : xNumeric !== yNumeric ? Number(yNumeric) - Number(xNumeric) : order(x, y);
    if (cmp) return cmp;
  }
  return order(BigInt(left.pre.length), BigInt(right.pre.length));
}

export function validateArchiveEntryPath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").replace(/\/$/, "");
  const segments = normalized.split("/");
  return segments.every(segment => segment.length > 0 && segment !== "." && segment !== ".."
    && !/[<>:"|?*\u0000-\u001f\u007f]/.test(segment) && !/[. ]$/.test(segment)
    && !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\s*\.|$)/i.test(segment)
    && !/^(?:\.git|\.codex-dashboard)$/i.test(segment));
}

export function verifySha256(data: Uint8Array, expected: string): boolean {
  const digest = expected.trim().replace(/^sha256:/i, "");
  return /^[\da-f]{64}$/i.test(digest)
    && timingSafeEqual(createHash("sha256").update(data).digest(), Buffer.from(digest, "hex"));
}

const maxDownload = 384 * 1024 * 1024;
const maxExpanded = 1536 * 1024 * 1024;
const maxEntry = 384 * 1024 * 1024;
const gitExec = promisify(execFile);

function git(root: string, ...args: string[]): Promise<string> {
  return gitExec("git", args, {
    cwd: root, windowsHide: true, timeout: 60_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }
  }).then(({ stdout }) => stdout.trim());
}

async function isDirectoryEntry(filename: string): Promise<boolean> {
  return (await lstat(filename).catch(() => null))?.isDirectory() ?? false;
}

async function isFile(filename: string): Promise<boolean> {
  return (await lstat(filename).catch(() => null))?.isFile() ?? false;
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

interface ZipEntry {
  relative: string;
  directory: boolean;
  method: number;
  originalSize: number;
  checksum: number;
  mode: number;
  compressed: Buffer;
}

function readZipEntries(zip: Buffer): ZipEntry[] {
  const invalid = () => new Error("ZIP 文件结构无效或包含不受支持的条目");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let end = zip.length - 22;
  const firstPossibleEnd = Math.max(0, end - 65535);
  for (; end >= firstPossibleEnd; end--) {
    if (zip.readUInt32LE(end) === 0x06054b50 && end + 22 + zip.readUInt16LE(end + 20) === zip.length) break;
  }
  if (end < firstPossibleEnd) throw invalid();
  const entries = zip.readUInt16LE(end + 10);
  const start = zip.readUInt32LE(end + 16);
  const size = zip.readUInt32LE(end + 12);
  if (!entries || entries === 65535 || zip.readUInt32LE(end + 4) !== 0
    || zip.readUInt16LE(end + 8) !== entries || start + size !== end) throw invalid();

  const result: ZipEntry[] = [];
  const names = new Map<string, { name: string; directory: boolean; explicit: boolean }>();
  let cursor = start;
  let totalExpanded = 0;
  for (let i = 0; i < entries; i++) {
    if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const originalSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const attributes = zip.readUInt32LE(cursor + 38);
    const unixKind = (attributes >>> 16) & 0xf000;
    const local = zip.readUInt32LE(cursor + 42);
    const disk = zip.readUInt16LE(cursor + 34);
    const nameStart = cursor + 46;
    cursor = nameStart + nameLength + extraLength + commentLength;
    totalExpanded += originalSize;
    if (cursor > end || disk !== 0 || (flags & ~0x80e) !== 0 || (method !== 0 && method !== 8)
      || (attributes & 0x408) !== 0 || (unixKind !== 0 && unixKind !== 0x8000 && unixKind !== 0x4000)
      || originalSize > maxEntry || totalExpanded > maxExpanded
      || local + 30 > start || zip.readUInt32LE(local) !== 0x04034b50) throw invalid();
    const localName = zip.readUInt16LE(local + 26);
    const dataStart = local + 30 + localName + zip.readUInt16LE(local + 28);
    const nameBytes = zip.subarray(nameStart, nameStart + nameLength);
    if (dataStart + compressedSize > start || zip.readUInt16LE(local + 6) !== flags
      || zip.readUInt16LE(local + 8) !== method || localName !== nameLength
      || !nameBytes.equals(zip.subarray(local + 30, local + 30 + localName))) throw invalid();
    if (!(flags & 8) && (zip.readUInt32LE(local + 14) !== checksum
      || zip.readUInt32LE(local + 18) !== compressedSize || zip.readUInt32LE(local + 22) !== originalSize)) throw invalid();

    const name = decoder.decode(nameBytes);
    if (!validateArchiveEntryPath(name)) throw new Error("ZIP 文件包含不安全的路径");
    const normalized = name.replaceAll("\\", "/");
    const directory = normalized.endsWith("/") || unixKind === 0x4000 || (attributes & 0x10) !== 0;
    if ((directory && originalSize !== 0) || (method === 0 && compressedSize !== originalSize)) throw invalid();
    const relative = normalized.replace(/\/$/, "");
    const segments = relative.split("/");
    let prefix = "";
    for (const [index, segment] of segments.entries()) {
      prefix = prefix ? prefix + "/" + segment : segment;
      const key = prefix.toLowerCase();
      const explicit = index === segments.length - 1;
      const isDir = !explicit || directory;
      const previous = names.get(key);
      if (previous && (previous.name !== prefix || previous.directory !== isDir || (previous.explicit && explicit))) throw invalid();
      names.set(key, { name: prefix, directory: isDir, explicit: explicit || previous?.explicit === true });
    }
    const mode = ((attributes >>> 16) & 0o111) ? 0o755 : 0o644;
    result.push({ relative, directory, method, originalSize, checksum, mode,
      compressed: zip.subarray(dataStart, dataStart + compressedSize) });
  }
  if (cursor !== end) throw invalid();
  return result;
}

export async function extractReleaseArchive(zip: Buffer, destination: string): Promise<void> {
  const entries = readZipEntries(zip);
  await mkdir(destination, { mode: 0o700 });
  for (const entry of entries) {
    const filename = path.join(destination, entry.relative);
    if (entry.directory) {
      await mkdir(filename, { recursive: true });
    } else {
      await mkdir(path.dirname(filename), { recursive: true });
      const bytes = entry.method === 0 ? entry.compressed
        : inflateRawSync(entry.compressed, { maxOutputLength: Math.max(1, entry.originalSize) });
      if (bytes.length !== entry.originalSize || crc32(bytes) !== entry.checksum) throw new Error("ZIP 解压后的文件校验失败");
      await writeFile(filename, bytes, { flag: "wx", mode: entry.mode });
    }
  }
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

interface GitPlan {
  mode: "git";
  branch: string;
  upstream: string;
  commit: string;
}

interface ReleasePlan {
  mode: "release";
  repo: string;
  asset: ReleaseAsset;
  checksumAsset?: ReleaseAsset;
  version: string;
}

interface StagedRelease {
  workspace: string;
  staged: string;
}

interface UpdaterOptions {
  root: string;
  currentVersion: string;
  helperPath: string;
  executable: string;
  args: string[];
  packaged?: boolean;
  onStatus?: (status: UpdateStatus) => void;
  onProgress?: (progress: UpdateProgress) => void;
}


async function assetBytes(asset: ReleaseAsset, repo: string, limit: number): Promise<Buffer> {
  const url = new URL(asset.browser_download_url);
  if (url.origin !== "https://github.com" || url.username || url.password
    || !url.pathname.toLowerCase().startsWith("/" + repo.toLowerCase() + "/releases/download/")) {
    throw new Error("发布附件地址与所选 GitHub 仓库不匹配");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length")) > limit
    || new URL(response.url).protocol !== "https:") {
    await response.body?.cancel();
    throw new Error("下载 GitHub 发布附件失败（HTTP " + response.status + "）");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > limit) throw new Error("发布附件超过下载限制");
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks, bytes);
}

function selectAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  const platform = { win32: /^(win32|windows|win|win64|winarm64)$/, darwin: /^(darwin|mac|macos|osx)$/,
    linux: /^(linux|appimage)$/ };
  const arch = { x64: /^(x64|x86_64|amd64|win64)$/, arm64: /^(arm64|aarch64|winarm64)$/,
    ia32: /^(ia32|x86|i386)$/ };
  const entries = assets.flatMap(asset => {
    if (!/\.zip$/i.test(asset.name) || /(?:source|symbols|debug)/i.test(asset.name)) return [];
    const tags = asset.name.toLowerCase().slice(0, -4).replaceAll("x86_64", "amd64").split(/[-_.]/);
    const platforms = Object.entries(platform).filter(([, pattern]) => tags.some(tag => pattern.test(tag)));
    const architectures = Object.entries(arch).filter(([, pattern]) => tags.some(tag => pattern.test(tag)));
    if (platforms.length && !platforms.some(([name]) => name === process.platform)) return [];
    if (architectures.length && !architectures.some(([name]) => name === process.arch)) return [];
    return [{ asset, score: platforms.length * 2 + architectures.length }];
  });
  entries.sort((a, b) => b.score - a.score || a.asset.name.localeCompare(b.asset.name));
  return entries[0]?.asset;
}

function assetChecksum(asset: ReleaseAsset, sidecarName: string, contents: string): string {
  for (const line of contents.split(/\r?\n/)) {
    const parsed = /^([\da-f]{64})\s+[* ]?(.+)$/i.exec(line.trim());
    if (parsed?.[2] === asset.name || parsed?.[2] === "./" + asset.name) return parsed[1]!;
  }
  const single = contents.trim();
  if (sidecarName.toLowerCase() === asset.name.toLowerCase() + ".sha256" && /^[\da-f]{64}$/i.test(single)) return single;
  throw new Error("SHA-256 校验文件缺少所选 ZIP 的摘要");
}

export class GithubUpdater {
  private status: UpdateStatus;
  private plan?: GitPlan | ReleasePlan;
  private pending?: Promise<UpdateStatus>;
  private staged?: StagedRelease;
  private mergedGit?: GitPlan;
  private restartScheduled = false;

  constructor(private readonly options: UpdaterOptions) {
    this.status = createDefaultUpdateStatus(options.currentVersion);
  }

  getStatus(): UpdateStatus {
    return { ...this.status, releaseNotes: [...this.status.releaseNotes] };
  }

  invalidatePlan(repo?: string): void {
    this.plan = undefined;
    this.mergedGit = undefined;
    if (this.status.state === "available" || this.status.state === "error") {
      this.setStatus({
        state: "idle",
        canApply: false,
        latestVersion: null,
        releaseNotes: [],
        repo: repo !== undefined ? repo.trim() : this.status.repo,
        error: undefined,
        message: "仓库配置已更新，请重新检查更新"
      });
    } else if (repo !== undefined && repo.trim() !== this.status.repo) {
      this.setStatus({ repo: repo.trim() });
    }
  }

  checkForUpdates(config: OverlayConfig, repoOverride?: string): Promise<UpdateStatus> {
    if (this.status.state === "applied_restart_required") return Promise.resolve(this.status);
    return this.run(async () => {
      const repoInput = (repoOverride ?? config.repo).trim();
      this.plan = this.mergedGit;
      this.publish({ ...createDefaultUpdateStatus(this.options.currentVersion, { ...config, repo: repoInput }),
        state: "checking", message: "正在检查更新" });
      if (this.mergedGit) {
        return this.setStatus({ state: "available", mode: "git", canApply: true, message: "源码已快进，等待重新构建" });
      }
      if (repoInput && !parseGithubRepo(repoInput)) throw new Error("请输入 GitHub 仓库 owner/repo 或仓库 URL");
      const requestedRepo = parseGithubRepo(repoInput);
      const root = this.options.root;
      const gitRoot = this.options.packaged ? "" : await git(root, "rev-parse", "--show-toplevel").catch(() => "");
      const checkout = gitRoot && path.relative(await realpath(root), await realpath(gitRoot)) === "";
      const upstream = checkout ? await git(root, "rev-parse", "--symbolic-full-name", "@{upstream}").catch(() => "") : "";
      const branch = upstream ? await git(root, "symbolic-ref", "--short", "HEAD") : "";
      const remote = branch ? await git(root, "config", "--get", "branch." + branch + ".remote") : "";
      const upstreamRepo = remote && remote !== "." ? parseGithubRepo(await git(root, "remote", "get-url", remote)) : null;
      const matches = !requestedRepo || upstreamRepo?.toLowerCase() === requestedRepo.toLowerCase();
      if (config.updateChannel !== "release" && upstream && remote && matches) {
        return this.checkGit(branch, upstream, remote, upstreamRepo ?? "");
      }
      if (config.updateChannel === "git") throw new Error("当前检出分支需要匹配所选仓库的 Git 上游");
      const origin = checkout ? parseGithubRepo(await git(root, "remote", "get-url", "origin").catch(() => "")) : null;
      const releaseRepo = requestedRepo ?? upstreamRepo ?? origin;
      if (releaseRepo) return this.checkRelease(releaseRepo, Boolean(checkout));
      return this.setStatus({ state: "idle", checkedAtMs: Date.now(), message: "请配置 GitHub 仓库或 Git 上游" });
    });
  }

  applyUpdate(): Promise<UpdateStatus> {
    if (this.status.state === "applied_restart_required") return Promise.resolve(this.status);
    return this.run(async () => {
      const plan = this.plan;
      if (!plan) throw new Error("请先检查可应用的更新");
      if (plan.mode === "git") await this.applyGit(plan);
      else await this.stageRelease(plan);
      this.progress("done", 100, "更新已准备完成");
      return this.setStatus({ state: "applied_restart_required", canApply: false, message: "更新已就绪，重启应用即可使用" });
    });
  }

  async scheduleExit(relaunch: boolean): Promise<boolean> {
    if (this.pending && (relaunch || this.status.state !== "checking")) throw new Error("请等待更新操作完成后再退出");
    if (!this.staged) return false;
    if (this.restartScheduled) return true;
    this.restartScheduled = true;
    try {
      const { workspace, staged } = this.staged;
      const { root, helperPath, executable, args } = this.options;
      const target = await realpath(root);
      const helper = path.join(workspace, "applyStaged.mjs");
      const manifest = path.join(workspace, "update.json");
      const node = await this.findNode(workspace);
      await writeFile(helper, await readFile(helperPath), { mode: 0o600 });
      await writeFile(manifest, JSON.stringify({ target, staged, executable, args, relaunch, pid: process.pid }), { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(node.executable, [helper, "--apply-staged", manifest], {
          detached: true, stdio: "ignore", windowsHide: true, cwd: workspace, env: node.env
        });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      return true;
    } catch (error) {
      this.restartScheduled = false;
      this.setStatus({ error: error instanceof Error ? error.message : String(error), message: "启动更新安装程序失败，可重试" });
      throw error;
    }
  }

  private async findNode(workspace: string): Promise<{ executable: string; env: NodeJS.ProcessEnv }> {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const root = await realpath(this.options.root);
    const external = await gitExec("node", ["-p", "process.execPath"], { env, windowsHide: true, timeout: 5000 })
      .then(({ stdout }) => realpath(stdout.trim())).catch(() => null);
    if (external && !within(root, external)) return { executable: external, env };
    const current = await realpath(process.execPath);
    if (!within(root, current)) {
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
      return { executable: current, env };
    }
    if (process.platform === "win32" && process.versions.electron) {
      // A copy outside the installation keeps the runner from locking the directory during the swap.
      const runtime = path.join(workspace, "runtime");
      const source = path.dirname(current);
      await mkdir(runtime, { recursive: true });
      for (const file of await readdir(source, { withFileTypes: true })) {
        if (file.isFile() && (file.name === path.basename(current) || /\.(dll|bin|dat|pak|manifest)$/i.test(file.name))) {
          await copyFile(path.join(source, file.name), path.join(runtime, file.name));
        }
      }
      const executable = path.join(runtime, path.basename(current));
      env.ELECTRON_RUN_AS_NODE = "1";
      const probe = await gitExec(executable, ["-p", "process.versions.node"], { cwd: runtime, env, windowsHide: true, timeout: 5000 });
      if (/^\d+\.\d+\.\d+$/.test(probe.stdout.trim())) return { executable, env };
    }
    throw new Error("安装更新需要安装目录之外可用的 Node.js");
  }

  private run(operation: () => Promise<UpdateStatus>): Promise<UpdateStatus> {
    this.pending ??= operation().catch(error => {
      const detail = error instanceof Error ? error.message : String(error);
      this.progress("error", 0, detail);
      return this.setStatus({ state: "error", canApply: false, checkedAtMs: this.status.checkedAtMs ?? Date.now(),
        message: "更新操作失败", error: detail });
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async checkGit(branch: string, upstream: string, remote: string, repo: string): Promise<UpdateStatus> {
    this.setStatus({ mode: "git", repo });
    this.progress("fetching", 10, "正在获取 Git 上游");
    const root = this.options.root;
    await git(root, "fetch", "--no-recurse-submodules", "--", remote);
    const compare = await git(root, "rev-list", "--left-right", "--count", "HEAD..." + upstream);
    const [ahead, behind] = compare.split(/\s+/).map(Number);
    if (!behind) return this.setStatus({ state: "up_to_date", checkedAtMs: Date.now(), message: "当前分支已包含上游更新" });
    const commit = await git(root, "rev-parse", "--verify", upstream + "^{commit}");
    const latestVersion = await git(root, "show", commit + ":package.json")
      .then(data => {
        const version: unknown = JSON.parse(data).version;
        return typeof version === "string" ? version : commit.slice(0, 12);
      }).catch(() => commit.slice(0, 12));
    const clean = !await git(root, "status", "--porcelain", "--untracked-files=normal");
    if (ahead === 0) this.plan = { mode: "git", branch, upstream, commit };
    return this.setStatus({ state: "available", latestVersion, checkedAtMs: Date.now(), canApply: ahead === 0 && clean,
      message: ahead ? "当前分支和上游已分叉" : !clean ? "工作树有未提交改动，请先处理" : "上游有可快进的更新" });
  }

  private async checkRelease(repo: string, checkout: boolean): Promise<UpdateStatus> {
    this.setStatus({ mode: "release", repo });
    this.progress("fetching", 10, "正在查询 GitHub Release");
    const response = await fetch("https://api.github.com/repos/" + repo + "/releases/latest", {
      headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error("无法获取 GitHub Release（HTTP " + response.status + "）");
    const release = await response.json() as { tag_name: string; body?: string | null; assets?: ReleaseAsset[] };
    const { tag_name: version, assets = [] } = release;
    const result = { latestVersion: version, checkedAtMs: Date.now(), releaseNotes: (release.body ?? "")
      .split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 30) };
    if (compareSemver(version, this.options.currentVersion) <= 0) {
      return this.setStatus({ ...result, state: "up_to_date", message: "当前版本已是最新版本" });
    }
    const asset = selectAsset(assets);
    const checksumAsset = asset && (assets.find(item => item.name.toLowerCase() === asset.name.toLowerCase() + ".sha256")
      ?? assets.find(item => /^(?:sha256sums(?:\.txt)?|checksums\.txt)$/i.test(item.name)));
    const hasChecksum = asset && (/^sha256:[\da-f]{64}$/i.test(asset.digest ?? "") || checksumAsset);
    if (asset && hasChecksum && !checkout) this.plan = { mode: "release", repo, asset, checksumAsset, version };
    return this.setStatus({ ...result, state: "available", canApply: Boolean(this.plan),
      message: checkout ? "当前是 Git 检出目录，请用 Git 模式更新"
        : hasChecksum ? "有可校验的 GitHub Release 更新" : "当前平台缺少带 SHA-256 校验信息的发布 ZIP" });
  }

  private async applyGit(plan: GitPlan): Promise<void> {
    const { root } = this.options;
    if (this.mergedGit !== plan) {
      if (await git(root, "status", "--porcelain", "--untracked-files=normal")) throw new Error("工作树有未提交改动");
      if (await git(root, "symbolic-ref", "--short", "HEAD") !== plan.branch
        || await git(root, "rev-parse", "--verify", "@{upstream}^{commit}") !== plan.commit
        || await git(root, "rev-parse", "--symbolic-full-name", "@{upstream}") !== plan.upstream) {
        throw new Error("当前分支或上游已变化，请重新检查");
      }
      this.setStatus({ state: "applying", canApply: false, message: "正在快进应用 Git 更新" });
      this.progress("applying", 65, "正在快进 Git 分支");
      await git(root, "-c", "submodule.recurse=false", "merge", "--ff-only", "--no-overwrite-ignore", "--", plan.commit);
      this.mergedGit = plan;
    }
    if (await isFile(path.join(root, "scripts", "build.mjs"))) {
      this.progress("applying", 85, "正在构建新版应用");
      const env = { ...process.env };
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
      await gitExec(process.execPath, ["scripts/build.mjs"], { cwd: root, env, windowsHide: true, timeout: 120_000 });
    }
  }

  private async stageRelease(plan: ReleasePlan): Promise<void> {
    const root = await realpath(this.options.root);
    if (await lstat(path.join(root, ".git")).then(() => true, () => false)) throw new Error("Git 检出目录请使用 Git 更新模式");
    this.setStatus({ state: "downloading", canApply: false, message: "正在下载发布 ZIP" });
    this.progress("downloading", 20, "正在下载发布 ZIP");
    const zip = await assetBytes(plan.asset, plan.repo, maxDownload);
    this.setStatus({ state: "verifying", message: "正在核验 SHA-256" });
    this.progress("verifying", 55, "正在核验 SHA-256");
    let expected = plan.asset.digest ?? "";
    if (!/^sha256:[\da-f]{64}$/i.test(expected) && plan.checksumAsset) {
      const contents = await assetBytes(plan.checksumAsset, plan.repo, 128 * 1024);
      expected = assetChecksum(plan.asset, plan.checksumAsset.name, contents.toString("utf8"));
    }
    if (!verifySha256(zip, expected)) throw new Error("发布 ZIP 的 SHA-256 校验失败");
    this.setStatus({ state: "applying", message: "正在暂存更新" });
    this.progress("staging", 75, "正在解压到安装目录同盘的暂存区");
    const workspace = await mkdtemp(path.join(path.dirname(root), ".codex-dashboard-update-"));
    const extracted = path.join(workspace, "extracted");
    try {
      await extractReleaseArchive(zip, extracted);
      const entries = await readdir(extracted, { withFileTypes: true });
      let staged = extracted;
      if (!await this.hasApp(staged, plan.version)) {
        const top = entries.length === 1 ? entries[0] : undefined;
        if (!top?.isDirectory()) throw new Error("发布 ZIP 中缺少完整应用");
        staged = path.join(extracted, top.name);
        if (!await this.hasApp(staged, plan.version)) throw new Error("发布 ZIP 中缺少完整应用或版本不匹配");
      }
      this.staged = { workspace, staged };
    } catch (error) {
      await rm(workspace, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  private async hasApp(dir: string, version: string): Promise<boolean> {
    if (!await isDirectoryEntry(dir)) return false;
    const executable = path.relative(this.options.root, this.options.executable);
    const localExecutable = !path.isAbsolute(executable) && within(dir, path.resolve(dir, executable));
    if (localExecutable && !await isFile(path.join(dir, executable))) return false;
    if (this.options.packaged) {
      return localExecutable
        && (await isFile(path.join(dir, "resources", "app.asar"))
          || await isFile(path.join(dir, "resources", "app", "package.json")));
    }
    try {
      const metadata = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
      return metadata.name === "codex-dashboard" && compareSemver(metadata.version, version) === 0
        && await isFile(path.join(dir, "dist", "overlay", "main.mjs"))
        && await isFile(path.join(dir, "dist", "overlay", "preload.cjs"))
        && await isFile(path.join(dir, "dist", "ui", "index.html"))
        && await isFile(path.join(dir, "dist", "updater", "applyStaged.mjs"));
    } catch {
      return false;
    }
  }

  private setStatus(patch: Partial<UpdateStatus>): UpdateStatus {
    return this.publish({ ...this.status, ...patch });
  }

  private publish(status: UpdateStatus): UpdateStatus {
    this.status = status;
    this.options.onStatus?.(status);
    return status;
  }

  private progress(stage: UpdateProgress["stage"], percent: number, message: string): void {
    this.options.onProgress?.({ stage, percent, message });
  }
}
