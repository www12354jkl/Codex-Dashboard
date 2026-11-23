import { open } from "node:fs/promises";
import { createEmptySnapshot } from "../shared/mock.js";
import type { RateLimitWindow, TelemetrySnapshot } from "../shared/types.js";

type Row = Record<string, unknown>;
const object = (v: unknown): Row | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : undefined;
const text = (v: unknown) => typeof v === "string" && v.length > 0 ? v : undefined;
const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
const percent = (part: number, whole: number) => whole > 0 ? Math.min(100, part * 100 / whole) : 0;

function usage(value: unknown) {
  const row = object(value);
  const input = count(row?.input_tokens);
  const output = count(row?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return {
    input, output,
    cached: Math.min(input, count(row?.cached_input_tokens) ?? 0),
    written: count(row?.cache_write_input_tokens) ?? 0,
    reasoning: count(row?.reasoning_output_tokens) ?? 0,
    total: count(row?.total_tokens) ?? input + output
  };
}

type Usage = NonNullable<ReturnType<typeof usage>>;
const zero: Usage = { input: 0, output: 0, cached: 0, written: 0, reasoning: 0, total: 0 };

function add(a: Usage, b: Usage): Usage {
  return { input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached,
    written: a.written + b.written, reasoning: a.reasoning + b.reasoning, total: a.total + b.total };
}

function rateWindow(value: unknown): RateLimitWindow | null {
  const row = object(value);
  const used = row?.used_percent;
  const minutes = count(row?.window_minutes);
  if (typeof used !== "number" || !Number.isFinite(used) || minutes === undefined) return null;
  return { usedPercent: Math.max(0, Math.min(100, used)), windowMinutes: minutes, resetsAtSec: count(row?.resets_at) ?? null };
}

function pushRecent(values: number[], value: number): void {
  values.push(value);
  if (values.length > 7) values.shift();
}

function newTurn(id?: string, at?: number) {
  return { id, cursor: at, stepLlmMs: 0, llmMs: 0, toolMs: 0, calls: new Set<string>(), usage: zero };
}

export class RolloutParser {
  private state: TelemetrySnapshot;
  private offset = 0;
  private identity = "";
  private checkpoint = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private tailing?: Promise<TelemetrySnapshot>;
  private threadUsage = zero;
  private stepUsage = zero;
  private steps = 0;
  private legacySinceRecord = false;
  private recentInputs: number[] = [];
  private turn = newTurn();

  constructor(readonly rolloutPath: string) {
    this.state = this.initialSnapshot();
  }

  getSnapshot(): TelemetrySnapshot {
    return structuredClone(this.state);
  }

  refresh(): Promise<TelemetrySnapshot> {
    this.tailing ??= this.readAppends().finally(() => { this.tailing = undefined; });
    return this.tailing;
  }

  private initialSnapshot(): TelemetrySnapshot {
    return { ...createEmptySnapshot(), rolloutPath: this.rolloutPath, updatedAtMs: 0 };
  }

  private reset(): void {
    this.state = this.initialSnapshot();
    this.offset = 0;
    this.checkpoint = Buffer.alloc(0);
    this.fragments = [];
    this.threadUsage = zero;
    this.stepUsage = zero;
    this.steps = 0;
    this.legacySinceRecord = false;
    this.recentInputs = [];
    this.turn = newTurn();
  }

  private async readAppends(): Promise<TelemetrySnapshot> {
    const file = await open(this.rolloutPath, "r");
    try {
      const stat = await file.stat({ bigint: true });
      const identity = [stat.dev, stat.ino, stat.birthtimeNs].join(":");
      const end = Number(stat.size);
      if (identity !== this.identity || end < this.offset) this.reset();
      if (this.checkpoint.length) {
        const probe = Buffer.alloc(this.checkpoint.length);
        const { bytesRead } = await file.read(probe, 0, probe.length, this.offset - probe.length);
        if (bytesRead !== probe.length || !probe.equals(this.checkpoint)) this.reset();
      }
      this.identity = identity;
      if (this.offset >= end) return this.getSnapshot();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      while (this.offset < end) {
        const { bytesRead } = await file.read(chunk, 0, Math.min(chunk.length, end - this.offset), this.offset);
        if (!bytesRead) break;
        const bytes = chunk.subarray(0, bytesRead);
        this.consume(bytes);
        this.offset += bytesRead;
        this.checkpoint = Buffer.from(bytes.length >= 128
          ? bytes.subarray(-128) : Buffer.concat([this.checkpoint, bytes]).subarray(-128));
      }
      return this.getSnapshot();
    } finally {
      await file.close();
    }
  }

  private consume(bytes: Buffer): void {
    let start = 0;
    for (let newline = bytes.indexOf(10); newline !== -1; newline = bytes.indexOf(10, start)) {
      const part = bytes.subarray(start, newline);
      const line = this.fragments.length ? Buffer.concat([...this.fragments, part]) : part;
      this.fragments = [];
      this.readLine(line.toString("utf8"));
      start = newline + 1;
    }
    if (start < bytes.length) this.fragments.push(Buffer.from(bytes.subarray(start)));
  }

  private readLine(line: string): void {
    let row: Row | undefined;
    try {
      row = object(JSON.parse(line));
    } catch {
      return;
    }
    const payload = object(row?.payload);
    if (!payload) return;
    const parsedTime = Date.parse(text(row?.timestamp) ?? "");
    const at = Number.isFinite(parsedTime) ? parsedTime : undefined;
    const id = text(payload.turn_id);
    switch (row?.type) {
      case "session_meta":
        this.state.sessionId = text(payload.session_id) ?? text(payload.id) ?? this.state.sessionId;
        this.state.cwd = text(payload.cwd) ?? this.state.cwd;
        if (this.state.status === "no_data") this.state.status = "idle";
        break;
      case "turn_context":
        this.setTurnId(id, at);
        this.state.model = text(payload.model) ?? this.state.model;
        this.state.reasoningEffort = text(payload.effort) ?? this.state.reasoningEffort;
        this.state.cwd = text(payload.cwd) ?? this.state.cwd;
        break;
      case "event_msg":
        if (!this.readEvent(payload, at, id)) return;
        break;
      case "token_usage_record": {
        const step = usage(payload.usage);
        if (!step) return;
        this.state.sessionId ??= text(payload.session_id) ?? text(payload.thread_id) ?? null;
        if (!this.turn.id) this.turn.id = id;
        const total = usage(payload.thread_token_usage);
        // Modern records are per request, including requests that report zero new tokens.
        if (!total || this.newerUsage(total) || !this.legacySinceRecord) {
          this.recordStep(step, at, total, usage(payload.turn_token_usage), !id || this.turn.id === id);
        }
        this.legacySinceRecord = false;
        break;
      }
      case "response_item":
        if (!this.readResponse(payload, at)) return;
        break;
      default:
        return;
    }
    if (at !== undefined) this.state.updatedAtMs = Math.max(at, this.state.updatedAtMs);
  }

  private setTurnId(id: string | undefined, at: number | undefined): void {
    if (!id) return;
    if (this.turn.id && this.turn.id !== id) this.turn = newTurn(id, at);
    else this.turn.id = id;
  }

  private setWindow(value: unknown): void {
    const window = count(value);
    if (!window || window === this.state.context.windowTokens) return;
    this.state.context.windowTokens = window;
    this.state.context.percent = percent(this.state.context.usedTokens, window);
    this.state.context.recentPercents = this.recentInputs.map(input => percent(input, window));
  }

  private newerUsage(total: Usage): boolean {
    return total.total > this.threadUsage.total || total.input > this.threadUsage.input || total.output > this.threadUsage.output;
  }

  private readEvent(payload: Row, at: number | undefined, id: string | undefined): boolean {
    switch (payload.type) {
      case "task_started":
        this.turn = newTurn(id, at);
        this.state.status = "streaming";
        this.updateTurnTimes();
        this.setWindow(payload.model_context_window);
        return true;
      case "turn_aborted":
      case "task_complete": {
        if (id && this.turn.id && id !== this.turn.id) return false;
        this.advanceClock(at);
        if (payload.type === "task_complete") this.state.speed.latestTtftMs = count(payload.time_to_first_token_ms) ?? null;
        this.updateTurnTimes(count(payload.duration_ms));
        this.turn.calls.clear();
        this.state.status = "idle";
        return true;
      }
      case "token_count": {
        const limits = object(payload.rate_limits);
        if (limits) {
          this.state.rateLimits = {
            planType: text(limits.plan_type) ?? this.state.rateLimits.planType,
            primary: limits.primary === undefined ? this.state.rateLimits.primary : rateWindow(limits.primary),
            secondary: limits.secondary === undefined ? this.state.rateLimits.secondary : rateWindow(limits.secondary)
          };
        }
        const info = object(payload.info);
        this.setWindow(info?.model_context_window);
        const step = usage(info?.last_token_usage);
        const total = usage(info?.total_token_usage);
        if (step && (!total || this.newerUsage(total) || this.steps === 0)) {
          this.recordStep(step, at, total);
          this.legacySinceRecord = true;
        }
        return true;
      }
      default:
        return false;
    }
  }

  private readResponse(payload: Row, at: number | undefined): boolean {
    if (payload.type === "message" && payload.role === "user") {
      this.advanceClock(at);
      this.turn.stepLlmMs = 0;
      this.state.status = "streaming";
      this.updateTurnTimes();
      return true;
    }
    const callId = text(payload.call_id);
    if (!callId) return false;
    switch (payload.type) {
      case "custom_tool_call":
      case "function_call":
        this.advanceClock(at);
        this.turn.calls.add(callId);
        break;
      case "custom_tool_call_output":
      case "function_call_output":
        if (!this.turn.calls.has(callId)) return false;
        this.advanceClock(at);
        this.turn.calls.delete(callId);
        break;
      default:
        return false;
    }
    this.updateTurnTimes();
    return true;
  }

  private advanceClock(at: number | undefined): void {
    if (at === undefined) return;
    const elapsed = Math.max(0, at - (this.turn.cursor ?? at));
    this.turn.cursor = Math.max(at, this.turn.cursor ?? at);
    if (this.turn.calls.size) {
      this.turn.toolMs += elapsed;
    } else {
      this.turn.llmMs += elapsed;
      this.turn.stepLlmMs += elapsed;
    }
  }

  private updateTurnTimes(duration?: number): void {
    const speed = this.state.speed;
    speed.lastTurnToolMs = Math.min(duration ?? Infinity, this.turn.toolMs);
    speed.lastTurnLlmMs = duration === undefined ? this.turn.llmMs : duration - speed.lastTurnToolMs;
  }

  private recordStep(step: Usage, at: number | undefined, threadTotal?: Usage, turnTotal?: Usage, timed = true): void {
    const { speed, context, cache } = this.state;
    if (timed) {
      this.advanceClock(at);
      this.updateTurnTimes();
      const llmMs = this.turn.stepLlmMs;
      this.turn.stepLlmMs = 0;
      speed.latestStepTps = llmMs > 0 ? step.output * 1000 / llmMs : null;
      if (speed.latestStepTps !== null) {
        pushRecent(speed.recentStepTps, speed.latestStepTps);
        speed.avgRecentTps = speed.recentStepTps.reduce((a, b) => a + b, 0) / speed.recentStepTps.length;
      }
      speed.note = "单步输出吞吐，按响应与工具事件时间戳估算，剔除工具耗时";
      this.turn.usage = turnTotal ?? add(this.turn.usage, step);
    }

    context.deltaTokens = this.steps ? step.input - context.usedTokens : null;
    const saved = -(context.deltaTokens ?? 0);
    if (saved >= 15_000 && saved >= context.usedTokens * 0.2) {
      context.compactionCount++;
      context.lastCompactionSavedTokens = saved;
    }
    context.usedTokens = step.input;
    context.percent = percent(step.input, context.windowTokens);
    pushRecent(this.recentInputs, step.input);
    pushRecent(context.recentPercents, context.percent);

    const baseline = cache.weightedHitRate;
    const current = step.input > 0 ? percent(step.cached, step.input) : null;
    cache.latestStepHitRate = current;
    cache.dropAlert = this.steps >= 2 && baseline !== null && baseline >= 60 && current !== null
      && step.input >= 10_000 && baseline - current >= 25 - Number.EPSILON * 100
      ? { previousAvg: baseline, current, dropPoints: baseline - current, reason: "当前请求缓存命中率较此前加权基线下降" }
      : null;
    if (current !== null) pushRecent(cache.recentStepHitRates, current);
    this.stepUsage = add(this.stepUsage, step);
    cache.cachedInputTokens = this.stepUsage.cached;
    cache.uncachedInputTokens = this.stepUsage.input - this.stepUsage.cached;
    cache.cacheWriteTokens = this.stepUsage.written;
    cache.weightedHitRate = this.stepUsage.input ? percent(this.stepUsage.cached, this.stepUsage.input) : null;

    if (!threadTotal) this.threadUsage = add(this.threadUsage, step);
    else if (this.steps === 0 || this.newerUsage(threadTotal)) this.threadUsage = threadTotal;
    const total = this.threadUsage;
    this.state.tokens = {
      totalTokens: total.input + total.output,
      inputTokens: total.input,
      outputTokens: total.output,
      reasoningOutputTokens: total.reasoning,
      visibleOutputTokens: Math.max(0, total.output - total.reasoning),
      reasoningSharePercent: percent(total.reasoning, total.output)
    };
    this.steps++;
    if (this.state.status === "no_data") this.state.status = "idle";
  }
}

