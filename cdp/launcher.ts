import {
  CODEX_ALREADY_RUNNING_PROMPT,
  CodexExitWatchdog,
  isCdpEndpointAlive,
  launchWindowsCodexForCdp
} from "./codexApp.js";
import { CodexCdpHost, probeCodexCdp } from "./host.js";
import { CDP_DEFAULT_PORT, CDP_HOST } from "./protocol.js";

function parseArgs(args: string[]): { port: number; noLaunch: boolean; autoExit: boolean } {
  let portText = process.env.CODEX_CDP_PORT ?? String(CDP_DEFAULT_PORT);
  let noLaunch = false;
  let autoExit = false;
  for (const arg of args) {
    if (arg === "--no-launch") noLaunch = true;
    else if (arg === "--auto-exit") autoExit = true;
    else if (arg.startsWith("--port=")) portText = arg.slice("--port=".length);
    else throw new Error(`未知参数 ${arg}，可用参数为 --port=<n>、--no-launch 和 --auto-exit`);
  }
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) throw new Error("CDP 端口必须在 1–65535 之间");
  return { port, noLaunch, autoExit };
}

async function main(): Promise<void> {
  const { port, noLaunch, autoExit } = parseArgs(process.argv.slice(2));
  const endpoint = `http://${CDP_HOST}:${port}/json/list`;
  const host = new CodexCdpHost({ port });
  const startup = new AbortController();
  let watchdog: CodexExitWatchdog | undefined;

  const stop = () => {
    startup.abort();
    watchdog?.stop();
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
      if (!probe && !noLaunch && process.platform === "win32") {
        try {
          const launch = await launchWindowsCodexForCdp(port, startup.signal);
          if (launch.status === "launched") {
            console.log(`已启动 Codex Desktop，调试端口为 ${port}。`);
          } else if (launch.status === "already_running") {
            console.log(CODEX_ALREADY_RUNNING_PROMPT);
          } else if (!startup.signal.aborted) {
            console.log("未找到 OpenAI.Codex 安装。请手动打开带调试端口的 Codex Desktop。");
          }
        } catch (error) {
          if (!startup.signal.aborted) {
            console.error("无法自动启动 Codex Desktop，请手动打开带调试端口的 Codex Desktop。", error);
          }
        }
      }
      if (!startup.signal.aborted) console.log(`正在等待 ${endpoint} 上的 Codex Desktop 页面，按 Ctrl+C 退出。`);
    }

    if (autoExit && !startup.signal.aborted) {
      watchdog = new CodexExitWatchdog({
        probe: signal => isCdpEndpointAlive(port, signal),
        initiallyAlive: Boolean(probe),
        onExited: () => {
          console.log("检测到 Codex Desktop 已退出，正在自动关闭仪表盘。");
          stop();
        }
      });
      watchdog.start();
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
