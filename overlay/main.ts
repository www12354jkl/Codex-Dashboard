import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelemetryCollectorService } from "../collector/service.js";
import { createInitialRuntimeState } from "../shared/mock.js";
import { IPC_CHANNELS, OFFICIAL_GITHUB_REPO, type HitRect, type OverlayConfig, type OverlayRuntimeState } from "../shared/types.js";
import { GithubUpdater } from "../updater/githubUpdater.js";
import { OverlayConfigStore } from "./configStore.js";
import { configureWindowsOverlayFrame, type CodexWindow, overlayPosition, WindowsWindowTracker } from "./winTracker.js";

function hitRectangles(value: unknown, width: number, height: number): HitRect[] {
  if (!Array.isArray(value)) return [];
  const rects: HitRect[] = [];
  for (const candidate of value.slice(0, 64)) {
    if (!candidate || typeof candidate !== "object") continue;
    const { x, y, width: w, height: h } = candidate as HitRect;
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
    const left = Math.max(0, Math.floor(x));
    const top = Math.max(0, Math.floor(y));
    const right = Math.min(width, Math.ceil(x + w));
    const bottom = Math.min(height, Math.ceil(y + h));
    if (right > left && bottom > top) rects.push({ x: left, y: top, width: right - left, height: bottom - top });
  }
  return rects;
}

function trayIcon(): Electron.NativeImage {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (let column = 0; column < 3; column++) {
    for (let y = 12; y > 8 - column * 2; y--) {
      for (let x = 2 + column * 4; x < 5 + column * 4; x++) {
        const offset = (y * size + x) * 4;
        bitmap.set([255, 168, 80, 255], offset);
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size });
}

async function initialize(): Promise<void> {
  const store = new OverlayConfigStore();
  let config = await store.load();
  nativeTheme.themeSource = config.theme;
  let runtime = createInitialRuntimeState();
  const dev = process.argv.includes("--dev");
  let standalone = dev;
  let userHidden = false;
  let rendererReady = false;
  let quitting = false;
  let exitScheduled = false;
  let lastCodexFocus = false;
  const tracker = new WindowsWindowTracker();
  let detected: CodexWindow | null = null;
  const collector = new TelemetryCollectorService();
  const size = { width: 620, height: 560 };
  let lastAppliedBounds: HitRect | null = null;
  let lastHitRects: HitRect[] = [];
  let mouseIgnored = false;
  let mouseHitTimer: ReturnType<typeof setInterval> | undefined;
  let tray: Tray | undefined;
  let lastToolTip = "";
  const win = new BrowserWindow({
    ...size,
    show: false,
    transparent: true,
    frame: false,
    thickFrame: false,
    roundedCorners: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: dev
    }
  });
  const overlayFrameReady = configureWindowsOverlayFrame(win.getNativeWindowHandle());
  setMouseIgnored(true);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  win.webContents.on("will-redirect", event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  win.webContents.session.setPermissionCheckHandler(() => false);

  function setMouseIgnored(ignore: boolean): void {
    if (mouseIgnored === ignore) return;
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
    mouseIgnored = ignore;
  }

  function stopMouseHitTesting(): void {
    clearInterval(mouseHitTimer);
    mouseHitTimer = undefined;
  }

  function updateMouseHit(): void {
    if (win.isDestroyed() || !win.isVisible()) {
      stopMouseHitTesting();
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const lx = cursor.x - bounds.x;
    const ly = cursor.y - bounds.y;
    const hit = lastHitRects.some(rect => lx >= rect.x && lx < rect.x + rect.width
      && ly >= rect.y && ly < rect.y + rect.height);
    setMouseIgnored(!hit);
  }

  win.on("show", () => {
    mouseHitTimer ??= setInterval(updateMouseHit, 40);
    updateMouseHit();
  });
  win.on("hide", () => {
    stopMouseHitTesting();
    if (!win.isDestroyed()) setMouseIgnored(true);
  });
  win.on("closed", stopMouseHitTesting);

  const send = (channel: string, value: unknown) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
  };
  const updater = new GithubUpdater({
    root: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
    currentVersion: app.getVersion(),
    helperPath: fileURLToPath(new URL("../updater/applyStaged.mjs", import.meta.url)),
    executable: process.execPath,
    args: process.argv.slice(1),
    packaged: app.isPackaged,
    onStatus: status => send(IPC_CHANNELS.ON_UPDATE_STATUS, status),
    onProgress: progress => send(IPC_CHANNELS.ON_UPDATE_PROGRESS, progress)
  });

  function setRuntime(next: OverlayRuntimeState): void {
    if (next.attachedToCodex === runtime.attachedToCodex && next.alignmentSource === runtime.alignmentSource
      && next.codexWindowTitle === runtime.codexWindowTitle) return;
    runtime = next;
    send(IPC_CHANNELS.ON_RUNTIME_STATE, next);
  }

  function setToolTip(text: string): void {
    if (!tray || text === lastToolTip) return;
    tray.setToolTip(text);
    lastToolTip = text;
  }

  function position(): void {
    if (quitting || win.isDestroyed()) return;
    const target = standalone ? null : detected;
    if (target && target.foregroundPid !== process.pid) lastCodexFocus = target.focused;
    if (!target) lastCodexFocus = false;
    if (userHidden) {
      if (win.isVisible()) win.hide();
      setRuntime({ ...runtime, alignmentSource: "hidden" });
      return;
    }
    const focused = target?.focused || (target?.foregroundPid === process.pid && lastCodexFocus);
    if (target && (target.minimized || (config.onlyWhenCodexFocused && !focused)
      || (config.hideOnApprovalDialog && target.approval))) {
      if (win.isVisible()) win.hide();
      setToolTip("Codex Dashboard（已自动隐藏）");
      setRuntime({ attachedToCodex: true, alignmentSource: "hidden", codexWindowTitle: target.title });
      return;
    }

    const tracked = target?.rect;
    if (!standalone && !tracked) {
      if (win.isVisible()) win.hide();
      setToolTip("Codex Dashboard（等待 Codex 窗口）");
      setRuntime({ attachedToCodex: false, alignmentSource: "hidden", codexWindowTitle: null });
      return;
    }
    const anchor = tracked ? screen.screenToDipRect(win, tracked) : screen.getPrimaryDisplay().workArea;
    const composerSlot = tracked && target?.composerSlot ? screen.screenToDipRect(win, target.composerSlot) : null;
    const { x, y, alignmentSource } = overlayPosition(anchor, size, config, { composerSlot, standalone: !tracked });
    if (!lastAppliedBounds || lastAppliedBounds.x !== x || lastAppliedBounds.y !== y) {
      const bounds = { x, y, ...size };
      win.setBounds(bounds);
      lastAppliedBounds = bounds;
      updateMouseHit();
    }
    setToolTip(tracked ? `Codex Dashboard（已吸附 · ${alignmentSource.toUpperCase()}）` : "Codex Dashboard（独立模式）");
    setRuntime({
      attachedToCodex: Boolean(tracked),
      alignmentSource,
      codexWindowTitle: tracked ? target?.title ?? null : null
    });
    if (rendererReady && !win.isVisible()) win.showInactive();
  }

  const refreshPosition = () => {
    try { position(); } catch (error) { console.error("HUD positioning failed", error); }
  };

  const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  function handle<Args extends unknown[]>(
    channel: string, callback: (...args: Args) => unknown
  ): void {
    ipcMain.handle(channel, (event, ...args: Args) => {
      if (!trusted(event)) throw new Error("Untrusted HUD IPC sender");
      return callback(...args);
    });
  }

  handle(IPC_CHANNELS.GET_SNAPSHOT, () => collector.getSnapshot());
  handle(IPC_CHANNELS.GET_CONFIG, () => {
    send(IPC_CHANNELS.ON_UPDATE_STATUS, updater.getStatus());
    return config;
  });
  handle(IPC_CHANNELS.UPDATE_CONFIG, async (patch: Partial<OverlayConfig>) => {
    const prevRepo = config.repo;
    const prevChannel = config.updateChannel;
    config = await store.update(patch);
    nativeTheme.themeSource = config.theme;
    if (config.repo !== prevRepo || config.updateChannel !== prevChannel) {
      updater.invalidatePlan(config.repo);
    }
    send(IPC_CHANNELS.ON_CONFIG, config);
    if (!standalone) tracker.start(config.hideOnApprovalDialog);
    refreshPosition();
    return config;
  });
  handle(IPC_CHANNELS.GET_RUNTIME_STATE, () => runtime);
  handle(IPC_CHANNELS.CHECK_UPDATES, (repo?: string) =>
    updater.checkForUpdates(config, typeof repo === "string" && repo.trim() ? repo : OFFICIAL_GITHUB_REPO));
  handle(IPC_CHANNELS.APPLY_UPDATE, () => updater.applyUpdate());
  async function requestExit(relaunch: boolean): Promise<void> {
    if (exitScheduled) return;
    exitScheduled = true;
    try {
      if (!await updater.scheduleExit(relaunch) && relaunch) app.relaunch();
      setImmediate(() => app.quit());
    } catch (error) {
      exitScheduled = false;
      throw error;
    }
  }
  handle(IPC_CHANNELS.RESTART_APP, () => requestExit(true));

  ipcMain.on(IPC_CHANNELS.REPORT_HIT_RECTS, (event, payload: unknown) => {
    if (win.isDestroyed() || !trusted(event)) return;
    const { width, height } = win.getContentBounds();
    lastHitRects = hitRectangles(payload, width, height);
    updateMouseHit();
  });
  screen.on("display-metrics-changed", refreshPosition);
  win.webContents.on("render-process-gone", () => {
    rendererReady = false;
    lastHitRects = [];
    if (win.isDestroyed()) return;
    setMouseIgnored(true);
    win.hide();
  });
  win.on("close", event => {
    if (!quitting) {
      event.preventDefault();
      toggleVisibility();
    }
  });

  tray = new Tray(trayIcon());
  setToolTip("Codex Dashboard");

  function toggleVisibility(): void {
    userHidden = !userHidden;
    if (userHidden) {
      win.hide();
      setRuntime({ ...runtime, alignmentSource: "hidden" });
    }
    updateTray();
    refreshPosition();
  }

  function updateTray(): void {
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: userHidden ? "显示浮窗" : "隐藏浮窗", click: toggleVisibility },
      { label: "独立模式", type: "checkbox", checked: standalone, enabled: !dev, click: item => {
        standalone = item.checked;
        if (standalone) {
          tracker.stop();
          detected = null;
        } else {
          tracker.start(config.hideOnApprovalDialog);
        }
        refreshPosition();
      } },
      { label: "检查更新", click: () => { void updater.checkForUpdates(config); } },
      { type: "separator" },
      { label: "退出", click: () => { void requestExit(false).catch(error => console.error("HUD exit failed", error)); } }
    ]));
  }
  updateTray();
  tray.on("double-click", toggleVisibility);

  const unsubscribe = collector.subscribe(snapshot => send(IPC_CHANNELS.ON_SNAPSHOT, snapshot));
  const unsubscribeTracker = tracker.onUpdate(window => {
    detected = window;
    refreshPosition();
  });
  app.on("before-quit", () => {
    quitting = true;
    stopMouseHitTesting();
    screen.removeListener("display-metrics-changed", refreshPosition);
    unsubscribe();
    unsubscribeTracker();
    collector.stop();
    tracker.stop();
    tray?.destroy();
  });
  win.once("ready-to-show", () => {
    void overlayFrameReady.then(() => {
      if (quitting || win.isDestroyed() || win.webContents.isCrashed()) return;
      rendererReady = true;
      refreshPosition();
    });
  });
  collector.start();
  if (!standalone) tracker.start(config.hideOnApprovalDialog);
  refreshPosition();
  await win.loadFile(fileURLToPath(new URL("../ui/index.html", import.meta.url)));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void app.whenReady().then(initialize).catch(error => {
    console.error("Codex Dashboard could not start", error);
    app.quit();
  });
}

