export type HudLayoutMode = "expanded" | "icons" | "single" | "hidden";

export interface HudLayoutInput {
  /** Measured horizontal pixel clearance between the composer's left and right control clusters. */
  availableGapPx: number;
  /** Natural full width of the expanded 5-button strip in pixels. */
  expandedWidthPx: number;
  /** Natural width of the 5-button individual-icon strip in pixels. */
  iconsWidthPx: number;
  /** Width of the single-icon ultra-narrow fallback in pixels (default 28). */
  singleWidthPx?: number;
  /** Current layout mode for hysteresis stability. */
  currentMode: HudLayoutMode;
  /** Minimum breathing space on both sides combined so we shrink before touching native controls. */
  safetyMarginPx?: number;
  /** Hysteresis buffer to prevent rapid flicker when resizing right at a threshold. */
  hysteresisPx?: number;
}

/**
 * Progressive 3-tier collision-aware layout state machine:
 * 1. "expanded" — Full Style A 5-button strip with live text & progress bar
 * 2. "icons"    — Each metric button shrinks in-place into its own small icon (plus Update's existing icon)
 * 3. "single"   — Ultra-narrow safety fallback into 1 dashboard icon only when 5 icons would collide
 * 4. "hidden"   — Not enough room even for a single icon
 */
export function computeHudLayoutMode(input: HudLayoutInput): HudLayoutMode {
  const safety = Math.max(0, input.safetyMarginPx ?? 18);
  const hysteresis = Math.max(0, input.hysteresisPx ?? 20);
  const singleWidth = Math.max(24, input.singleWidthPx ?? 28);

  if (
    !Number.isFinite(input.availableGapPx) ||
    !Number.isFinite(input.expandedWidthPx) ||
    !Number.isFinite(input.iconsWidthPx) ||
    input.availableGapPx <= 0 ||
    input.expandedWidthPx <= 0 ||
    input.iconsWidthPx <= 0
  ) {
    return "hidden";
  }

  const singleMin = singleWidth + Math.min(8, safety);
  const iconsMin = Math.max(singleMin, input.iconsWidthPx + safety);
  const expandedMin = Math.max(iconsMin, input.expandedWidthPx + safety);

  const singleExpandMin = singleMin + Math.min(8, hysteresis);
  const iconsExpandMin = iconsMin + hysteresis;
  const expandedExpandMin = expandedMin + hysteresis;

  const gap = input.availableGapPx;

  // Immediate downward clamp so buttons never overlap native Composer controls
  if (gap < singleMin) return "hidden";
  if (gap < iconsMin) {
    if (input.currentMode === "hidden" && gap < singleExpandMin) return "hidden";
    return "single";
  }
  if (gap < expandedMin) {
    if (input.currentMode === "expanded" || input.currentMode === "icons") {
      return "icons";
    }
    if (gap >= iconsExpandMin) return "icons";
    if (input.currentMode === "hidden" && gap < singleExpandMin) return "hidden";
    return "single";
  }

  // gap >= expandedMin: stay expanded, or step upward only past hysteresis
  if (input.currentMode === "expanded") return "expanded";
  if (gap >= expandedExpandMin) return "expanded";
  if (input.currentMode === "icons" || gap >= iconsExpandMin) return "icons";
  if (input.currentMode === "hidden" && gap < singleExpandMin) return "hidden";
  return "single";
}

export interface CollapseInput {
  /** Measured horizontal pixel clearance between the composer's left and right control clusters. */
  availableGapPx: number;
  /** Natural full width of the expanded 5-button strip in pixels. */
  expandedWidthPx: number;
  /** Whether the widget is currently collapsed into the single compact icon. */
  currentCollapsed: boolean;
  /** Minimum breathing space on both sides combined so we collapse before touching native controls. */
  safetyMarginPx?: number;
  /** Hysteresis buffer to prevent rapid flicker when resizing right at the threshold. */
  hysteresisPx?: number;
}

/**
 * Legacy boolean helper kept for compatibility: determines whether the expanded strip
 * no longer fits cleanly inside the Composer footer gap.
 */
export function computeCollapseMode(input: CollapseInput): boolean {
  const safety = input.safetyMarginPx ?? 20;
  const hysteresis = input.hysteresisPx ?? 24;
  if (!Number.isFinite(input.availableGapPx) || !Number.isFinite(input.expandedWidthPx)) {
    return true;
  }
  const collapseBelow = input.expandedWidthPx + safety;
  const expandAbove = collapseBelow + hysteresis;
  if (input.currentCollapsed) {
    return input.availableGapPx < expandAbove;
  }
  return input.availableGapPx < collapseBelow;
}

export interface SurfaceSignals {
  /** Current page pathname + hash + search (lowercased or raw). */
  url: string;
  /** True when the composer footer contains a Codex workspace/permission control (e.g. 完全访问 / Full access / Agent / Sandbox). */
  hasCodexAccessControl: boolean;
  /** True when a Codex workspace/project/branch/worktree control is visible near the composer or header. */
  hasWorkspaceIndicator: boolean;
  /** True when the composer contains a model selector (e.g. GPT-6.2 Sol). */
  hasModelControl: boolean;
  /** True when the page explicitly indicates an ordinary Chat / ChatGPT conversation rather than a Codex task. */
  isOrdinaryChatSurface: boolean;
  /** True when live voice mode overlay is active. */
  isVoiceMode: boolean;
}

export interface SurfaceDecision {
  show: boolean;
  reason: string;
}

/**
 * Shows the dashboard ONLY on Codex coding/workspace task surfaces.
 * Automatically hides on ordinary Chat pages and live voice mode.
 */
export function classifyCodexSurface(signals: SurfaceSignals): SurfaceDecision {
  if (signals.isVoiceMode) {
    return { show: false, reason: "voice_mode" };
  }

  const lowerUrl = (signals.url || "").toLowerCase();
  const isCodexRoute =
    /\/(?:codex|local|worktree|threads|tasks)(?:\/|$|\?|#)/.test(lowerUrl) ||
    /codex/i.test(lowerUrl);

  // Explicit ordinary Chat page (e.g. chatgpt: conversation marker or ChatGPT placeholder) -> ALWAYS hide
  if (signals.isOrdinaryChatSurface) {
    return { show: false, reason: "ordinary_chat_page" };
  }

  // Strong positive evidence of Codex coding task composer
  if (signals.hasCodexAccessControl || signals.hasWorkspaceIndicator) {
    return { show: true, reason: "codex_composer_controls" };
  }

  // Fallback when on an explicit Codex route with a model selector
  if (isCodexRoute && signals.hasModelControl) {
    return { show: true, reason: "codex_route" };
  }

  return { show: false, reason: "non_codex_surface" };
}
