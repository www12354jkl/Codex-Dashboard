export interface SpeedMetrics {
  /** Effective throughput of the latest LLM step (output_tokens / llm_seconds, excluding tool execution). */
  latestStepTps: number | null;
  /** Mean effective throughput across recent LLM steps. */
  avgRecentTps: number | null;
  /** Official time-to-first-token in milliseconds from task_complete when available. */
  latestTtftMs: number | null;
  /** Model round-trip wall time in the most recent turn (ms). */
  lastTurnLlmMs: number;
  /** Tool execution time (exec / MCP / etc.) in the most recent turn (ms), excluded from TPS. */
  lastTurnToolMs: number;
  /** Up to 7 recent per-step throughput values (tok/s) for sparkbar rendering. */
  recentStepTps: number[];
  /** Human-readable explanation of current speed metric semantics. */
  note: string;
}

export interface ContextMetrics {
  /** Snapshot input_tokens of the latest LLM call (NOT cumulative session input). */
  usedTokens: number;
  /** Effective usable model context window (e.g. 475000 for gpt-6.2-sol). */
  windowTokens: number;
  /** Percentage of windowTokens currently occupied (0..100). */
  percent: number;
  /** Token delta compared with the immediately preceding step. */
  deltaTokens: number | null;
  /** Count of detected compaction drops within this session. */
  compactionCount: number;
  /** Tokens freed by the most recent detected compaction, if any. */
  lastCompactionSavedTokens: number | null;
  /** Up to 7 recent context percentage snapshots (0..100). */
  recentPercents: number[];
}

export interface CacheDropAlert {
  previousAvg: number;
  current: number;
  dropPoints: number;
  reason: string;
}

export interface CacheMetrics {
  /** Weighted cache hit rate: sum(cached_input_tokens) / sum(input_tokens) * 100, or null if zero input. */
  weightedHitRate: number | null;
  /** Latest single-step cache hit rate (0..100), or null if zero input. */
  latestStepHitRate: number | null;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  cacheWriteTokens: number;
  /** Up to 7 recent single-step cache hit rates (0..100). */
  recentStepHitRates: number[];
  /** Populated when hit rate drops significantly below session baseline after cold start. */
  dropAlert: CacheDropAlert | null;
}

export interface TokenMetrics {
  /** Cumulative session total tokens (inputTokens + outputTokens; reasoning is NOT double-counted). */
  totalTokens: number;
  inputTokens: number;
  /** Cumulative output tokens (already includes reasoningOutputTokens in Codex rollouts). */
  outputTokens: number;
  reasoningOutputTokens: number;
  /** Non-reasoning visible output tokens = max(0, outputTokens - reasoningOutputTokens). */
  visibleOutputTokens: number;
  /** Share of reasoning tokens within outputTokens (0..100). */
  reasoningSharePercent: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAtSec: number | null;
}

export interface RateLimitMetrics {
  planType: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
}

export type SessionStatus = "streaming" | "idle" | "waiting_codex" | "no_data";

export interface TelemetrySnapshot {
  sessionId: string | null;
  rolloutPath: string | null;
  model: string;
  reasoningEffort: string;
  cwd: string | null;
  updatedAtMs: number;
  status: SessionStatus;
  speed: SpeedMetrics;
  context: ContextMetrics;
  cache: CacheMetrics;
  tokens: TokenMetrics;
  rateLimits: RateLimitMetrics;
}

export interface HitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ThemePreference = "system" | "light" | "dark";
export type UpdateChannel = "auto" | "git" | "release";
export type AlignmentMode = "auto" | "manual";

export interface OverlayConfig {
  theme: ThemePreference;
  /** GitHub repository slug such as "owner/codex-dashboard" or full HTTPS URL. */
  repo: string;
  updateChannel: UpdateChannel;
  alignmentMode: AlignmentMode;
  /** Horizontal offset in DIP pixels from Codex window bottom-center anchor. */
  offsetX: number;
  /** Vertical offset in DIP pixels upward from Codex window bottom edge. */
  offsetY: number;
  onlyWhenCodexFocused: boolean;
  hideOnApprovalDialog: boolean;
}

export const OFFICIAL_GITHUB_REPO = "www12354jkl/Codex-Dashboard";
export const OFFICIAL_GITHUB_REPO_URL = "https://github.com/www12354jkl/Codex-Dashboard.git";

export const DEFAULT_OVERLAY_CONFIG: OverlayConfig = {
  theme: "system",
  repo: OFFICIAL_GITHUB_REPO,
  updateChannel: "auto",
  alignmentMode: "auto",
  offsetX: 0,
  offsetY: 0,
  onlyWhenCodexFocused: true,
  hideOnApprovalDialog: true
};

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "up_to_date"
  | "downloading"
  | "verifying"
  | "applying"
  | "applied_restart_required"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  mode: "git" | "release" | "unconfigured";
  currentVersion: string;
  latestVersion: string | null;
  repo: string;
  releaseNotes: string[];
  checkedAtMs: number | null;
  canApply: boolean;
  message: string;
  error?: string;
}

export interface UpdateProgress {
  percent: number;
  stage: "fetching" | "downloading" | "verifying" | "staging" | "applying" | "done" | "error";
  message: string;
}

export interface OverlayRuntimeState {
  attachedToCodex: boolean;
  alignmentSource: "uia" | "dwm" | "standalone" | "hidden";
  codexWindowTitle: string | null;
}

export const IPC_CHANNELS = {
  GET_SNAPSHOT: "codex-hud:get-snapshot",
  ON_SNAPSHOT: "codex-hud:on-snapshot",
  GET_CONFIG: "codex-hud:get-config",
  UPDATE_CONFIG: "codex-hud:update-config",
  ON_CONFIG: "codex-hud:on-config",
  GET_RUNTIME_STATE: "codex-hud:get-runtime-state",
  ON_RUNTIME_STATE: "codex-hud:on-runtime-state",
  REPORT_HIT_RECTS: "codex-hud:report-hit-rects",
  CHECK_UPDATES: "codex-hud:check-updates",
  APPLY_UPDATE: "codex-hud:apply-update",
  RESTART_APP: "codex-hud:restart-app",
  ON_UPDATE_STATUS: "codex-hud:on-update-status",
  ON_UPDATE_PROGRESS: "codex-hud:on-update-progress"
} as const;

export interface CodexHudApi {
  getSnapshot(): Promise<TelemetrySnapshot>;
  onSnapshot(listener: (snapshot: TelemetrySnapshot) => void): () => void;
  getConfig(): Promise<OverlayConfig>;
  updateConfig(patch: Partial<OverlayConfig>): Promise<OverlayConfig>;
  onConfig(listener: (config: OverlayConfig) => void): () => void;
  getRuntimeState(): Promise<OverlayRuntimeState>;
  onRuntimeState(listener: (state: OverlayRuntimeState) => void): () => void;
  reportHitRects(rects: HitRect[]): void;
  checkForUpdates(repoOverride?: string): Promise<UpdateStatus>;
  applyUpdate(): Promise<UpdateStatus>;
  restartApp(): Promise<void>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void;
}

declare global {
  interface Window {
    codexHud?: CodexHudApi;
  }
}
