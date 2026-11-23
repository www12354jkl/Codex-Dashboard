import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import { DEFAULT_OVERLAY_CONFIG } from "../shared/types.js";
import {
  compareSemver, extractReleaseArchive, GithubUpdater, parseGithubRepo,
  stageAndSwapDirectory, validateArchiveEntryPath, verifySha256
} from "../updater/githubUpdater.js";

const exec = promisify(execFile);

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hud-update-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("GitHub slugs and semantic precedence", () => {
  assert.equal(parseGithubRepo(" https://github.com/OpenAI/codex.git/ "), "OpenAI/codex");
  assert.equal(parseGithubRepo("git@github.com:owner/tool.git"), "owner/tool");
  assert.equal(parseGithubRepo("ssh://git@github.com/owner/tool"), "owner/tool");
  assert.equal(parseGithubRepo("owner/tool"), "owner/tool");
  for (const value of ["https://github.com.evil.invalid/owner/tool", "https://github.com/owner/tool/issues",
    "http://github.com/owner/tool", "https://github.com/owner/tool?x=1", "owner/..", "owner/%2f"]) {
    assert.equal(parseGithubRepo(value), null, value);
  }
  assert.equal(compareSemver("v2.10.0", "2.9.99"), 1);
  assert.equal(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.throws(() => compareSemver("1.0.0-rc.01", "1.0.0"));
});

test("checksums and cross-platform ZIP path validation", () => {
  const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
  assert.equal(verifySha256(Buffer.from("abc"), "sha256:" + digest.toUpperCase()), true);
  assert.equal(verifySha256(Buffer.from("abd"), digest), false);
  assert.equal(verifySha256(Buffer.from("abc"), "abc"), false);
  assert.equal(validateArchiveEntryPath("dist/ui/index.html"), true);
  assert.equal(validateArchiveEntryPath("release/"), true);
  for (const value of ["", "/etc/passwd", "C:/Windows/file", "C:file", "\\\\server\\share",
    "safe\\..\\file", "safe/../file", "safe/./file", "file:name", "safe/null\0", "safe/CON.txt", "file.",
    "file ", "safe//file", ".git/config", ".codex-dashboard/config.json"]) {
    assert.equal(validateArchiveEntryPath(value), false, value);
  }
});

function storedZip(name: string, contents: string, mode = 0o100644): Buffer {
  const filename = Buffer.from(name);
  const bytes = Buffer.from(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(bytes), 14);
  local.writeUInt32LE(bytes.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50);
  directory.writeUInt16LE(0x0314, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt32LE(crc32(bytes), 16);
  directory.writeUInt32LE(bytes.length, 20);
  directory.writeUInt32LE(bytes.length, 24);
  directory.writeUInt16LE(filename.length, 28);
  directory.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + bytes.length, 16);
  return Buffer.concat([local, filename, bytes, directory, filename, end]);
}

test("extracts regular files and rejects traversal and links before writing", async t => {
  const dir = await fixture(t);
  const destination = path.join(dir, "release");
  await assert.rejects(extractReleaseArchive(storedZip("../outside", "bad"), destination), /路径/);
  await assert.rejects(extractReleaseArchive(storedZip("link", "outside", 0o120777), destination));
  assert.deepEqual(await readdir(dir), []);
  await extractReleaseArchive(storedZip("dist/index.html", "valid"), destination);
  assert.equal(await readFile(path.join(destination, "dist", "index.html"), "utf8"), "valid");
});

test("swaps a staged directory and rolls back when activation fails", async t => {
  const dir = await fixture(t);
  const root = path.join(dir, "current");
  const staged = path.join(dir, "staged");
  await mkdir(root);
  await mkdir(staged);
  await writeFile(path.join(root, "file"), "old");
  await writeFile(path.join(staged, "file"), "new");
  await assert.rejects(stageAndSwapDirectory(root, staged, async () => {
    assert.equal(await readFile(path.join(root, "file"), "utf8"), "new");
    throw new Error("simulated activation failure");
  }), /activation failure/);
  assert.equal(await readFile(path.join(root, "file"), "utf8"), "old");
  assert.equal(await readFile(path.join(staged, "file"), "utf8"), "new");
  await stageAndSwapDirectory(root, staged);
  assert.equal(await readFile(path.join(root, "file"), "utf8"), "new");
  assert.deepEqual(await readdir(dir), ["current"]);
});

test("Git mode fast-forwards only a clean worktree", async t => {
  if (!await exec("git", ["--version"]).then(() => true, () => false)) return t.skip("Git unavailable");
  const dir = await fixture(t);
  const upstream = path.join(dir, "upstream");
  const root = path.join(dir, "checkout");
  await mkdir(upstream);
  const git = (directory: string, ...args: string[]) => exec(
    "git", ["-c", "user.name=Updater Test", "-c", "user.email=updater@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd: directory, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
  );
  const manifest = path.join(upstream, "package.json");
  await git(upstream, "init", "-b", "main");
  await writeFile(manifest, JSON.stringify({ version: "1.0.0" }));
  await git(upstream, "add", "package.json");
  await git(upstream, "commit", "-m", "initial");
  await git(dir, "clone", upstream, root);
  await writeFile(manifest, JSON.stringify({ version: "1.0.1" }));
  await git(upstream, "commit", "-am", "update");

  const updater = new GithubUpdater({ root, currentVersion: "1.0.0", executable: process.execPath, helperPath: "", args: [] });
  const available = await updater.checkForUpdates({ ...DEFAULT_OVERLAY_CONFIG, repo: "" });
  assert.equal(available.mode, "git", available.error);
  assert.equal(available.latestVersion, "1.0.1");
  assert.equal(available.canApply, true, available.error);
  const localManifest = path.join(root, "package.json");
  await writeFile(localManifest, "local change");
  assert.equal((await updater.applyUpdate()).state, "error");
  assert.equal(await readFile(localManifest, "utf8"), "local change");
  await git(root, "restore", "package.json");
  const applied = await updater.applyUpdate();
  assert.equal(applied.state, "applied_restart_required", applied.error);
  assert.deepEqual(JSON.parse(await readFile(localManifest, "utf8")), { version: "1.0.1" });
});

