import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { CodexExitWatchdog } from "../cdp/codexApp.js";
import { CodexCdpHost, selectCodexTargets } from "../cdp/host.js";
import {
  classifyCodexSurface,
  computeCollapseMode,
  computeHudLayoutMode,
  type HudLayoutMode,
  type SurfaceSignals
} from "../cdp/layoutMath.js";
import { CDP_BINDING_NAME, CDP_HOST, CDP_RECEIVE_FN, parseWidgetMessage, type CdpHostEvent } from "../cdp/protocol.js";

test("collapse includes breathing room and retains its state within the hysteresis band", () => {
  const collapsed = (availableGapPx: number, currentCollapsed: boolean) =>
    computeCollapseMode({ availableGapPx, currentCollapsed, expandedWidthPx: 100 });

  assert.equal(collapsed(119, false), true);
  assert.equal(collapsed(120, false), false);
  assert.equal(collapsed(143, true), true);
  assert.equal(collapsed(144, true), false);
  for (const start of [false, true]) {
    let state = start;
    for (const gap of [126, 143, 120, 142]) state = collapsed(gap, state);
    assert.equal(state, start);
  }
  assert.equal(collapsed(Infinity, false), true);
  assert.equal(computeCollapseMode({
    availableGapPx: 110, currentCollapsed: true, expandedWidthPx: 100, safetyMarginPx: 10, hysteresisPx: 0
  }), false);
});

test("3-tier HUD layout shrinks to individual per-button icons first, then single-icon fallback with hysteresis", () => {
  const mode = (availableGapPx: number, currentMode: HudLayoutMode) =>
    computeHudLayoutMode({
      availableGapPx,
      currentMode,
      expandedWidthPx: 360,
      iconsWidthPx: 142,
      singleWidthPx: 28,
      safetyMarginPx: 18,
      hysteresisPx: 20
    });

  // Downward thresholds: expandedMin = 378, iconsMin = 160, singleMin = 36
  assert.equal(mode(378, "expanded"), "expanded");
  assert.equal(mode(377, "expanded"), "icons");
  assert.equal(mode(220, "icons"), "icons");
  assert.equal(mode(160, "icons"), "icons");
  assert.equal(mode(159, "icons"), "single");
  assert.equal(mode(36, "single"), "single");
  assert.equal(mode(35, "single"), "hidden");

  // Upward hysteresis thresholds: singleExpand = 44, iconsExpand = 180, expandedExpand = 398
  assert.equal(mode(43, "hidden"), "hidden");
  assert.equal(mode(44, "hidden"), "single");
  assert.equal(mode(179, "single"), "single");
  assert.equal(mode(180, "single"), "icons");
  assert.equal(mode(397, "icons"), "icons");
  assert.equal(mode(398, "icons"), "expanded");

  // Wobble inside both hysteresis bands never oscillates
  let state: HudLayoutMode = "icons";
  for (const gap of [380, 397, 378, 396, 160, 179]) state = mode(gap, state);
  assert.equal(state, "icons");

  // Invalid inputs hide safely
  assert.equal(mode(NaN, "expanded"), "hidden");
  assert.equal(mode(Infinity, "expanded"), "hidden");
  assert.equal(mode(0, "expanded"), "hidden");
});

test("classify the Codex composer, ordinary Chat and voice surfaces", () => {
  const surface = (patch: Partial<SurfaceSignals>) => classifyCodexSurface({
    url: "/",
    hasCodexAccessControl: false,
    hasWorkspaceIndicator: false,
    hasModelControl: true,
    isOrdinaryChatSurface: false,
    isVoiceMode: false,
    ...patch
  });
  assert.deepEqual(surface({ url: "/chat", isOrdinaryChatSurface: true }), { show: false, reason: "ordinary_chat_page" });
  assert.deepEqual(surface({ url: "/threads/abc", hasCodexAccessControl: true, isVoiceMode: true }),
    { show: false, reason: "voice_mode" });
  assert.deepEqual(surface({ hasCodexAccessControl: true }), { show: true, reason: "codex_composer_controls" });
  assert.deepEqual(surface({ hasWorkspaceIndicator: true }), { show: true, reason: "codex_composer_controls" });
  assert.deepEqual(surface({ url: "/THREADS/abc" }), { show: true, reason: "codex_route" });
  assert.deepEqual(surface({ url: "/threads/abc", hasModelControl: false }), { show: false, reason: "non_codex_surface" });
});

test("parse widget bindings into supported messages", () => {
  for (const type of ["ready", "apply_update", "restart_monitor"]) {
    assert.deepEqual(parseWidgetMessage(JSON.stringify({ type, extra: true })), { type });
  }
  assert.deepEqual(parseWidgetMessage('{"type":"thread_hint","threadId":"example"}'),
    { type: "thread_hint", threadId: "example" });
  assert.deepEqual(parseWidgetMessage('{"type":"thread_hint","threadId":42}'), { type: "thread_hint", threadId: null });
  assert.deepEqual(parseWidgetMessage('{"type":"update_config","patch":{"theme":"dark"}}'),
    { type: "update_config", patch: { theme: "dark" } });
  assert.deepEqual(parseWidgetMessage('{"type":"check_updates","repo":"owner/repo"}'),
    { type: "check_updates", repo: "owner/repo" });
  for (const raw of ["{", "null", "[]", '{"type":"unknown"}', '{"type":"update_config","patch":42}']) {
    assert.equal(parseWidgetMessage(raw), null);
  }
});

function target(port: number, id: string) {
  return { id, type: "page", title: "Codex", url: "app://-/index.html",
    webSocketDebuggerUrl: `ws://${CDP_HOST}:${port}/devtools/page/${id}` };
}

test("select only Codex page targets with a localhost page debugger URL", () => {
  const main = target(9222, "main");
  const second = { ...target(9222, "second"), title: "Workspace", url: "app://-/threads/current" };
  assert.deepEqual(selectCodexTargets([
    main, second,
    null, {},
    { ...main, type: "worker" },
    { ...main, url: "devtools://devtools/bundled/inspector.html" },
    { ...main, url: "chrome-extension://fake/codex.html" },
    { ...main, url: "https://example.com/codex" },
    { ...main, url: "app://fs/index.html" },
    { ...main, webSocketDebuggerUrl: "ws://192.0.2.1:9222/devtools/page/main" },
    { ...main, webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/main" },
    { ...main, webSocketDebuggerUrl: undefined }
  ]), [main, second]);
});

interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

function writeFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = payload.length;
  else {
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function readClientFrames(socket: Duplex, head: Buffer, onText: (text: string) => void): void {
  let buffer: Buffer = head;
  const processFrames = () => {
    while (buffer.length >= 2) {
      const opcode = buffer[0]! & 0x0f;
      const lengthCode = buffer[1]! & 0x7f;
      const offset = lengthCode < 126 ? 2 : lengthCode === 126 ? 4 : 10;
      assert.equal(buffer[0]! & 0x80, 0x80, "mock expects complete messages");
      assert.equal(buffer[1]! & 0x80, 0x80, "clients mask WebSocket frames");
      if (buffer.length < offset + 4) return;
      const length = offset === 2 ? lengthCode
        : offset === 4 ? buffer.readUInt16BE(2) : Number(buffer.readBigUInt64BE(2));
      const start = offset + 4;
      if (buffer.length < start + length) return;
      const payload = Buffer.alloc(length);
      for (let i = 0; i < length; i++) payload[i] = buffer[start + i]! ^ buffer[offset + (i % 4)]!;
      buffer = buffer.subarray(start + length);
      if (opcode === 1) onText(payload.toString("utf8"));
      if (opcode === 8) {
        writeFrame(socket, 8, payload);
        socket.end();
        return;
      }
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    processFrames();
  });
  processFrames();
}

function mockPage(socket: Duplex, head: Buffer, key: string) {
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const commands: Request[] = [];
  const events: CdpHostEvent[] = [];
  const send = (message: object) => writeFrame(socket, 1, Buffer.from(JSON.stringify(message)));
  const emit = (method: string, params: object) => send({ method, params });
  let contextId = 1;
  const executionContext = () => emit("Runtime.executionContextCreated", {
    context: { id: contextId, origin: "app://-", auxData: { isDefault: true, frameId: "main" } }
  });
  readClientFrames(socket, head, text => {
    const command = JSON.parse(text) as Request;
    commands.push(command);
    let result = {};
    switch (command.method) {
      case "Runtime.enable":
        executionContext();
        break;
      case "Page.getFrameTree":
        result = { frameTree: { frame: { id: "main" } } };
        break;
      case "Page.addScriptToEvaluateOnNewDocument":
        result = { identifier: "script-" + command.id };
        break;
      case "Runtime.evaluate": {
        const expression = String(command.params?.expression);
        const call = expression.split(`window[${JSON.stringify(CDP_RECEIVE_FN)}]?.(`)[1];
        if (call) {
          assert.equal(command.params?.contextId, contextId);
          events.push(JSON.parse(call.slice(0, call.lastIndexOf(");"))) as CdpHostEvent);
        }
        break;
      }
    }
    send({ id: command.id, result });
  });
  return {
    socket, commands, events,
    binding(message: object, executionContextId = contextId) {
      emit("Runtime.bindingCalled", { name: CDP_BINDING_NAME, payload: JSON.stringify(message), executionContextId });
    },
    navigate() {
      contextId++;
      emit("Runtime.executionContextsCleared", {});
      emit("Page.frameNavigated", { frame: { id: "main", url: "app://-/threads/new" } });
      executionContext();
    }
  };
}

type MockPage = ReturnType<typeof mockPage>;

async function until(predicate: () => boolean | undefined, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, description);
    await delay(15);
  }
}

test("CDP host injects and serves independent windows, reconnects, reloads, and tears down", { timeout: 15_000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hud-cdp-"));
  const version = "1.2.3";
  const configPath = path.join(root, "config", "config.json");
  const codexHome = path.join(root, "codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "11", "23");
  const widgetPath = path.join(root, "widget.js");
  const threadIds = ["019abcde-1234-7000-8000-000000000001", "019abcde-1234-7000-8000-000000000002"] as const;
  const targetIds = new Set(["first"]);
  const pages = new Map<string, MockPage>();
  const sockets = new Set<Duplex>();
  const requests: string[] = [];
  let port = 0;
  let host: CodexCdpHost | undefined;
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    res.writeHead(req.url === "/json/list" ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.from(targetIds, id => target(port, id))));
  });
  t.after(async () => {
    try {
      await host?.stop();
    } finally {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  await mkdir(sessionDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({ version })),
    writeFile(widgetPath, "window.widgetVersion = 1;"),
    ...threadIds.map(async (id, index) => {
      const filename = path.join(sessionDir, `rollout-2026-11-23T10-00-00-${id}.jsonl`);
      await writeFile(filename, JSON.stringify({ type: "session_meta", payload: { id, cwd: id } }) + "\n");
      const mtime = new Date(Date.UTC(2026, 10, 23, 10, index));
      await utimes(filename, mtime, mtime);
    })
  ]);
  server.on("upgrade", (req, socket, head) => {
    const id = req.url?.split("/").at(-1);
    const key = req.headers["sec-websocket-key"];
    if (!id || !targetIds.has(id) || typeof key !== "string") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    pages.set(id, mockPage(socket, head, key));
  });
  await new Promise<void>(resolve => server.listen(0, CDP_HOST, resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  port = address.port;
  host = new CodexCdpHost({ port, configPath, codexHome, widgetPath, root });
  await host.start();

  const injected = (page: MockPage | undefined, revision: number) =>
    page?.commands.some(({ method, params }) => method === "Runtime.evaluate"
      && String(params?.expression).includes(`window.widgetVersion = ${revision};`));
  await until(() => injected(pages.get("first"), 1), "inject the current document");
  const first = pages.get("first")!;
  assert.deepEqual(first.commands.find(command => command.method === "Runtime.addBinding")?.params, { name: CDP_BINDING_NAME });
  const preload = String(first.commands.find(command => command.method === "Page.addScriptToEvaluateOnNewDocument")?.params?.source);
  assert.match(preload, /window\.widgetVersion = 1;/);
  const document = new EventTarget();
  const window: { top?: object; widgetVersion?: number } = {};
  window.top = window;
  runInNewContext(preload, { window, location: { protocol: "app:", host: "-" },
    document: Object.assign(document, { readyState: "loading" }) });
  assert.equal(window.widgetVersion, undefined, "defer mounting while the DOM is loading");
  document.dispatchEvent(new Event("DOMContentLoaded"));
  assert.equal(window.widgetVersion, 1);
  assert.ok(first.commands.some(command => command.method === "Runtime.enable"));
  assert.ok(first.commands.some(command => command.method === "Page.enable"));

  const beforeReady = first.events.length;
  first.binding({ type: "ready" });
  await until(() => first.events.length >= beforeReady + 3, "reply to ready with snapshot, config and version");
  assert.deepEqual(first.events.slice(beforeReady, beforeReady + 3).map(event => event.type), ["snapshot", "config", "update_status"]);
  assert.ok(first.events.some(event => event.type === "update_status" && event.payload.currentVersion === version));

  targetIds.add("second");
  await until(() => injected(pages.get("second"), 1), "attach a window discovered on a later scan");
  const second = pages.get("second")!;
  const lastSession = (page: MockPage) => page.events.findLast(event => event.type === "snapshot")?.payload.sessionId;
  first.binding({ type: "thread_hint", threadId: threadIds[0] });
  second.binding({ type: "thread_hint", threadId: threadIds[1] });
  await until(() => lastSession(first) === threadIds[0] && lastSession(second) === threadIds[1], "use a parser per thread");
  const eventCount = first.events.length;
  first.navigate();
  first.binding({ type: "ready" });
  await until(() => first.events.length >= eventCount + 3 && lastSession(first) === threadIds[1],
    "a new document without a hint uses the latest global session");
  first.binding({ type: "thread_hint", threadId: threadIds[0] });
  await until(() => lastSession(first) === threadIds[0], "a new document can select its own thread");

  // Switching to a brand-new unsent conversation (threadId: null) resets per-thread metrics to initialized zeros
  const lastSnap = (page: MockPage) => page.events.findLast(event => event.type === "snapshot")?.payload;
  first.binding({ type: "thread_hint", threadId: null });
  await until(() => lastSnap(first)?.sessionId === null && lastSnap(first)?.tokens.totalTokens === 0,
    "a new unsent conversation resets metrics to initialized state");
  assert.equal(lastSnap(first)?.context.usedTokens, 0);
  assert.equal(lastSnap(first)?.speed.latestStepTps, null);
  assert.equal(lastSnap(first)?.cache.weightedHitRate, null);

  // A brand-new thread UUID whose rollout has not yet been written shows initialized zeros instead of an old session
  const pendingThreadId = "019abcde-1234-7000-8000-000000000099";
  first.binding({ type: "thread_hint", threadId: pendingThreadId });
  await until(() => lastSnap(first)?.sessionId === pendingThreadId && lastSnap(first)?.tokens.totalTokens === 0,
    "a new thread before its first rollout flush stays initialized");
  const pendingFile = path.join(sessionDir, `rollout-2026-11-23T10-05-00-${pendingThreadId}.jsonl`);
  await writeFile(pendingFile, [
    JSON.stringify({ type: "session_meta", payload: { id: pendingThreadId, cwd: pendingThreadId } }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 475000,
          last_token_usage: { input_tokens: 12000, cached_input_tokens: 9000, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 12400 },
          total_token_usage: { input_tokens: 12000, cached_input_tokens: 9000, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 12400 }
        }
      }
    })
  ].join("\n") + "\n");
  await until(() => lastSnap(first)?.sessionId === pendingThreadId && lastSnap(first)?.tokens.totalTokens === 12400,
    "once the new thread writes its rollout, live metrics stream in automatically");
  first.binding({ type: "thread_hint", threadId: threadIds[0] });
  await until(() => lastSession(first) === threadIds[0], "can switch back to an existing thread");

  second.binding({ type: "update_config", patch: { theme: "dark", offsetX: 25 } });
  const hasConfig = (page: MockPage) =>
    page.events.some(event => event.type === "config" && event.payload.theme === "dark" && event.payload.offsetX === 25);
  await until(() => hasConfig(first) && hasConfig(second), "broadcast the persisted config");
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.theme, "dark");
  assert.equal(persisted.offsetX, 25);

  second.socket.destroy();
  await until(() => pages.get("second") !== second && injected(pages.get("second"), 1), "reconnect the disconnected window");
  const reconnected = pages.get("second")!;
  await writeFile(widgetPath, "window.widgetVersion = 2;");
  first.binding({ type: "restart_monitor" });
  await until(() => injected(first, 2) && injected(reconnected, 2), "hot-reload the script in all attached windows");
  for (const page of [first, reconnected]) {
    assert.ok(page.commands.some(command => command.method === "Page.removeScriptToEvaluateOnNewDocument"));
    assert.equal(page.events.filter(event => event.type === "teardown").length, 1);
  }

  await host.stop();
  await until(() => sockets.size === 0, "close all attached WebSockets");
  for (const page of [first, reconnected]) {
    assert.equal(page.events.filter(event => event.type === "teardown").length, 2);
    assert.ok(page.commands.some(command => command.method === "Runtime.removeBinding"));
  }
  delete window.widgetVersion;
  const renderer = { window, document, location: { protocol: "app:", host: "-" } };
  runInNewContext(preload, renderer);
  const teardown = first.commands.findLast(command => command.method === "Runtime.evaluate"
    && String(command.params?.expression).includes('"type":"teardown"'));
  runInNewContext(String(teardown?.params?.expression), renderer);
  document.dispatchEvent(new Event("DOMContentLoaded"));
  assert.equal(window.widgetVersion, undefined, "teardown cancels an outstanding mount");
  assert.ok(requests.length >= 3);
  assert.ok(requests.every(url => url === "/json/list"));
});

test("CodexExitWatchdog auto-exits after Codex closes, tolerates transient misses, and respects toggle & startup timeout", async () => {
  const replies = [false, true, false, true, false, false];
  let exited = 0;
  const watchdog = new CodexExitWatchdog({
    probe: async () => replies.shift() ?? false,
    onExited: () => { exited += 1; },
    missThreshold: 2
  });

  // Initial miss before Codex finishes booting should not trigger exit
  await watchdog.tick();
  assert.equal(watchdog.hasSeenAlive(), false);
  assert.equal(exited, 0);

  // Alive once -> seenAlive becomes true
  await watchdog.tick();
  assert.equal(watchdog.hasSeenAlive(), true);
  assert.equal(exited, 0);

  // Single transient miss then recovery resets miss counter
  await watchdog.tick();
  assert.equal(exited, 0);
  await watchdog.tick();
  assert.equal(exited, 0);

  // Two consecutive misses after seenAlive triggers onExited once
  await watchdog.tick();
  assert.equal(exited, 0);
  await watchdog.tick();
  assert.equal(exited, 1);

  // Disabled watchdog never fires onExited
  let disabledExited = 0;
  const disabledWatchdog = new CodexExitWatchdog({
    probe: async () => false,
    initiallyAlive: true,
    missThreshold: 1,
    onExited: () => { disabledExited += 1; }
  });
  disabledWatchdog.setEnabled(false);
  await disabledWatchdog.tick();
  await disabledWatchdog.tick();
  assert.equal(disabledExited, 0);
  disabledWatchdog.stop();

  // Startup timeout fires when Codex never becomes reachable
  let timedOut = 0;
  const timeoutWatchdog = new CodexExitWatchdog({
    probe: async () => false,
    startupTimeoutMs: 1,
    onExited: () => {},
    onStartupTimeout: () => { timedOut += 1; }
  });
  timeoutWatchdog.start();
  await delay(25);
  await timeoutWatchdog.tick();
  timeoutWatchdog.stop();
  assert.equal(timedOut, 1);
});
