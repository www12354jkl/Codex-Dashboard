import type {
  OverlayConfig,
  OverlayRuntimeState,
  TelemetrySnapshot,
  UpdateStatus
} from "./types.js";
import { DEFAULT_OVERLAY_CONFIG } from "./types.js";

export function createEmptySnapshot(): TelemetrySnapshot {
  return {
    sessionId: null,
    rolloutPath: null,
    model: "gpt-6.2-sol",
    reasoningEffort: "high",
    cwd: null,
    updatedAtMs: Date.now(),
    status: "no_data",
    speed: {
      latestStepTps: null,
      avgRecentTps: null,
      latestTtftMs: null,
      lastTurnLlmMs: 0,
      lastTurnToolMs: 0,
      recentStepTps: [],
      note: "等待 Codex 会话写入本地日志"
    },
    context: {
      usedTokens: 0,
      windowTokens: 475000,
      percent: 0,
      deltaTokens: null,
      compactionCount: 0,
      lastCompactionSavedTokens: null,
      recentPercents: []
    },
    cache: {
      weightedHitRate: null,
      latestStepHitRate: null,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      cacheWriteTokens: 0,
      recentStepHitRates: [],
      dropAlert: null
    },
    tokens: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      visibleOutputTokens: 0,
      reasoningSharePercent: 0
    },
    rateLimits: {
      planType: null,
      primary: null,
      secondary: null
    }
  };
}

export function createPreviewMockSnapshot(): TelemetrySnapshot {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    sessionId: "preview-session",
    rolloutPath: null,
    model: "gpt-6.2-sol",
    reasoningEffort: "high",
    cwd: "d:\\workspace\\plugin\\codex-dashboard",
    updatedAtMs: Date.now(),
    status: "streaming",
    speed: {
      latestStepTps: 48.6,
      avgRecentTps: 44.3,
      latestTtftMs: 1180,
      lastTurnLlmMs: 6800,
      lastTurnToolMs: 3100,
      recentStepTps: [38.2, 41.5, 40.1, 45.8, 43.9, 47.4, 48.6],
      note: "单步有效吞吐（已剔除 exec/MCP 工具耗时）"
    },
    context: {
      usedTokens: 85400,
      windowTokens: 475000,
      percent: 17.98,
      deltaTokens: 4200,
      compactionCount: 0,
      lastCompactionSavedTokens: null,
      recentPercents: [8, 10, 12, 14, 15, 17, 18]
    },
    cache: {
      weightedHitRate: 94.2,
      latestStepHitRate: 96.1,
      cachedInputTokens: 130100,
      uncachedInputTokens: 8000,
      cacheWriteTokens: 0,
      recentStepHitRates: [52, 88, 92, 93, 95, 94, 96],
      dropAlert: null
    },
    tokens: {
      totalTokens: 142800,
      inputTokens: 138100,
      outputTokens: 4700,
      reasoningOutputTokens: 1900,
      visibleOutputTokens: 2800,
      reasoningSharePercent: 40.4
    },
    rateLimits: {
      planType: "plus",
      primary: {
        usedPercent: 10,
        windowMinutes: 300,
        resetsAtSec: nowSec + 8280
      },
      secondary: {
        usedPercent: 8,
        windowMinutes: 10080,
        resetsAtSec: nowSec + 518400
      }
    }
  };
}

export function createDefaultUpdateStatus(
  currentVersion: string,
  config: OverlayConfig = DEFAULT_OVERLAY_CONFIG
): UpdateStatus {
  const repo = config.repo.trim();
  return {
    state: "idle",
    mode: repo ? "release" : "unconfigured",
    currentVersion,
    latestVersion: null,
    repo,
    releaseNotes: [],
    checkedAtMs: null,
    canApply: false,
    message: repo
      ? `准备检查 ${repo} 的远程更新`
      : "尚未配置 GitHub 远程仓库（填写 owner/repo 或关联 git origin 后即可检查更新）"
  };
}

export function createInitialRuntimeState(): OverlayRuntimeState {
  return {
    attachedToCodex: false,
    alignmentSource: "standalone",
    codexWindowTitle: null
  };
}
