import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RolloutParser } from "../collector/rolloutParser.js";
import { TelemetryCollectorService } from "../collector/service.js";
import { OverlayConfigStore } from "../overlay/configStore.js";
import { DEFAULT_OVERLAY_CONFIG, OFFICIAL_GITHUB_REPO, type OverlayConfig, type TelemetrySnapshot, type UpdateStatus } from "../shared/types.js";
import { GithubUpdater } from "../updater/githubUpdater.js";
import {
  CDP_BINDING_NAME, CDP_DEFAULT_PORT, CDP_HOST, CDP_RECEIVE_FN, parseWidgetMessage, type CdpHostEvent
} from "./protocol.js";

const SCAN_INTERVAL = 2_000;
const COMMAND_TIMEOUT = 2_000;
const THREAD_UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const CANCEL_PENDING_MOUNT = 'window["__codexHudCancelPendingMount"]';
const TASK_INITIAL_ROUTE = /^\/local\/[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\/?$/i;
function isCodexOrigin(url: string): boolean {
  const parsed = URL.parse(url);
  return Boolean(parsed && parsed.protocol === "app:" && parsed.host === "-");
}
function isCodexUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed || parsed.protocol !== "app:" || parsed.host !== "-") return false;
  const initialRoute = parsed.searchParams.get("initialRoute");
  // Exclude auxiliary Codex Electron shells (quick chat, avatar, browser prewarm)
  if (initialRoute !== null && !TASK_INITIAL_ROUTE.test(initialRoute)) return false;
  return true;
}
const inCodexWindow = (source: string) =>
  `if (window === window.top && location.protocol === "app:" && location.host === "-") {\n${source}\n}`;

function widgetExpression(source: string): string {
  // CDP's new-document script can run before the widget has a DOM to mount into.
  return inCodexWindow(`(() => {
    ${CANCEL_PENDING_MOUNT}?.();
    const mount = () => {
      delete ${CANCEL_PENDING_MOUNT};
      ${source}
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      ${CANCEL_PENDING_MOUNT} = () => {
        document.removeEventListener("DOMContentLoaded", mount);
        delete ${CANCEL_PENDING_MOUNT};
      };
    } else {
      mount();
    }
  })();`);
}

interface CodexTarget {
  id: string;
  type: "page";
  url: string;
  title?: string;
  webSocketDebuggerUrl: string;
}

function debuggerUrl(target: CodexTarget, port?: number): URL | undefined {
  const url = URL.parse(target.webSocketDebuggerUrl);
  if (url?.protocol === "ws:" && url.hostname === CDP_HOST && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === "/devtools/page/" + encodeURIComponent(target.id)
    && (port === undefined || Number(url.port || 80) === port)) return url;
}

export function selectCodexTargets(targets: readonly unknown[]): CodexTarget[] {
  return targets.filter((value): value is CodexTarget => {
    if (!value || typeof value !== "object") return false;
    const target = value as Partial<CodexTarget>;
    return target.type === "page" && typeof target.id === "string" && /^[\w-]+$/.test(target.id)
      && typeof target.url === "string" && isCodexUrl(target.url)
      && typeof target.webSocketDebuggerUrl === "string" && Boolean(debuggerUrl(target as CodexTarget));
  });
}

export async function probeCodexCdp(port: number, signal?: AbortSignal): Promise<{ targets: CodexTarget[] | null } | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError("CDP 端口必须在 1–65535 之间");
  const timeout = AbortSignal.timeout(COMMAND_TIMEOUT);
  let response: Response;
  try {
    response = await fetch(`http://${CDP_HOST}:${port}/json/list`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "manual"
    });
  } catch (error) {
    // Only start an app when the endpoint actively refuses the connection.
    const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined;
    return cause?.code === "ECONNREFUSED" ? null : { targets: null };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { targets: null };
  }
  const data: unknown = await response.json().catch(() => null);
  return { targets: Array.isArray(data) ? selectCodexTargets(data).filter(target => debuggerUrl(target, port)) : null };
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

interface PendingCommand {
  timer: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class PageConnection {
  readonly socket: WebSocket;
  readonly opened: Promise<void>;
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();

  constructor(url: string, onEvent: (event: CdpMessage) => void, onClose: () => void) {
    const socket = this.socket = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.close(), COMMAND_TIMEOUT);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 已关闭"));
      }, { once: true });
    });
    socket.addEventListener("error", () => this.close());
    socket.addEventListener("close", () => {
      for (const { timer, reject } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP WebSocket 已关闭"));
      }
      this.pending.clear();
      onClose();
    });
    socket.addEventListener("message", ({ data }) => {
      if (typeof data !== "string") return;
      let message: CdpMessage;
      try { message = JSON.parse(data); } catch { return; }
      if (!message || typeof message !== "object") return;
      if (typeof message.id === "number") {
        const command = this.pending.get(message.id);
        if (!command) return;
        this.pending.delete(message.id);
        clearTimeout(command.timer);
        if (message.error) command.reject(new Error(message.error.message ?? "CDP 命令失败"));
        else command.resolve(message.result);
      } else {
        onEvent(message);
      }
    });
  }

  async send<T = unknown>(method: string, params?: object): Promise<T> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("CDP WebSocket 尚未连接");
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 命令超时 ${method}`));
      }, COMMAND_TIMEOUT);
      this.pending.set(id, { timer, reject, resolve: result => resolve(result as T) });
    });
  }

  close(): void {
    this.socket.close();
  }
}

interface PageContext {
  id: number;
  uniqueId?: string;
  origin: string;
  auxData?: { isDefault?: boolean; frameId?: string };
}

interface ThreadState {
  id: string;
  parser?: RolloutParser;
  refreshing?: Promise<void>;
  nextDiscovery: number;
}

interface AttachedPage {
  url: string;
  connection: PageConnection;
  installation: Promise<void>;
  contexts: Map<number, PageContext>;
  frameId?: string;
  preloadId?: string;
  thread?: ThreadState;
  lastSnapshot?: string;
  detaching?: Promise<void>;
}

export interface CodexCdpHostState {
  attachedPages: number;
  updateStatus: UpdateStatus | null;
}

export interface CodexCdpHostOptions {
  port?: number;
  root?: string;
  widgetPath?: string;
  widgetSource?: string;
  codexHome?: string;
  configPath?: string;
  onStateChange?: (state: CodexCdpHostState) => void;
}

async function findThreadRollout(sessionDir: string, threadId: string): Promise<string | undefined> {
  const dirs = [sessionDir];
  const suffix = "-" + threadId + ".jsonl";
  for (const dir of dirs) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(filename);
      else if (entry.isFile() && /^rollout-/i.test(entry.name) && entry.name.toLowerCase().endsWith(suffix)) return filename;
    }
  }
}

export class CodexCdpHost {
  private readonly port: number;
  private readonly root: string;
  private readonly store: OverlayConfigStore;
  private readonly collector: TelemetryCollectorService;
  private readonly pages = new Map<string, AttachedPage>();
  private readonly lifetime = new AbortController();
  private config: OverlayConfig = { ...DEFAULT_OVERLAY_CONFIG };
  private updater?: GithubUpdater;
  private source = "";
  private scanTimer?: ReturnType<typeof setInterval>;
  private snapshotTimer?: ReturnType<typeof setInterval>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private scanning = false;
  private reloading?: Promise<void>;
  private applying?: Promise<UpdateStatus>;

  constructor(private readonly options: CodexCdpHostOptions = {}) {
    this.port = options.port ?? CDP_DEFAULT_PORT;
    this.root = options.root ?? fileURLToPath(new URL("../../", import.meta.url));
    this.store = new OverlayConfigStore(options.configPath);
    this.collector = new TelemetryCollectorService({ codexHome: options.codexHome });
  }

  start(): Promise<void> {
    return this.starting ??= this.initialize();
  }

  stop(): Promise<void> {
    return this.stopping ??= this.shutdown();
  }

  getAttachedCount(): number {
    return this.pages.size;
  }

  async reloadWidgets(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    this.reloading ??= this.reload().finally(() => { this.reloading = undefined; });
    await this.reloading;
  }

  async checkForUpdatesNow(repoOverride?: string): Promise<UpdateStatus | null> {
    if (!this.updater || this.lifetime.signal.aborted) return null;
    return this.updater.checkForUpdates(this.config, repoOverride?.trim() || OFFICIAL_GITHUB_REPO);
  }

  private notifyState(): void {
    if (this.lifetime.signal.aborted) return;
    this.options.onStateChange?.({
      attachedPages: this.pages.size,
      updateStatus: this.updater?.getStatus() ?? null
    });
  }

  private async initialize(): Promise<void> {
    const [source, config, metadata] = await Promise.all([
      this.readWidget(),
      this.store.load(),
      readFile(path.join(this.root, "package.json"), "utf8")
    ]);
    if (this.lifetime.signal.aborted) return;
    const { version } = JSON.parse(metadata);
    if (typeof version !== "string" || !version) throw new Error("package.json 缺少版本号");
    this.source = source;
    this.config = config;
    this.updater = new GithubUpdater({
      root: this.root,
      currentVersion: version,
      helperPath: path.join(this.root, "dist", "updater", "applyStaged.mjs"),
      executable: process.execPath,
      args: process.argv.slice(1),
      onStatus: payload => {
        this.broadcast({ type: "update_status", payload });
        this.notifyState();
      },
      onProgress: payload => this.broadcast({ type: "update_progress", payload })
    });
    this.updater.invalidatePlan(config.repo);
    this.collector.start();
    this.scanTimer = setInterval(() => { void this.scan(); }, SCAN_INTERVAL);
    this.snapshotTimer = setInterval(() => {
      for (const page of this.pages.values()) void this.refreshPage(page);
    }, 1_000);
    void this.scan();
  }

  private readWidget(): Promise<string> {
    if (this.options.widgetSource !== undefined) return Promise.resolve(this.options.widgetSource);
    return readFile(this.options.widgetPath ?? path.join(this.root, "dist", "cdp", "widget.js"), "utf8");
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.lifetime.signal.aborted) return;
    this.scanning = true;
    try {
      const probe = await probeCodexCdp(this.port, this.lifetime.signal);
      if (!probe?.targets || this.lifetime.signal.aborted) return;
      const targets = new Map(probe.targets.map(target => [target.id, new URL(target.webSocketDebuggerUrl).href]));
      await Promise.all(Array.from(this.pages, async ([id, page]) => {
        if (targets.get(id) === page.url) return;
        await this.detach(page);
        if (this.pages.get(id) === page) {
          this.pages.delete(id);
          this.notifyState();
        }
      }));
      if (this.lifetime.signal.aborted) return;
      for (const [id, url] of targets) {
        if (!this.pages.has(id)) this.attach(id, url);
      }
    } catch (error) {
      if (!this.lifetime.signal.aborted) console.error("扫描 Codex CDP 页面失败", error);
    } finally {
      this.scanning = false;
    }
  }

  private attach(id: string, url: string): void {
    const connection = new PageConnection(url, event => this.handleEvent(page, event), () => {
      if (this.pages.get(id) === page) {
        this.pages.delete(id);
        this.notifyState();
      }
    });
    const page: AttachedPage = { url, connection, contexts: new Map(), installation: Promise.resolve() };
    this.pages.set(id, page);
    this.notifyState();
    page.installation = this.install(page).catch(error => this.installFailed(page, error));
  }

  private async install(page: AttachedPage): Promise<void> {
    const cdp = page.connection;
    await cdp.opened;
    if (this.lifetime.signal.aborted) return;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    page.frameId = frameTree.frame.id;
    await cdp.send("Runtime.addBinding", { name: CDP_BINDING_NAME });
    if (this.lifetime.signal.aborted) return;
    await this.installWidget(page);
  }

  private async installWidget(page: AttachedPage): Promise<void> {
    const cdp = page.connection;
    if (page.preloadId) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.preloadId });
    const source = widgetExpression(this.source);
    const { identifier } = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source });
    page.preloadId = identifier;
    const result = await cdp.send<{ exceptionDetails?: unknown }>("Runtime.evaluate", { expression: source });
    if (result?.exceptionDetails) throw new Error("Codex CDP 控件脚本执行失败");
  }

  private installFailed(page: AttachedPage, error: unknown): void {
    if (!this.lifetime.signal.aborted && !page.detaching) console.error("挂载 Codex CDP 控件失败", error);
    page.connection.close();
  }

  private mainContext(page: AttachedPage): PageContext | undefined {
    return Array.from(page.contexts.values()).find(context => context.auxData?.isDefault
      && context.auxData.frameId === page.frameId && isCodexOrigin(context.origin));
  }

  private handleEvent(page: AttachedPage, { method, params }: CdpMessage): void {
    if (!params) return;
    switch (method) {
      case "Page.frameNavigated": {
        const frame = params.frame as { id: string; parentId?: string } | undefined;
        if (frame && !frame.parentId) page.frameId = frame.id;
        break;
      }
      case "Runtime.executionContextCreated": {
        const context = params.context as PageContext | undefined;
        if (context && typeof context.origin === "string" && context.auxData?.isDefault) page.contexts.set(context.id, context);
        break;
      }
      case "Runtime.executionContextDestroyed": {
        const id = Number(params.executionContextId);
        if (id === this.mainContext(page)?.id) {
          page.thread = undefined;
          page.lastSnapshot = undefined;
        }
        page.contexts.delete(id);
        break;
      }
      case "Runtime.executionContextsCleared":
        page.contexts.clear();
        page.thread = undefined;
        page.lastSnapshot = undefined;
        break;
      case "Runtime.bindingCalled":
        if (!this.lifetime.signal.aborted && !page.detaching && params.name === CDP_BINDING_NAME && typeof params.payload === "string"
          && this.mainContext(page)?.id === params.executionContextId && typeof params.executionContextId === "number") {
          void this.handleMessage(page, params.payload).catch(error => console.error("处理 Codex CDP 控件消息失败", error));
        }
    }
  }

  private async handleMessage(page: AttachedPage, payload: string): Promise<void> {
    const message = parseWidgetMessage(payload);
    const updater = this.updater!;
    switch (message?.type) {
      case "ready":
        this.sendCurrentState(page);
        break;
      case "thread_hint": {
        const id = message.threadId?.toLowerCase();
        const threadId = id && THREAD_UUID.test(id) ? id : undefined;
        if (threadId === page.thread?.id) break;
        page.thread = threadId ? { id: threadId, nextDiscovery: 0 } : undefined;
        await this.refreshPage(page);
        break;
      }
      case "update_config": {
        const config = await this.store.update(message.patch);
        const changedRepo = config.repo !== this.config.repo || config.updateChannel !== this.config.updateChannel;
        this.config = config;
        if (changedRepo) updater.invalidatePlan(config.repo);
        this.broadcast({ type: "config", payload: config });
        break;
      }
      case "check_updates":
        await updater.checkForUpdates(this.config, message.repo?.trim() || OFFICIAL_GITHUB_REPO);
        break;
      case "apply_update":
        this.applying ??= updater.applyUpdate().finally(() => { this.applying = undefined; });
        await this.applying;
        break;
      case "restart_monitor":
        if (updater.getStatus().state === "applied_restart_required") {
          const scheduled = await updater.scheduleExit(true);
          if (scheduled) {
            await this.stop();
            process.exit(0);
          }
          // Git mode: backend & widget were rebuilt on disk; hot-reload widget and notify user if full backend reload is desired
        }
        this.reloading ??= this.reload().finally(() => { this.reloading = undefined; });
        await this.reloading;
        break;
    }
  }

  private async refreshPage(page: AttachedPage): Promise<void> {
    if (this.lifetime.signal.aborted || page.detaching || !this.mainContext(page)) return;
    const thread = page.thread;
    if (!thread) {
      this.pushSnapshot(page, this.collector.getSnapshot());
      return;
    }
    thread.refreshing ??= this.refreshThread(page, thread).finally(() => { thread.refreshing = undefined; });
    await thread.refreshing;
  }

  private async refreshThread(page: AttachedPage, thread: ThreadState): Promise<void> {
    if (!thread.parser && Date.now() >= thread.nextDiscovery) {
      const filename = await findThreadRollout(path.join(this.collector.codexHome, "sessions"), thread.id);
      if (filename) thread.parser = new RolloutParser(filename);
      thread.nextDiscovery = Date.now() + 5_000;
    }
    let snapshot: TelemetrySnapshot | undefined;
    if (thread.parser) {
      try {
        snapshot = await thread.parser.refresh();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error("读取 Codex 会话 rollout 失败", error);
          return;
        }
        thread.parser = undefined;
        thread.nextDiscovery = 0;
      }
    }
    if (page.thread === thread && !page.detaching && !this.lifetime.signal.aborted) {
      this.pushSnapshot(page, snapshot ?? this.collector.getSnapshot());
    }
  }

  private async reload(): Promise<void> {
    const source = await this.readWidget();
    if (this.lifetime.signal.aborted) return;
    this.source = source;
    await Promise.all(Array.from(this.pages.values(), page => {
      if (page.detaching) return;
      page.installation = page.installation.then(async () => {
        if (page.detaching || this.lifetime.signal.aborted) return;
        await this.deliver(page, { type: "teardown" });
        await this.installWidget(page);
      }).catch(error => this.installFailed(page, error));
      return page.installation;
    }));
  }

  private sendCurrentState(page: AttachedPage): void {
    if (page.detaching || this.lifetime.signal.aborted) return;
    this.pushSnapshot(page, page.thread?.parser?.getSnapshot() ?? this.collector.getSnapshot(), true);
    void this.deliver(page, { type: "config", payload: this.config });
    void this.deliver(page, { type: "update_status", payload: this.updater!.getStatus() });
  }

  private pushSnapshot(page: AttachedPage, snapshot: TelemetrySnapshot, force = false): void {
    const serialized = JSON.stringify(snapshot);
    if (!force && page.lastSnapshot === serialized) return;
    page.lastSnapshot = serialized;
    void this.deliver(page, { type: "snapshot", payload: snapshot });
  }

  private broadcast(event: CdpHostEvent): void {
    if (this.lifetime.signal.aborted) return;
    for (const page of this.pages.values()) {
      if (!page.detaching) void this.deliver(page, event);
    }
  }

  private async deliver(page: AttachedPage, event: CdpHostEvent): Promise<void> {
    const context = this.mainContext(page);
    if (!context) return;
    const receive = `window[${JSON.stringify(CDP_RECEIVE_FN)}]?.(${JSON.stringify(event)});`;
    await page.connection.send("Runtime.evaluate", {
      expression: inCodexWindow(event.type === "teardown" ? `${CANCEL_PENDING_MOUNT}?.();\n${receive}` : receive),
      ...(context.uniqueId ? { uniqueContextId: context.uniqueId } : { contextId: context.id })
    }).catch(() => {}); // Navigation can destroy the context before it receives the event.
  }

  private detach(page: AttachedPage): Promise<void> {
    return page.detaching ??= this.removeWidget(page);
  }

  private async removeWidget(page: AttachedPage): Promise<void> {
    const cdp = page.connection;
    try {
      if (cdp.socket.readyState !== WebSocket.OPEN) return;
      await page.installation;
      if (page.preloadId) {
        await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.preloadId }).catch(() => {});
      }
      await this.deliver(page, { type: "teardown" });
      await cdp.send("Runtime.removeBinding", { name: CDP_BINDING_NAME }).catch(() => {});
    } finally {
      cdp.close();
    }
  }

  private async shutdown(): Promise<void> {
    this.lifetime.abort();
    clearInterval(this.scanTimer);
    clearInterval(this.snapshotTimer);
    this.collector.stop();
    await Promise.all(Array.from(this.pages.values(), page => this.detach(page)));
    this.pages.clear();
    await this.applying;
    if (this.updater?.getStatus().state === "applied_restart_required") await this.updater.scheduleExit(false);
  }
}
