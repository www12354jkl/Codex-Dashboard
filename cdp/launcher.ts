import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CodexCdpHost, probeCodexCdp } from "./host.js";
import { CDP_DEFAULT_PORT, CDP_HOST } from "./protocol.js";

const run = promisify(execFile);
const quitPrompt =
  "检测到 Codex Desktop 仍在后台运行（点窗口右上角 X 通常只会收进右下角系统托盘）。请右键系统托盘中的 Codex 图标选择「退出 / Quit」彻底关闭后，再重新执行 pnpm run start:cdp。";
const windowsCodex = String.raw`
$ErrorActionPreference = 'Stop'
$procs = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" -ErrorAction SilentlyContinue)
foreach ($p in $procs) {
  if ($p.ExecutablePath -and ($p.ExecutablePath -match '[\\/]OpenAI\.Codex_[^\\/]+[\\/]app[\\/]ChatGPT\.exe$')) {
    'RUNNING'
    exit
  }
}
$package = Get-AppxPackage OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if ($package) {
  if ($package.PackageFamilyName) {
    $aliasDir = Join-Path $env:LOCALAPPDATA ('Microsoft\WindowsApps\' + $package.PackageFamilyName)
    foreach ($aliasName in @('chatgpt-desktop.exe', 'codex.exe', 'ChatGPT.exe')) {
      $aliasExe = Join-Path $aliasDir $aliasName
      if (Test-Path -LiteralPath $aliasExe -PathType Leaf) {
        $aliasExe
        exit
      }
    }
  }
  if ($package.InstallLocation) {
    $exe = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
      $exe
      exit
    }
  }
}
`;

function parseArgs(args: string[]): { port: number; noLaunch: boolean } {
  let portText = process.env.CODEX_CDP_PORT ?? String(CDP_DEFAULT_PORT);
  let noLaunch = false;
  for (const arg of args) {
    if (arg === "--no-launch") noLaunch = true;
    else if (arg.startsWith("--port=")) portText = arg.slice("--port=".length);
    else throw new Error(`未知参数 ${arg}，可用参数为 --port=<n> 和 --no-launch`);
  }
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error("CDP 端口必须在 1–65535 之间");
  return { port, noLaunch };
}

async function launchWindowsCodex(port: number, signal: AbortSignal): Promise<void> {
  try {
    const { stdout } = await run("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" + windowsCodex
    ], { encoding: "utf8", timeout: 10_000, signal, windowsHide: true });
    const executable = stdout.trim();
    if (executable === "RUNNING") {
      console.log(quitPrompt);
      return;
    }
    if (!path.win32.isAbsolute(executable)) {
      console.log("未找到 OpenAI.Codex 安装。请手动打开带调试端口的 Codex Desktop。");
      return;
    }
    if (signal.aborted) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, ["--remote-debugging-port=" + port], { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
    console.log(`已启动 Codex Desktop，调试端口为 ${port}。`);
  } catch (error) {
    if (!signal.aborted) console.error("无法自动启动 Codex Desktop，请手动打开带调试端口的 Codex Desktop。", error);
  }
}

async function main(): Promise<void> {
  const { port, noLaunch } = parseArgs(process.argv.slice(2));
  const endpoint = `http://${CDP_HOST}:${port}/json/list`;
  const host = new CodexCdpHost({ port });
  const startup = new AbortController();
  const stop = () => {
    startup.abort();
    void host.stop().catch(error => {
      console.error("退出 Codex CDP 模式失败", error);
      process.exitCode = 1;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const probe = await probeCodexCdp(port, startup.signal);
    if (startup.signal.aborted) return;
    // Load the dashboard before attempting to launch Codex, so build/config errors surface first.
    await host.start();
    if (startup.signal.aborted) return;
    if (probe?.targets?.length) {
      console.log(`已发现 ${probe.targets.length} 个 Codex Desktop 页面，正在附着。`);
    } else {
      if (!probe && !noLaunch && process.platform === "win32") await launchWindowsCodex(port, startup.signal);
      if (!startup.signal.aborted) console.log(`正在等待 ${endpoint} 上的 Codex Desktop 页面，按 Ctrl+C 退出。`);
    }
  } catch (error) {
    if (!startup.signal.aborted) {
      stop();
      throw error;
    }
  }
}

void main().catch(error => {
  console.error("无法启动 Codex CDP 模式", error);
  process.exitCode = 1;
});
