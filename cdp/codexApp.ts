import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CDP_HOST } from "./protocol.js";

const run = promisify(execFile);

export const CODEX_ALREADY_RUNNING_PROMPT =
  "检测到 Codex Desktop 仍在后台运行（点窗口右上角 X 通常只会收进右下角系统托盘）。请右键系统托盘中的 Codex 图标选择「退出 / Quit」彻底关闭后，再重新启动。";

const WINDOWS_CODEX_PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$running = $false
$procs = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)
foreach ($p in $procs) {
  if ($p.ExecutablePath -and ($p.ExecutablePath -match '[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$')) {
    $running = $true
    break
  }
}
$executable = ''
$package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if ($package) {
  if ($package.PackageFamilyName) {
    $aliasDir = Join-Path $env:LOCALAPPDATA ('Microsoft\WindowsApps\' + $package.PackageFamilyName)
    foreach ($aliasName in @('chatgpt-desktop.exe', 'codex.exe', 'ChatGPT.exe')) {
      $aliasExe = Join-Path $aliasDir $aliasName
      if (Test-Path -LiteralPath $aliasExe -PathType Leaf) {
        $executable = $aliasExe
        break
      }
    }
  }
  if (-not $executable -and $package.InstallLocation) {
    $exe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
      $executable = $exe
    }
  }
}
@{ running = $running; executable = $executable } | ConvertTo-Json -Compress
`;

export interface WindowsCodexAppInfo {
  running: boolean;
  executable: string | null;
}

export async function findWindowsCodexApp(signal?: AbortSignal): Promise<WindowsCodexAppInfo> {
  if (process.platform !== "win32") return { running: false, executable: null };
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" + WINDOWS_CODEX_PROBE_SCRIPT
    ],
    { encoding: "utf8", timeout: 10_000, signal, windowsHide: true }
  );
  const raw = stdout.trim();
  if (!raw) return { running: false, executable: null };
  const parsed = JSON.parse(raw) as { running?: unknown; executable?: unknown };
  const executable =
    typeof parsed.executable === "string" && path.win32.isAbsolute(parsed.executable)
      ? parsed.executable
      : null;
  return { running: parsed.running === true, executable };
}

export async function spawnCodexWithCdp(executable: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [`--remote-debugging-port=${port}`], {
      detached: true,
      stdio: "ignore",
      // Must be false for GUI executables: windowsHide:true sets SW_HIDE and causes Electron/Codex to boot into the tray.
      windowsHide: false
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export type LaunchCodexResult =
  | { status: "launched"; executable: string }
  | { status: "already_running"; executable: string | null }
  | { status: "not_found" };

export async function launchWindowsCodexForCdp(port: number, signal?: AbortSignal): Promise<LaunchCodexResult> {
  const info = await findWindowsCodexApp(signal);
  if (signal?.aborted) return { status: "not_found" };
  if (info.running) return { status: "already_running", executable: info.executable };
  if (!info.executable) return { status: "not_found" };
  await spawnCodexWithCdp(info.executable, port);
  return { status: "launched", executable: info.executable };
}

/**
 * Checks whether the Codex Electron main-process CDP server is still alive.
 * Uses /json/version rather than /json/list because /json/version stays 200 OK even when
 * Codex minimizes its window to the System Tray, and refuses connections only when Codex truly exits.
 */
export async function isCdpEndpointAlive(port: number, signal?: AbortSignal): Promise<boolean> {
  const timeout = AbortSignal.timeout(1_500);
  try {
    const response = await fetch(`http://${CDP_HOST}:${port}/json/version`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "manual"
    });
    await response.body?.cancel().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

export interface CodexExitWatchdogOptions {
  /** Async liveness check returning true while Codex's CDP server responds. */
  probe: (signal: AbortSignal) => Promise<boolean>;
  /** Called once Codex has been seen alive and subsequently exited cleanly. */
  onExited: () => void;
  /** Optional callback if Codex never opened CDP within startupTimeoutMs. */
  onStartupTimeout?: () => void;
  /** Polling interval in milliseconds (default 1500ms). */
  intervalMs?: number;
  /** Number of consecutive failed probes after seenAlive required before firing onExited (default 2). */
  missThreshold?: number;
  /** Maximum time to wait for initial CDP readiness before giving up (default 0 = wait indefinitely). */
  startupTimeoutMs?: number;
  /** Start with seenAlive = true when CDP was already reachable before watchdog started. */
  initiallyAlive?: boolean;
}

export class CodexExitWatchdog {
  private readonly intervalMs: number;
  private readonly missThreshold: number;
  private readonly startupTimeoutMs: number;
  private readonly abort = new AbortController();
  private seenAlive: boolean;
  private missed = 0;
  private enabled = true;
  private polling = false;
  private stopped = false;
  private startedAt = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: CodexExitWatchdogOptions) {
    this.intervalMs = Math.max(50, options.intervalMs ?? 1_500);
    this.missThreshold = Math.max(1, options.missThreshold ?? 2);
    this.startupTimeoutMs = Math.max(0, options.startupTimeoutMs ?? 0);
    this.seenAlive = options.initiallyAlive === true;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.missed = 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  hasSeenAlive(): boolean {
    return this.seenAlive;
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      const alive = await this.options.probe(this.abort.signal).catch(() => false);
      if (this.stopped) return;
      if (alive) {
        this.seenAlive = true;
        this.missed = 0;
        return;
      }
      if (!this.enabled) return;
      if (this.seenAlive) {
        this.missed += 1;
        if (this.missed >= this.missThreshold) {
          this.stop();
          this.options.onExited();
        }
      } else if (this.startupTimeoutMs > 0 && Date.now() - this.startedAt >= this.startupTimeoutMs) {
        this.stop();
        this.options.onStartupTimeout?.();
      }
    } finally {
      this.polling = false;
    }
  }
}
