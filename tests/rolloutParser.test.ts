import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { RolloutParser } from "../collector/rolloutParser.js";
import { TelemetryCollectorService } from "../collector/service.js";

async function fixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hud-rollout-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const epoch = Date.UTC(2026, 0, 1);
const row = (ms: number, type: string, payload: object) =>
  JSON.stringify({ timestamp: new Date(epoch + ms).toISOString(), type, payload }) + "\r\n";
const event = (ms: number, type: string, payload = {}) => row(ms, "event_msg", { type, ...payload });
const response = (ms: number, type: string, payload = {}) => row(ms, "response_item", { type, ...payload });

function tokens(input: number, cached: number, output: number, reasoning = 0, written = 0) {
  return { input_tokens: input, cached_input_tokens: cached, output_tokens: output,
    reasoning_output_tokens: reasoning, cache_write_input_tokens: written, total_tokens: input + output };
}

test("byte tail holds a partial UTF-8 line and reuses in-flight reads", async t => {
  const filename = path.join(await fixture(t), "rollout-test.jsonl");
  const line = Buffer.from(row(1, "session_meta", { id: "first", cwd: "工作區📁" }));
  const split = line.indexOf(Buffer.from("工作")) + 1;
  await writeFile(filename, line.subarray(0, split));
  const parser = new RolloutParser(filename);
  const reading = parser.refresh();
  assert.equal(reading, parser.refresh());
  assert.equal((await reading).sessionId, null);
  await appendFile(filename, Buffer.concat([line.subarray(split), Buffer.from("bad line\n"),
    Buffer.from(row(2, "turn_context", { model: "gpt-test", effort: "low", turn_id: "a" }))]));
  const snapshot = await parser.refresh();
  assert.equal(snapshot.sessionId, "first");
  assert.equal(snapshot.cwd, "工作區📁");
  assert.equal(snapshot.model, "gpt-test");
  assert.equal(snapshot.reasoningEffort, "low");
  assert.deepEqual(await parser.refresh(), snapshot);

  await writeFile(filename, row(3, "session_meta", { id: "replacement" }));
  assert.equal((await parser.refresh()).sessionId, "replacement");
  assert.equal(parser.getSnapshot().cwd, null);
});

test("modern and legacy reports share a step and overlapping tools count once", async t => {
  const filename = path.join(await fixture(t), "rollout-test.jsonl");
  const first = tokens(50_000, 40_000, 100, 40, 10);
  const second = tokens(75_000, 60_000, 200, 150, 20);
  const third = tokens(60_000, 33_000, 50, 10, 30);
  const turn = { turn_id: "turn" };
  const record = (ms: number, step: ReturnType<typeof tokens>, total: ReturnType<typeof tokens>) =>
    row(ms, "token_usage_record", { ...turn, thread_id: "test", usage: step, turn_token_usage: total, thread_token_usage: total });
  const tokenCount = (ms: number, step: ReturnType<typeof tokens>, total: ReturnType<typeof tokens>) =>
    event(ms, "token_count", {
      info: { model_context_window: 100_000, last_token_usage: step, total_token_usage: total },
      rate_limits: { plan_type: "plus", primary: { used_percent: 13, window_minutes: 300, resets_at: 1234 }, secondary: null }
    });

  await writeFile(filename, [
    event(0, "task_started", { ...turn, model_context_window: 200_000 }),
    response(100, "message", { role: "user" }),
    response(1100, "custom_tool_call", { call_id: "a" }),
    record(1110, first, first),
    response(1150, "function_call", { call_id: "b" }),
    response(2100, "custom_tool_call_output", { call_id: "a" }),
    tokenCount(2600, first, first),
    response(3100, "function_call_output", { call_id: "b" }),
    record(4100, second, tokens(125_000, 100_000, 300, 190, 30)),
    record(5100, third, tokens(185_000, 133_000, 350, 200, 60)),
    event(5200, "task_complete", { ...turn, duration_ms: 5200, time_to_first_token_ms: 980 })
  ].join(""));

  const snapshot = await new RolloutParser(filename).refresh();
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.tokens.totalTokens, 185_350);
  assert.equal(snapshot.tokens.outputTokens, 350);
  assert.equal(snapshot.tokens.reasoningOutputTokens, 200);
  assert.equal(snapshot.tokens.visibleOutputTokens, 150);
  assert.deepEqual(snapshot.speed.recentStepTps, [100, 200, 50]);
  assert.equal(snapshot.speed.lastTurnToolMs, 2000);
  assert.equal(snapshot.speed.lastTurnLlmMs, 3200);
  assert.equal(snapshot.speed.latestTtftMs, 980);
  assert.equal(snapshot.context.usedTokens, 60_000);
  assert.equal(snapshot.context.deltaTokens, -15_000);
  assert.equal(snapshot.context.compactionCount, 1);
  assert.equal(snapshot.context.lastCompactionSavedTokens, 15_000);
  assert.deepEqual(snapshot.context.recentPercents, [50, 75, 60]);
  assert.ok(Math.abs(snapshot.cache.weightedHitRate! - 133_000 / 185_000 * 100) < 1e-9);
  assert.equal(snapshot.cache.cacheWriteTokens, 60);
  assert.equal(snapshot.cache.dropAlert?.dropPoints, 25);
  assert.deepEqual(snapshot.rateLimits, {
    planType: "plus", primary: { usedPercent: 13, windowMinutes: 300, resetsAtSec: 1234 }, secondary: null
  });
});

test("token_count alone reports latest input and returns null for zero-input cache rates", async t => {
  const filename = path.join(await fixture(t), "rollout-legacy.jsonl");
  const empty = tokens(0, 0, 4, 2);
  const step = tokens(1000, 600, 6, 3);
  const count = (ms: number, last: ReturnType<typeof tokens>, total: ReturnType<typeof tokens>) =>
    event(ms, "token_count", { info: { last_token_usage: last, total_token_usage: total } });
  await writeFile(filename, count(1, empty, empty));
  const parser = new RolloutParser(filename);
  const initial = await parser.refresh();
  assert.equal(initial.cache.weightedHitRate, null);
  assert.equal(initial.cache.latestStepHitRate, null);
  assert.equal(initial.tokens.visibleOutputTokens, 2);
  await appendFile(filename, count(2, step, tokens(1000, 600, 10, 5)));
  const next = await parser.refresh();
  assert.equal(next.cache.weightedHitRate, 60);
  assert.equal(next.context.usedTokens, 1000);
  assert.equal(next.tokens.totalTokens, 1010);
});

test("collector falls back to the newest rollout by mtime and only emits changed snapshots", async t => {
  const codexHome = await fixture(t);
  const service = new TelemetryCollectorService({ codexHome, discoveryIntervalMs: 0 });
  const statuses: string[] = [];
  const unsubscribe = service.subscribe(snapshot => { statuses.push(snapshot.sessionId ?? snapshot.status); });
  assert.equal((await service.refresh()).status, "waiting_codex");
  assert.equal((await service.refresh()).status, "waiting_codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "01", "01");
  await mkdir(sessionDir, { recursive: true });
  const older = path.join(sessionDir, "rollout-z.jsonl");
  await writeFile(older, row(1, "session_meta", { id: "older" }));
  await utimes(older, new Date(epoch), new Date(epoch));
  await writeFile(path.join(sessionDir, "rollout-a.jsonl"), row(2, "session_meta", { id: "newer" }));
  assert.equal((await service.refresh()).sessionId, "newer");
  await service.refresh();
  unsubscribe();
  assert.deepEqual(statuses, ["waiting_codex", "newer"]);
});

test("SQLite discovery prioritizes the newest non-archived thread", async t => {
  const sqlite = await import("node:sqlite").catch(() => null);
  if (!sqlite) return t.skip("node:sqlite unavailable");
  const codexHome = await fixture(t);
  const sessions = path.join(codexHome, "sessions");
  await mkdir(sessions);
  const active = path.join(sessions, "rollout-active.jsonl");
  const archived = path.join(sessions, "rollout-archived.jsonl");
  await writeFile(active, row(1, "session_meta", { id: "active" }));
  await utimes(active, new Date(epoch), new Date(epoch));
  await writeFile(archived, row(2, "session_meta", { id: "archived" }));
  const db = new sqlite.DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE threads (rollout_path TEXT, updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER)");
    const insert = db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?)");
    insert.run(active, 1, 1000, 0);
    insert.run(archived, 2, 2000, 1);
    insert.run(path.join(sessions, "rollout-missing.jsonl"), 3, 3000, 0);
  } finally {
    db.close();
  }
  assert.equal((await new TelemetryCollectorService({ codexHome }).refresh()).sessionId, "active");
});

