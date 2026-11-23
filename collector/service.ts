import { homedir } from "node:os";
import path from "node:path";
import { createEmptySnapshot } from "../shared/mock.js";
import type { TelemetrySnapshot } from "../shared/types.js";
import { RolloutParser } from "./rolloutParser.js";
import { findLatestRollout } from "./sqliteIndex.js";

interface CollectorOptions {
  codexHome?: string;
  pollIntervalMs?: number;
  discoveryIntervalMs?: number;
}

type Subscriber = (snapshot: TelemetrySnapshot) => void;

export class TelemetryCollectorService {
  readonly codexHome: string;
  private readonly pollIntervalMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private snapshot = { ...createEmptySnapshot(), updatedAtMs: 0 };
  private parser?: RolloutParser;
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<TelemetrySnapshot>;
  private nextDiscovery = 0;

  constructor(options: CollectorOptions = {}) {
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.discoveryIntervalMs = options.discoveryIntervalMs ?? 5000;
  }

  getSnapshot(): TelemetrySnapshot {
    return structuredClone(this.snapshot);
  }

  subscribe(listener: Subscriber): () => void {
    this.subscribers.add(listener);
    return () => { this.subscribers.delete(listener); };
  }

  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  refresh(): Promise<TelemetrySnapshot> {
    this.pending ??= this.collect().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async collect(): Promise<TelemetrySnapshot> {
    if (Date.now() >= this.nextDiscovery) {
      const filename = await findLatestRollout(this.codexHome);
      if (filename !== this.parser?.rolloutPath) this.parser = filename ? new RolloutParser(filename) : undefined;
      this.nextDiscovery = Date.now() + this.discoveryIntervalMs;
    }
    if (!this.parser) return this.waiting();
    let snapshot: TelemetrySnapshot;
    try {
      snapshot = await this.parser.refresh();
    } catch (error) {
      this.nextDiscovery = 0;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.parser = undefined;
        return this.waiting();
      }
      throw error;
    }
    return this.publish(snapshot);
  }

  private waiting(): TelemetrySnapshot {
    return this.publish({ ...createEmptySnapshot(), updatedAtMs: 0, status: "waiting_codex" });
  }

  private publish(next: TelemetrySnapshot): TelemetrySnapshot {
    if (JSON.stringify(this.snapshot) !== JSON.stringify(next)) {
      this.snapshot = next;
      for (const listener of this.subscribers) {
        try {
          listener(this.getSnapshot());
        } catch (error) {
          console.error("Telemetry subscriber failed", error);
        }
      }
    }
    return this.getSnapshot();
  }
}

