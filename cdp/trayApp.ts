import { app, dialog, Menu, nativeImage, Notification, Tray } from "electron";
import {
  CODEX_ALREADY_RUNNING_PROMPT,
  CodexExitWatchdog,
  findWindowsCodexApp,
  isCdpEndpointAlive,
  launchWindowsCodexForCdp,
  spawnCodexWithCdp
} from "./codexApp.js";
import { CodexCdpHost, type CodexCdpHostState } from "./host.js";
import { CDP_DEFAULT_PORT } from "./protocol.js";

function parseArgs(args: string[]): { port: number; noLaunch: boolean; autoExit: boolean } {
  let portText = process.env.CODEX_CDP_PORT ?? String(CDP_DEFAULT_PORT);
  let noLaunch = false;
  let autoExit = true;
  for (const arg of args) {
    if (arg === "--no-launch") noLaunch = true;
    else if (arg === "--no-auto-exit") autoExit = false;
    else if (arg === "--auto-exit") autoExit = true;
    else if (arg.startsWith("--port=")) portText = arg.slice("--port=".length);
  }
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || port < 1 || port > 65535) {
    return { port: CDP_DEFAULT_PORT, noLaunch, autoExit };
  }
  return { port, noLaunch, autoExit };
}

function createTrayIcon(): Electron.NativeImage {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  const paint = (x: number, y: number, r: number, g: number, b: number, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const offset = (y * size + x) * 4;
    bitmap[offset] = b;
    bitmap[offset + 1] = g;
    bitmap[offset + 2] = r;
    bitmap[offset + 3] = a;
  };

  // Rounded dark square badge with crisp telemetry bars
  for (let y = 1; y <= 14; y++) {
    for (let x = 1; x <= 14; x++) {
      const corner = (x === 1 || x === 14) && (y === 1 || y === 14);
      if (!corner) paint(x, y, 28, 30, 38, 255);
    }
  }
  // 3 rising telemetry bars (blue, emerald, white)
  const bars: Array<[number, number, [number, number, number]]> = [
    [4, 9, [96, 165, 250]],
    [7, 6, [73, 201, 140]],
    [10, 4, [237, 237, 240]]
  ];
  for (const [bx, top, [r, g, b]] of bars) {
    for (let y = top; y <= 12; y++) {
      paint(bx, y, r, g, b);
      paint(bx + 1, y, r, g, b);
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

const options = parseArgs(process.argv.slice(1));
app.setName("Codex Dashboard (CDP)");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let host: CodexCdpHost | undefined;
  let tray: Tray | undefined;
  let watchdog: CodexExitWatchdog | undefined;
  let codexExecutable: string | null = null;
  let autoExitEnabled = options.autoExit;
  let currentState: CodexCdpHostState = { attachedPages: 0, updateStatus: null };
  let shuttingDown = false;
  const startup = new AbortController();

  // Headless Electron app (no BrowserWindows) — stay alive until Codex exits or user quits from tray
  app.on("window-all-closed", () => {});

  const focusOrRelaunchCodex = async (): Promise<void> => {
    try {
      if (!codexExecutable) {
        const info = await findWindowsCodexApp();
        codexExecutable = info.executable;
      }
      if (codexExecutable) {
        await spawnCodexWithCdp(codexExecutable, options.port);
      }
    } catch {
      // Ignore focus errors when Codex is mid-transition
    }
  };

  app.on("second-instance", () => {
    if (!shuttingDown) void focusOrRelaunchCodex();
  });

  const updateTrayMenu = (): void => {
    if (!tray) return;
    const count = currentState.attachedPages;
    const statusLabel =
      count > 0 ? `已挂载 ${count} 个 Codex 窗口` : "正在等待 Codex Desktop…";
    tray.setToolTip(`Codex Dashboard (CDP) · ${statusLabel}`);

    const updateState = currentState.updateStatus?.state;
    const updateLabel =
      updateState === "available"
        ? `发现新版本 (${currentState.updateStatus?.latestVersion ?? "更新"})`
        : updateState === "checking"
          ? "正在检查更新…"
          : "检查更新";

    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Codex Dashboard · ${statusLabel}`, enabled: false },
        { type: "separator" },
        {
          label: "打开 / 聚焦 Codex",
          click: () => {
            void focusOrRelaunchCodex();
          }
        },
        {
          label: "热重载仪表盘",
          click: () => {
            void host?.reloadWidgets();
          }
        },
        {
          label: updateLabel,
          enabled: updateState !== "checking",
          click: () => {
            void host?.checkForUpdatesNow().then((res) => {
              if (!res || !Notification.isSupported()) return;
              new Notification({
                title: "Codex Dashboard 更新检查",
                body: res.error ? `${res.message} (${res.error})` : res.message
              }).show();
            });
          }
        },
        { type: "separator" },
        {
          label: "随 Codex 自动退出",
          type: "checkbox",
          checked: autoExitEnabled,
          click: (item) => {
            autoExitEnabled = item.checked;
            watchdog?.setEnabled(autoExitEnabled);
          }
        },
        {
          label: "退出仪表盘",
          click: () => {
            void shutdown();
          }
        }
      ])
    );
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    startup.abort();
    watchdog?.stop();
    try {
      await host?.stop();
    } catch {
      // Ignore shutdown errors
    } finally {
      tray?.destroy();
      tray = undefined;
      app.quit();
    }
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });

  void app.whenReady().then(async () => {
    tray = new Tray(createTrayIcon());
    updateTrayMenu();
    tray.on("click", () => {
      void focusOrRelaunchCodex();
    });

    host = new CodexCdpHost({
      port: options.port,
      onStateChange: (state) => {
        currentState = state;
        updateTrayMenu();
      }
    });

    try {
      const cdpAlreadyAlive = await isCdpEndpointAlive(options.port, startup.signal);
      if (startup.signal.aborted) return;

      await host.start();
      if (startup.signal.aborted) return;

      if (!cdpAlreadyAlive && !options.noLaunch && process.platform === "win32") {
        const launch = await launchWindowsCodexForCdp(options.port, startup.signal);
        if (startup.signal.aborted) return;
        if (launch.status === "launched") {
          codexExecutable = launch.executable;
        } else if (launch.status === "already_running") {
          codexExecutable = launch.executable;
          await dialog.showMessageBox({
            type: "info",
            title: "Codex Dashboard",
            message: "检测到 Codex Desktop 已在后台运行（未开启调试口）",
            detail: CODEX_ALREADY_RUNNING_PROMPT,
            buttons: ["知道了"]
          });
          await shutdown();
          return;
        } else {
          await dialog.showMessageBox({
            type: "warning",
            title: "Codex Dashboard",
            message: "未找到已安装的 Codex Desktop",
            detail: "请先从 Microsoft Store 安装 OpenAI ChatGPT / Codex Desktop 后再运行此快捷方式。",
            buttons: ["确定"]
          });
          await shutdown();
          return;
        }
      } else if (cdpAlreadyAlive && process.platform === "win32") {
        // Already running with CDP (e.g. minimized in tray): focus Codex window immediately
        void focusOrRelaunchCodex();
      }

      watchdog = new CodexExitWatchdog({
        probe: (signal) => isCdpEndpointAlive(options.port, signal),
        initiallyAlive: cdpAlreadyAlive,
        intervalMs: 1_500,
        missThreshold: 2,
        startupTimeoutMs: 60_000,
        onExited: () => {
          void shutdown();
        },
        onStartupTimeout: () => {
          void shutdown();
        }
      });
      watchdog.setEnabled(autoExitEnabled);
      watchdog.start();
    } catch (error) {
      await dialog.showMessageBox({
        type: "error",
        title: "Codex Dashboard 启动失败",
        message: "无法启动 CDP 仪表盘宿主",
        detail: error instanceof Error ? error.message : String(error),
        buttons: ["确定"]
      });
      await shutdown();
    }
  });
}
