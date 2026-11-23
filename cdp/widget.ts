import {
  DEFAULT_OVERLAY_CONFIG,
  OFFICIAL_GITHUB_REPO,
  type OverlayConfig,
  type TelemetrySnapshot,
  type ThemePreference,
  type UpdateProgress,
  type UpdateStatus
} from "../shared/types.js";
import { createDefaultUpdateStatus, createEmptySnapshot } from "../shared/mock.js";
import {
  CDP_BINDING_NAME,
  CDP_RECEIVE_FN,
  type CdpHostEvent,
  type CdpWidgetMessage
} from "./protocol.js";
import { classifyCodexSurface, computeHudLayoutMode, type HudLayoutMode, type SurfaceSignals } from "./layoutMath.js";

type PanelKey = "speed" | "ctx" | "cache" | "tokens" | "update";

interface BridgeWindow extends Window {
  [CDP_BINDING_NAME]?: (raw: string) => void;
  [CDP_RECEIVE_FN]?: (event: CdpHostEvent) => void;
  __codexHudTeardown?: () => void;
}

const HOST_ID = "codex-dashboard-cdp-host";
const THREAD_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const CODEX_ACCESS_RE =
  /\b(?:full\s+access|default\s+permissions?|workspace\s+write|read[- ]?only|agent|auto|sandbox|worktree|local|cloud)\b|完全访问|完全存取|默认权限|沙箱|自动批准/i;
const LEFT_CONTROL_RE =
  /\b(?:full\s+access|default\s+permissions?|workspace\s+write|read[- ]?only|agent|auto|attach|sandbox|worktree|local|cloud)\b|^\s*\+\s*$|完全访问|完全存取|默认权限|沙箱|自动批准|添加|新增/i;
const RIGHT_CONTROL_RE =
  /\b(?:gpt|sol(?=\b|[-\d])|o[34]\b|model|voice|mic|microphone|high|medium|low|xhigh|max|ultra)\b|模型|语音|語音|麦克风|麥克風/i;
const CODEX_PLACEHOLDER_RE = /codex|工作区|代码|任务|ask\s+codex|work\s+with\s+codex/i;
const ORDINARY_CHAT_PLACEHOLDER_RE = /询问任何问题|给\s*chatgpt\s*发消息|ask\s+anything|message\s+chatgpt/i;
const VOICE_OVERLAY_RE = /结束语音|end\s+voice|live\s+voice/i;
const INACTIVE_SHELL_SELECTOR = '[data-app-shell-active-page="false"], [aria-hidden="true"], [inert]';
const SIDEBAR_SELECTOR = 'nav, aside, [role="navigation"], [role="complementary"]';

/* ============================================================
   SHADOW DOM STYLES (STYLE A NATIVE HAIRLINE + COLLAPSED ICON)
   ============================================================ */
const WIDGET_CSS = `
:host {
  all: initial;
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483000;
  pointer-events: none;
  font-family: "Segoe UI Variable Text", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  -webkit-font-smoothing: antialiased;
}

.root {
  --bg-elevated: #ffffff;
  --bg-subtle: #f5f5f5;
  --bg-pill: rgba(0, 0, 0, 0.045);
  --bg-pill-hover: rgba(0, 0, 0, 0.075);
  --bg-pill-active: rgba(0, 0, 0, 0.095);
  --border-hairline: rgba(0, 0, 0, 0.09);
  --border-strong: rgba(0, 0, 0, 0.16);
  --border-subtle: rgba(0, 0, 0, 0.055);
  --ink-primary: #161616;
  --ink-secondary: #5c5c62;
  --ink-muted: #95959e;

  --ctx-ok: #2563eb;
  --ctx-ok-track: rgba(37, 99, 235, 0.16);
  --ctx-ok-bar-hist: rgba(37, 99, 235, 0.36);
  --ctx-warn: #d97706;
  --ctx-warn-track: rgba(217, 119, 6, 0.18);
  --ctx-danger: #dc2626;
  --ctx-danger-track: rgba(220, 38, 38, 0.18);

  --sem-ok: #147a4c;
  --sem-ok-soft: rgba(20, 122, 76, 0.10);
  --sem-warn: #b5620b;
  --sem-warn-soft: rgba(181, 98, 11, 0.12);
  --sem-danger: #c2312a;
  --sem-danger-soft: rgba(194, 49, 42, 0.11);
  --sem-info: #2563eb;
  --sem-info-soft: rgba(37, 99, 235, 0.10);
  --sem-reasoning: #6c4eb6;
  --shadow-popover: 0 14px 34px rgba(0, 0, 0, 0.13);
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);

  color: var(--ink-primary);
  font-family: "Segoe UI Variable Text", "PingFang SC", "Microsoft YaHei UI", sans-serif;
  user-select: none;
}

.root[data-theme="dark"] {
  --bg-elevated: #232328;
  --bg-subtle: #2b2b31;
  --bg-pill: rgba(255, 255, 255, 0.08);
  --bg-pill-hover: rgba(255, 255, 255, 0.12);
  --bg-pill-active: rgba(255, 255, 255, 0.16);
  --border-hairline: rgba(255, 255, 255, 0.10);
  --border-strong: rgba(255, 255, 255, 0.19);
  --border-subtle: rgba(255, 255, 255, 0.07);
  --ink-primary: #ededf0;
  --ink-secondary: #a2a2ab;
  --ink-muted: #767680;

  --ctx-ok: #60a5fa;
  --ctx-ok-track: rgba(96, 165, 250, 0.22);
  --ctx-ok-bar-hist: rgba(96, 165, 250, 0.42);
  --ctx-warn: #f59e0b;
  --ctx-warn-track: rgba(245, 158, 11, 0.23);
  --ctx-danger: #f87171;
  --ctx-danger-track: rgba(248, 113, 113, 0.23);

  --sem-ok: #49c98c;
  --sem-ok-soft: rgba(73, 201, 140, 0.15);
  --sem-warn: #eba246;
  --sem-warn-soft: rgba(235, 162, 70, 0.16);
  --sem-danger: #f06d66;
  --sem-danger-soft: rgba(240, 109, 102, 0.16);
  --sem-info: #60a5fa;
  --sem-info-soft: rgba(96, 165, 250, 0.16);
  --sem-reasoning: #a98df0;
  --shadow-popover: 0 18px 46px rgba(0, 0, 0, 0.58);
}

*, *::before, *::after {
  box-sizing: border-box;
}

.mono {
  font-family: "Cascadia Mono", "JetBrains Mono", Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

/* Anchored inline anchor positioned directly into the Composer footer gap */
.anchor-box {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
  will-change: transform;
}

.anchor-box[hidden] {
  display: none !important;
}

/* Style A 5-button strip (supports "expanded" text mode and "icons" per-button compact mode) */
.hud-group {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px 3px;
  border-radius: 9px;
  background: transparent;
}

.hud-group[data-layout="icons"] {
  gap: 2px;
}

.hud-group[hidden] {
  display: none !important;
}

.hud-full {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.hud-icon {
  display: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.hud-group[data-layout="icons"] .hud-full,
.hud-group[data-layout="icons"] .hud-sep {
  display: none;
}

.hud-group[data-layout="icons"] .hud-icon {
  display: inline-flex;
}

/* Ultra-narrow single-icon fallback (shown only when even 5 individual icons would collide) */
.compact-btn {
  pointer-events: auto;
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ink-secondary);
  min-inline-size: 28px;
  min-block-size: 28px;
  border-radius: 8px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  position: relative;
  cursor: pointer;
}

.compact-btn[hidden] {
  display: none !important;
}

.compact-btn:focus-visible,
.hud-btn:focus-visible {
  outline: 2px solid var(--sem-info);
  outline-offset: 2px;
}

@media (hover: hover) {
  .compact-btn:hover {
    background: var(--bg-pill);
    color: var(--ink-primary);
  }
}

.compact-btn[data-open="true"] {
  background: var(--bg-pill-active);
  color: var(--ink-primary);
}

.compact-btn:active {
  transform: scale(0.95);
}

.compact-status-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--sem-ok);
  box-shadow: 0 0 0 1.5px var(--bg-elevated);
}

.compact-status-dot.is-warn   { background: var(--ctx-warn); }
.compact-status-dot.is-danger { background: var(--sem-danger); }
.compact-status-dot.is-info   { background: var(--sem-info); }
.compact-status-dot.is-idle   { background: var(--ink-muted); }

.hud-btn {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--ink-secondary);
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  min-inline-size: 26px;
  min-block-size: 28px;
  padding: 0 7px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  position: relative;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.hud-group[data-layout="icons"] .hud-btn {
  min-inline-size: 26px;
  min-block-size: 26px;
  padding: 0;
  gap: 0;
  border-radius: 7px;
}

@media (hover: hover) {
  .hud-btn:hover {
    background: var(--bg-pill);
    color: var(--ink-primary);
  }
}

.hud-btn[data-open="true"] {
  background: var(--bg-pill-active);
  color: var(--ink-primary);
}

.hud-btn:active {
  transform: scale(0.97);
}

.hud-btn-icon {
  padding: 0 6px;
  position: relative;
  color: var(--ink-secondary);
}

@media (hover: hover) {
  .hud-btn-icon:hover {
    color: var(--ink-primary);
  }
}

.hud-btn-icon[data-open="true"] {
  color: var(--ink-primary);
}

/* Per-button corner status dot in compact icon mode */
.icon-corner-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--ink-muted);
  box-shadow: 0 0 0 1.5px var(--bg-elevated);
  pointer-events: none;
}

.icon-corner-dot.is-hidden {
  display: none;
}

.icon-corner-dot.is-ok     { background: var(--sem-ok); }
.icon-corner-dot.is-warn   { background: var(--ctx-warn); }
.icon-corner-dot.is-danger { background: var(--sem-danger); }
.icon-corner-dot.is-idle   { background: var(--ink-muted); }

.root[data-status="streaming"] #speed-icon-dot::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 999px;
  border: 1.5px solid var(--sem-ok);
  animation: pulse-ring 1.3s ease-out infinite;
}

/* Live color-coded circular progress ring for Context icon */
.ctx-ring-track {
  stroke: var(--ctx-ok-track);
}
.ctx-ring-track.is-warn   { stroke: var(--ctx-warn-track); }
.ctx-ring-track.is-danger { stroke: var(--ctx-danger-track); }

.ctx-ring-fill {
  stroke: var(--ctx-ok);
}
.ctx-ring-fill.is-warn   { stroke: var(--ctx-warn); }
.ctx-ring-fill.is-danger { stroke: var(--ctx-danger); }

.hud-sep {
  width: 1px;
  height: 11px;
  background: var(--border-hairline);
  flex-shrink: 0;
  margin: 0 2px;
}

.hud-label {
  color: var(--ink-muted);
  font-size: 11px;
}

.hud-val {
  color: var(--ink-primary);
  font-weight: 500;
  letter-spacing: -0.02em;
}

.hud-val.is-ok     { color: var(--sem-ok); }
.hud-val.is-ctx-ok { color: var(--ctx-ok); }
.hud-val.is-warn   { color: var(--sem-warn); }
.hud-val.is-danger { color: var(--sem-danger); }

.live-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--ink-muted);
  flex-shrink: 0;
  position: relative;
}

.root[data-status="streaming"] .live-dot,
.root[data-status="idle"] .live-dot {
  background: var(--sem-ok);
}

.root[data-status="streaming"] .live-dot::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 999px;
  border: 1.5px solid var(--sem-ok);
  animation: pulse-ring 1.3s ease-out infinite;
}

.live-dot.is-warn   { background: var(--ctx-warn) !important; }
.live-dot.is-danger { background: var(--sem-danger) !important; }

@keyframes pulse-ring {
  0% { transform: scale(0.8); opacity: 0.85; }
  100% { transform: scale(2.1); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .root[data-status="streaming"] .live-dot::after,
  .root[data-status="streaming"] #speed-icon-dot::after { animation: none; }
}

@media (prefers-reduced-motion: no-preference) {
  .compact-btn,
  .hud-btn {
    transition: background 140ms ease, color 140ms ease, transform 120ms var(--ease-out-expo);
  }
  .mini-bar {
    transition: background-color 200ms ease;
  }
  .mini-bar-fill {
    transition: width 240ms var(--ease-out-expo), background-color 200ms ease;
  }
  .ctx-ring-track {
    transition: stroke 200ms ease;
  }
  .ctx-ring-fill {
    transition: stroke-dashoffset 240ms var(--ease-out-expo), stroke 200ms ease;
  }
}

/* Colored inline Context progress bar */
.mini-bar {
  width: 34px;
  height: 5px;
  border-radius: 999px;
  background: var(--ctx-ok-track);
  overflow: hidden;
  flex-shrink: 0;
}

.mini-bar.is-warn   { background: var(--ctx-warn-track); }
.mini-bar.is-danger { background: var(--ctx-danger-track); }

.mini-bar-fill {
  display: block;
  height: 100%;
  min-width: 3px;
  border-radius: 999px;
  background: var(--ctx-ok);
}

.mini-bar-fill.is-warn   { background: var(--ctx-warn); }
.mini-bar-fill.is-danger { background: var(--ctx-danger); }

.update-badge-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--sem-info);
  box-shadow: 0 0 0 1.5px var(--bg-elevated);
  opacity: 0;
  transform: scale(0.5);
  transition: opacity 160ms ease, transform 180ms var(--ease-out-expo);
}

.update-badge-dot.is-visible {
  opacity: 1;
  transform: scale(1);
}

/* ============================================================
   FLOATING POPOVER CARD (VIEWPORT-CLAMPED ABOVE TRIGGER)
   ============================================================ */
.popover-card {
  position: fixed;
  pointer-events: auto;
  width: min(320px, calc(100vw - 24px));
  max-height: min(470px, calc(100vh - 96px));
  overflow-x: hidden;
  overflow-y: auto;
  border: 1px solid var(--border-hairline);
  border-radius: 15px;
  background: var(--bg-elevated);
  color: var(--ink-primary);
  box-shadow: var(--shadow-popover);
  opacity: 0;
  transform: translateY(6px) scale(0.98);
  transition: opacity 160ms var(--ease-out-expo), transform 180ms var(--ease-out-expo);
  z-index: 2147483001;
}

.popover-card.is-open {
  opacity: 1;
  transform: translateY(0) scale(1);
}

.popover-card[hidden] {
  display: none !important;
}

/* Compact mode 5-tab switcher inside popover */
.compact-tabs {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 2px;
  padding: 6px 8px;
  background: var(--bg-subtle);
  border-bottom: 1px solid var(--border-subtle);
}

.compact-tabs[hidden] {
  display: none !important;
}

.compact-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--ink-secondary);
  font-family: inherit;
  font-size: 11px;
  font-weight: 500;
  padding: 5px 4px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}

.compact-tab:hover {
  color: var(--ink-primary);
}

.compact-tab[aria-selected="true"] {
  background: var(--bg-elevated);
  color: var(--ink-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.panel-view[hidden] {
  display: none !important;
}

.pop-head {
  padding: 11px 14px 9px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.pop-head-left {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.pop-title {
  font-size: 12.5px;
  font-weight: 600;
}

.pop-pill {
  font-size: 10.5px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--sem-ok-soft);
  color: var(--sem-ok);
  white-space: nowrap;
}

.pop-pill.is-info   { background: var(--sem-info-soft); color: var(--sem-info); }
.pop-pill.is-warn   { background: var(--sem-warn-soft); color: var(--sem-warn); }
.pop-pill.is-danger { background: var(--sem-danger-soft); color: var(--sem-danger); }

.pop-close {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--ink-muted);
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 10.5px;
  padding: 3px 6px;
  border-radius: 6px;
  cursor: pointer;
}

.pop-close:hover {
  background: var(--bg-pill);
  color: var(--ink-primary);
}

.pop-body {
  padding: 13px 14px;
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.pop-hero {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.pop-hero-main {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.hero-num {
  font-size: 23px;
  font-weight: 600;
  letter-spacing: -0.035em;
  line-height: 1;
}

.hero-unit {
  font-size: 12px;
  color: var(--ink-muted);
}

.hero-right {
  font-size: 11.5px;
  color: var(--ink-secondary);
  text-align: right;
}

.pop-banner {
  display: none;
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.45;
}
.pop-banner.is-visible { display: block; }
.pop-banner.is-danger  { background: var(--sem-danger-soft); color: var(--sem-danger); }
.pop-banner.is-warn    { background: var(--sem-warn-soft); color: var(--sem-warn); }
.pop-banner.is-info    { background: var(--sem-info-soft); color: var(--sem-info); }
.pop-banner.is-ok      { background: var(--sem-ok-soft); color: var(--sem-ok); }

.progress-track {
  width: 100%;
  height: 7px;
  border-radius: 999px;
  background: var(--bg-subtle);
  overflow: hidden;
  display: flex;
  gap: 1px;
  position: relative;
}

.progress-track-ctx {
  height: 8px;
  background: var(--ctx-ok-track);
}
.progress-track-ctx.is-warn   { background: var(--ctx-warn-track); }
.progress-track-ctx.is-danger { background: var(--ctx-danger-track); }

.ctx-threshold-mark {
  position: absolute;
  left: 80%;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--border-strong);
  pointer-events: none;
}

.seg-ctx {
  background: var(--ctx-ok);
  border-radius: 999px;
  min-width: 3px;
  transition: width 240ms var(--ease-out-expo), background-color 200ms ease;
}
.seg-ctx.is-warn   { background: var(--ctx-warn); }
.seg-ctx.is-danger { background: var(--ctx-danger); }

.seg-primary   { background: var(--ink-primary); transition: width 240ms var(--ease-out-expo); }
.seg-ok        { background: var(--sem-ok); transition: width 240ms var(--ease-out-expo); }
.seg-muted     { background: var(--border-strong); transition: width 240ms var(--ease-out-expo); }
.seg-warn      { background: var(--sem-warn); opacity: 0.82; }
.seg-reasoning { background: var(--sem-reasoning); transition: width 240ms var(--ease-out-expo); }
.seg-visible   { background: var(--sem-info); transition: width 240ms var(--ease-out-expo); }

.kv-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--ink-secondary);
  gap: 8px;
}

.kv-row strong {
  color: var(--ink-primary);
  font-weight: 500;
}

.chart-box {
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chart-caption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--ink-muted);
}

.bar-series {
  height: 36px;
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  align-items: end;
  gap: 5px;
}

.bar-col {
  background: var(--border-strong);
  border-radius: 3px 3px 2px 2px;
  min-height: 4px;
  transition: height 240ms var(--ease-out-expo), background 200ms ease;
}

.bar-col.is-latest     { background: var(--ink-primary); }
.bar-col.is-ctx-hist   { background: var(--ctx-ok-bar-hist); }
.bar-col.is-ctx-latest { background: var(--ctx-ok); }
.bar-col.is-ctx-warn   { background: var(--ctx-warn); }
.bar-col.is-ctx-danger { background: var(--ctx-danger); }
.bar-col.is-ok         { background: var(--sem-ok); }
.bar-col.is-warn       { background: var(--sem-warn); }
.bar-col.is-danger     { background: var(--sem-danger); }

.pop-footer {
  padding: 8px 14px;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-subtle);
  font-size: 11px;
  color: var(--ink-secondary);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.quota-block {
  padding: 9px 14px 11px;
  background: var(--bg-subtle);
  border-top: 1px solid var(--border-subtle);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.quota-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.quota-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--ink-secondary);
}

.legend-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 2px;
  margin-right: 4px;
}

.repo-fixed-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 6px 9px;
  font-size: 11.5px;
  color: var(--ink-secondary);
}

.repo-value {
  color: var(--ink-primary);
  font-family: "Cascadia Mono", Consolas, monospace;
  font-size: 11.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.update-notes {
  margin: 0;
  padding-left: 16px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-secondary);
  max-height: 82px;
  overflow-y: auto;
}

.update-progress-wrap {
  display: none;
  flex-direction: column;
  gap: 5px;
}
.update-progress-wrap.is-visible { display: flex; }

.action-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-primary, .btn-secondary {
  appearance: none;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  padding: 7px 11px;
  border-radius: 9px;
  cursor: pointer;
  flex: 1;
  transition: opacity 140ms ease, background 140ms ease;
}

.btn-primary {
  border: none;
  background: var(--ink-primary);
  color: var(--bg-elevated);
}
.btn-primary:hover:not(:disabled) { opacity: 0.88; }
.btn-primary:disabled { opacity: 0.42; cursor: not-allowed; }

.btn-secondary {
  border: 1px solid var(--border-hairline);
  background: var(--bg-subtle);
  color: var(--ink-primary);
}
.btn-secondary:hover:not(:disabled) { background: var(--bg-pill-hover); }
.btn-secondary:disabled { opacity: 0.42; cursor: not-allowed; }

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-subtle);
  font-size: 11.5px;
  color: var(--ink-secondary);
}

.seg-mini {
  display: inline-flex;
  background: var(--bg-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  padding: 2px;
  gap: 2px;
}

.seg-mini-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--ink-secondary);
  font-family: inherit;
  font-size: 11px;
  padding: 3px 7px;
  border-radius: 5px;
  cursor: pointer;
}

.seg-mini-btn[aria-pressed="true"] {
  background: var(--bg-elevated);
  color: var(--ink-primary);
  font-weight: 500;
}
`;

/* ============================================================
   STATIC SHADOW DOM TEMPLATE (NO DYNAMIC INTERPOLATION)
   ============================================================ */
const WIDGET_HTML = `
<div class="root" data-status="no_data" data-theme="light">
  <div id="anchor-box" class="anchor-box" hidden>
    <!-- Style A 5-button toolbar (expanded text strip -> per-button small icons when narrow) -->
    <div id="hud-group" class="hud-group" role="toolbar" focusgroup="toolbar wrap" data-layout="expanded" aria-label="Codex 实时指标工具栏">
      <button type="button" id="btn-speed" class="hud-btn" data-panel="speed" aria-expanded="false" aria-label="查看模型速度与 TTFT" title="模型速度：等待数据">
        <span class="hud-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path d="M2.5 11.4a5.8 5.8 0 1 1 11 0" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>
            <path d="M8 9.2l2.6-2.8" stroke="currentColor" stroke-width="1.45" stroke-linecap="round"/>
            <circle cx="8" cy="9.4" r="1.1" fill="currentColor"/>
          </svg>
          <span id="speed-icon-dot" class="icon-corner-dot is-idle"></span>
        </span>
        <span class="hud-full">
          <span id="live-dot" class="live-dot" aria-hidden="true"></span>
          <span id="hud-tps" class="hud-val mono">--</span>
          <span class="hud-label mono">t/s</span>
        </span>
      </button>
      <span class="hud-sep" aria-hidden="true"></span>
      <button type="button" id="btn-ctx" class="hud-btn" data-panel="ctx" aria-expanded="false" aria-label="查看上下文占用" title="上下文占用：0%">
        <span class="hud-icon" aria-hidden="true">
          <svg class="ctx-ring-svg" width="15" height="15" viewBox="0 0 16 16" fill="none">
            <circle id="hud-ctx-ring-track" class="ctx-ring-track" cx="8" cy="8" r="5.4" stroke-width="1.85"/>
            <circle id="hud-ctx-ring-fill" class="ctx-ring-fill" cx="8" cy="8" r="5.4" stroke-width="1.85" stroke-linecap="round" transform="rotate(-90 8 8)" stroke-dasharray="33.93" stroke-dashoffset="33.93"/>
          </svg>
        </span>
        <span class="hud-full">
          <span class="hud-label">Ctx</span>
          <span id="hud-ctx-track" class="mini-bar" aria-hidden="true">
            <span id="hud-ctx-bar" class="mini-bar-fill" style="width:0%"></span>
          </span>
          <span id="hud-ctx-pct" class="hud-val mono is-ctx-ok">0%</span>
        </span>
      </button>
      <span class="hud-sep" aria-hidden="true"></span>
      <button type="button" id="btn-cache" class="hud-btn" data-panel="cache" aria-expanded="false" aria-label="查看缓存命中率" title="缓存命中率：等待数据">
        <span class="hud-icon" aria-hidden="true">
          <svg width="14.5" height="14.5" viewBox="0 0 16 16" fill="none">
            <ellipse cx="8" cy="4.2" rx="4.7" ry="1.85" stroke="currentColor" stroke-width="1.4"/>
            <path d="M3.3 4.2v7.6c0 1.02 2.1 1.85 4.7 1.85s4.7-.83 4.7-1.85V4.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            <path d="M3.3 8c0 1.02 2.1 1.85 4.7 1.85s4.7-.83 4.7-1.85" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
          </svg>
          <span id="cache-icon-dot" class="icon-corner-dot is-hidden"></span>
        </span>
        <span class="hud-full">
          <span class="hud-label">Cache</span>
          <span id="hud-cache-pct" class="hud-val mono">--</span>
        </span>
      </button>
      <span class="hud-sep" aria-hidden="true"></span>
      <button type="button" id="btn-tokens" class="hud-btn" data-panel="tokens" aria-expanded="false" aria-label="查看 Token 消耗与配额" title="Token 消耗：0">
        <span class="hud-icon" aria-hidden="true">
          <svg width="14.5" height="14.5" viewBox="0 0 16 16" fill="none">
            <circle cx="6.3" cy="9.4" r="3.9" stroke="currentColor" stroke-width="1.4"/>
            <path d="M6.0 5.5A3.9 3.9 0 1 1 10.1 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
            <path d="M6.3 7.8v3.2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/>
          </svg>
        </span>
        <span class="hud-full">
          <span id="hud-tokens" class="hud-val mono">0</span>
          <span class="hud-label">tok</span>
        </span>
      </button>
      <span class="hud-sep" aria-hidden="true"></span>
      <button type="button" id="btn-update" class="hud-btn hud-btn-icon" data-panel="update" aria-expanded="false" aria-label="检查更新与设置" title="检查更新与设置">
        <svg width="13.5" height="13.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M13.2 8a5.2 5.2 0 1 1-1.35-3.5M13.2 2.8v2.5h-2.5" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span id="update-dot" class="update-badge-dot" aria-hidden="true"></span>
      </button>
    </div>

    <!-- Ultra-narrow single-icon fallback (only if even 5 small icons cannot fit without overlapping) -->
    <button type="button" id="btn-compact" class="compact-btn" hidden aria-expanded="false" aria-label="展开 Codex 实时仪表盘">
      <svg width="14.5" height="14.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2.4" y="2.4" width="4.6" height="4.6" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
        <rect x="9" y="2.4" width="4.6" height="4.6" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
        <rect x="2.4" y="9" width="4.6" height="4.6" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
        <rect x="9" y="9" width="4.6" height="4.6" rx="1.2" stroke="currentColor" stroke-width="1.4"/>
      </svg>
      <span id="compact-dot" class="compact-status-dot is-idle" aria-hidden="true"></span>
    </button>
  </div>

  <!-- Shared viewport-clamped popover (individual view in expanded mode, 5-tab switcher in compact icon mode) -->
  <div id="popover-card" class="popover-card" role="region" aria-label="Codex 指标详情" hidden>
    <div id="compact-tabs" class="compact-tabs" role="tablist" hidden>
      <button type="button" class="compact-tab" role="tab" data-tab="speed" aria-selected="true">速度</button>
      <button type="button" class="compact-tab" role="tab" data-tab="ctx" aria-selected="false">Ctx</button>
      <button type="button" class="compact-tab" role="tab" data-tab="cache" aria-selected="false">缓存</button>
      <button type="button" class="compact-tab" role="tab" data-tab="tokens" aria-selected="false">Token</button>
      <button type="button" class="compact-tab" role="tab" data-tab="update" aria-selected="false">更新</button>
    </div>

    <!-- Panel 1: Speed -->
    <section class="panel-view" data-view="speed">
      <div class="pop-head">
        <div class="pop-head-left">
          <span class="pop-title">模型速度</span>
          <span id="sp-pill" class="pop-pill">等待数据</span>
        </div>
        <button type="button" class="pop-close" data-close>ESC</button>
      </div>
      <div class="pop-body">
        <div class="pop-hero">
          <div class="pop-hero-main">
            <span id="sp-tps" class="hero-num mono">--</span>
            <span class="hero-unit mono">tok/s</span>
          </div>
          <div class="hero-right mono">TTFT <strong id="sp-ttft">--</strong></div>
        </div>
        <div class="chart-box">
          <div class="chart-caption">
            <span>最近 7 次请求吞吐趋势</span>
            <span id="sp-range" class="mono">--</span>
          </div>
          <div id="sp-bars" class="bar-series" aria-hidden="true"></div>
        </div>
        <div class="kv-list">
          <div class="kv-row">
            <span>耗时占比（模型 vs 工具）</span>
            <span class="mono"><strong id="sp-llm-sec">0.0s</strong> / <span id="sp-tool-sec">0.0s</span></span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <span id="sp-llm-bar" class="seg-primary" style="width:100%"></span>
            <span id="sp-tool-bar" class="seg-warn" style="width:0%"></span>
          </div>
          <div class="kv-row">
            <span><span class="legend-dot" style="background:var(--ink-primary)"></span>纯模型往返</span>
            <span><span class="legend-dot" style="background:var(--sem-warn)"></span>工具不计入 tok/s</span>
          </div>
        </div>
      </div>
      <div class="pop-footer">
        <span id="sp-note">单步有效吞吐（已剔除工具耗时）</span>
        <span id="sp-model" class="mono">gpt-6.2-sol</span>
      </div>
    </section>

    <!-- Panel 2: Context -->
    <section class="panel-view" data-view="ctx" hidden>
      <div class="pop-head">
        <div class="pop-head-left">
          <span class="pop-title">当前上下文快照</span>
          <span id="ctx-pill" class="pop-pill is-info">余量充足</span>
        </div>
        <button type="button" class="pop-close" data-close>ESC</button>
      </div>
      <div class="pop-body">
        <div id="ctx-banner" class="pop-banner"></div>
        <div class="pop-hero">
          <div class="pop-hero-main">
            <span id="ctx-pct" class="hero-num mono">0.0%</span>
            <span id="ctx-used" class="hero-unit mono">0 / 475k</span>
          </div>
          <div id="ctx-delta" class="hero-right mono">--</div>
        </div>
        <div id="ctx-track" class="progress-track progress-track-ctx" aria-hidden="true">
          <span id="ctx-bar" class="seg-ctx" style="width:0%"></span>
          <span class="ctx-threshold-mark" title="80% 建议压缩警戒线"></span>
        </div>
        <div class="chart-box">
          <div class="chart-caption">
            <span>最近 7 步上下文水位变化</span>
            <span id="ctx-compact-tag" class="mono">80% 处标有压缩线</span>
          </div>
          <div id="ctx-bars" class="bar-series" aria-hidden="true"></div>
        </div>
        <div class="kv-list">
          <div class="kv-row">
            <span>模型有效窗口</span>
            <strong id="ctx-window" class="mono">475,000 tokens</strong>
          </div>
          <div class="kv-row">
            <span>剩余可用空间</span>
            <strong id="ctx-remain" class="mono">475.0k tokens</strong>
          </div>
        </div>
      </div>
      <div class="pop-footer">
        <span>口径：最近一次请求 input_tokens（非累计）</span>
      </div>
    </section>

    <!-- Panel 3: Cache -->
    <section class="panel-view" data-view="cache" hidden>
      <div class="pop-head">
        <div class="pop-head-left">
          <span class="pop-title">Prompt 缓存命中率</span>
          <span id="ca-pill" class="pop-pill">等待数据</span>
        </div>
        <button type="button" class="pop-close" data-close>ESC</button>
      </div>
      <div class="pop-body">
        <div id="ca-banner" class="pop-banner"></div>
        <div class="pop-hero">
          <div class="pop-hero-main">
            <span id="ca-pct" class="hero-num mono">--</span>
            <span class="hero-unit">加权命中</span>
          </div>
          <div class="hero-right mono">写入 <strong id="ca-write">0</strong></div>
        </div>
        <div class="progress-track" aria-hidden="true">
          <span id="ca-hit-bar" class="seg-ok" style="width:0%"></span>
          <span id="ca-miss-bar" class="seg-muted" style="width:100%"></span>
        </div>
        <div class="chart-box">
          <div class="chart-caption">
            <span>最近 7 步单次命中率</span>
            <span id="ca-latest-step" class="mono">--</span>
          </div>
          <div id="ca-bars" class="bar-series" aria-hidden="true"></div>
        </div>
        <div class="kv-list">
          <div class="kv-row">
            <span><span class="legend-dot" style="background:var(--sem-ok)"></span>命中缓存 (cached)</span>
            <strong id="ca-cached" class="mono">0</strong>
          </div>
          <div class="kv-row">
            <span><span class="legend-dot" style="background:var(--border-strong)"></span>未命中输入 (uncached)</span>
            <strong id="ca-uncached" class="mono">0</strong>
          </div>
        </div>
      </div>
      <div class="pop-footer">
        <span>公式：Σcached_input_tokens / Σinput_tokens</span>
      </div>
    </section>

    <!-- Panel 4: Tokens & Quota -->
    <section class="panel-view" data-view="tokens" hidden>
      <div class="pop-head">
        <div class="pop-head-left">
          <span class="pop-title">Token 消耗与配额</span>
          <span class="pop-pill">已去重推理</span>
        </div>
        <button type="button" class="pop-close" data-close>ESC</button>
      </div>
      <div class="pop-body">
        <div class="pop-hero">
          <div class="pop-hero-main">
            <span id="tk-total" class="hero-num mono">0</span>
            <span class="hero-unit">总计</span>
          </div>
          <div id="tk-session" class="hero-right mono">本会话累计</div>
        </div>
        <div class="kv-list">
          <div class="kv-row">
            <span>总输入 (Input)</span>
            <strong id="tk-input" class="mono">0</strong>
          </div>
          <div class="kv-row">
            <span>总输出 (Output · 已含推理)</span>
            <strong id="tk-output" class="mono">0</strong>
          </div>
        </div>
        <div class="chart-box">
          <div class="chart-caption">
            <span>输出构成拆分（不重复计数）</span>
            <span id="tk-reas-pct" class="mono">推理占 0%</span>
          </div>
          <div class="progress-track" aria-hidden="true">
            <span id="tk-reas-bar" class="seg-reasoning" style="width:0%"></span>
            <span id="tk-vis-bar" class="seg-visible" style="width:100%"></span>
          </div>
          <div class="kv-row" style="font-size:11.5px">
            <span><span class="legend-dot" style="background:var(--sem-reasoning)"></span>推理 <strong id="tk-reas" class="mono">0</strong></span>
            <span><span class="legend-dot" style="background:var(--sem-info)"></span>可见输出 <strong id="tk-vis" class="mono">0</strong></span>
          </div>
        </div>
      </div>
      <div class="quota-block">
        <div class="quota-item">
          <div class="quota-row">
            <span>5h 额度窗口</span>
            <span id="quota-5h-text" class="mono">--</span>
          </div>
          <div class="progress-track">
            <span id="quota-5h-bar" class="seg-primary" style="width:0%"></span>
          </div>
        </div>
        <div class="quota-item">
          <div class="quota-row">
            <span>7d 额度窗口</span>
            <span id="quota-7d-text" class="mono">--</span>
          </div>
          <div class="progress-track">
            <span id="quota-7d-bar" class="seg-primary" style="width:0%"></span>
          </div>
        </div>
      </div>
    </section>

    <!-- Panel 5: Update & Theme -->
    <section class="panel-view" data-view="update" hidden>
      <div class="pop-head">
        <div class="pop-head-left">
          <span class="pop-title">检查更新与设置</span>
          <span id="upd-pill" class="pop-pill is-info">未检查</span>
        </div>
        <button type="button" class="pop-close" data-close>ESC</button>
      </div>
      <div class="pop-body">
        <div class="kv-list">
          <div class="kv-row">
            <span>当前版本</span>
            <strong id="upd-local-ver" class="mono">v0.1.0</strong>
          </div>
          <div class="kv-row">
            <span>远程版本</span>
            <strong id="upd-remote-ver" class="mono">--</strong>
          </div>
        </div>
        <div class="repo-fixed-row">
          <span>Repo</span>
          <code id="upd-repo-value" class="repo-value" title="https://github.com/www12354jkl/Codex-Dashboard.git">www12354jkl/Codex-Dashboard</code>
        </div>
        <div id="upd-banner" class="pop-banner is-visible is-info">
          点击「检查更新」获取 www12354jkl/Codex-Dashboard 远程版本。
        </div>
        <ul id="upd-notes" class="update-notes" hidden></ul>
        <div id="upd-progress-wrap" class="update-progress-wrap">
          <div class="kv-row" style="font-size:11px">
            <span id="upd-progress-label">准备检查…</span>
            <span id="upd-progress-pct" class="mono">0%</span>
          </div>
          <div class="progress-track progress-track-ctx">
            <span id="upd-progress-bar" class="seg-ctx" style="width:0%"></span>
          </div>
        </div>
        <div class="action-row">
          <button type="button" id="btn-check-now" class="btn-secondary">检查更新</button>
          <button type="button" id="btn-apply-update" class="btn-primary" disabled>覆盖更新</button>
        </div>
        <div class="setting-row">
          <span>外观主题</span>
          <div class="seg-mini" role="group" aria-label="外观主题">
            <button type="button" class="seg-mini-btn" data-theme="system" aria-pressed="true">跟随</button>
            <button type="button" class="seg-mini-btn" data-theme="light" aria-pressed="false">浅色</button>
            <button type="button" class="seg-mini-btn" data-theme="dark" aria-pressed="false">深色</button>
          </div>
        </div>
      </div>
      <div class="pop-footer">
        <span>CDP 原生挂载 · 保留 ~/.codex-dashboard/ 配置</span>
      </div>
    </section>
  </div>
</div>
`;

/* ============================================================
   HELPERS
   ============================================================ */
function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatResetEta(resetsAtSec: number | null): string {
  if (!resetsAtSec || !Number.isFinite(resetsAtSec)) return "";
  const deltaSec = Math.max(0, resetsAtSec - Math.floor(Date.now() / 1000));
  if (deltaSec < 60) return "即将重置";
  const mins = Math.floor(deltaSec / 60);
  if (mins < 60) return `${mins}m 后重置`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${mins % 60}m 后重置`;
  return `${Math.floor(hours / 24)}d 后重置`;
}

function parseRgbLuminance(color: string): number | null {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(color);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) < 0.08) return null;
  return (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
}

function detectHostTheme(anchorElement: Element | null): "light" | "dark" {
  let cur: Element | null = anchorElement;
  for (let depth = 0; cur && depth < 8; depth++, cur = cur.parentElement) {
    const lum = parseRgbLuminance(getComputedStyle(cur).backgroundColor);
    if (lum !== null) return lum < 0.45 ? "dark" : "light";
  }
  const rootLum = parseRgbLuminance(getComputedStyle(document.documentElement).backgroundColor)
    ?? parseRgbLuminance(getComputedStyle(document.body).backgroundColor);
  if (rootLum !== null) return rootLum < 0.45 ? "dark" : "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function elementLabel(el: Element): string {
  return [
    el.getAttribute("aria-label") ?? "",
    el.getAttribute("title") ?? "",
    el.getAttribute("data-testid") ?? "",
    (el as HTMLElement).innerText ?? el.textContent ?? ""
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

interface ComposerAnchorMeasurement {
  composer: Element;
  leftEnd: number;
  rightStart: number;
  centerX: number;
  centerY: number;
  availableGapPx: number;
  signals: SurfaceSignals;
}

function isVisibleRect(r: DOMRect): boolean {
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

interface ConversationMarkerInfo {
  threadId: string | null;
  isChatgptConversation: boolean;
}

function inspectActiveConversationMarkers(composer: Element, nearRect?: DOMRect): ConversationMarkerInfo {
  const attrs = [
    "data-above-composer-conversation-id",
    "data-conversation-id",
    "data-thread-id"
  ];
  let isChatgptConversation = false;

  // 1. Check composer itself and its direct ancestors first.
  let ancestor: Element | null = composer;
  for (let depth = 0; ancestor && depth < 12 && ancestor !== document.body; depth++, ancestor = ancestor.parentElement) {
    if (ancestor.matches(INACTIVE_SHELL_SELECTOR) || ancestor.matches(SIDEBAR_SELECTOR)) break;
    for (const attr of attrs) {
      const raw = (ancestor.getAttribute(attr) ?? "").trim();
      if (!raw) continue;
      if (/^chatgpt\s*:/i.test(raw)) {
        return { threadId: null, isChatgptConversation: true };
      }
      const m = THREAD_UUID_RE.exec(raw);
      if (m) {
        return { threadId: m[0].toLowerCase(), isChatgptConversation: false };
      }
    }
  }

  // 2. Check active-page DOM markers.
  //    Codex Desktop renders [data-above-composer-conversation-id] as a 0x0 empty marker inside the active page
  //    while keeping previously opened pages mounted under [data-app-shell-active-page="false"].
  for (const attr of attrs) {
    const visibleAligned: Array<{ rect: DOMRect; threadId: string }> = [];
    const zeroSizeMarkers: Array<{ threadId: string }> = [];

    for (const node of document.querySelectorAll(`[${attr}]`)) {
      if (
        node.closest(`#${HOST_ID}`) ||
        node.closest(INACTIVE_SHELL_SELECTOR) ||
        node.closest(SIDEBAR_SELECTOR)
      ) {
        continue;
      }
      const raw = (node.getAttribute(attr) ?? "").trim();
      if (!raw) continue;

      const rect = node.getBoundingClientRect();
      const hasGeometry = rect.width > 0 && rect.height > 0;

      // Skip visible sidebar thread rows sitting outside the active composer column
      if (hasGeometry && nearRect && (rect.right < nearRect.left - 24 || rect.left > nearRect.right + 24)) {
        continue;
      }

      if (/^chatgpt\s*:/i.test(raw)) {
        isChatgptConversation = true;
        continue;
      }

      const m = THREAD_UUID_RE.exec(raw);
      if (!m) continue;
      const threadId = m[0].toLowerCase();

      if (hasGeometry) {
        visibleAligned.push({ rect, threadId });
      } else {
        zeroSizeMarkers.push({ threadId });
      }
    }

    if (visibleAligned.length > 0) {
      if (nearRect) {
        const cx = nearRect.left + nearRect.width / 2;
        visibleAligned.sort((a, b) => {
          const da = cx < a.rect.left ? a.rect.left - cx : cx > a.rect.right ? cx - a.rect.right : 0;
          const db = cx < b.rect.left ? b.rect.left - cx : cx > b.rect.right ? cx - b.rect.right : 0;
          return da - db || Math.abs(nearRect.top - a.rect.bottom) - Math.abs(nearRect.top - b.rect.bottom);
        });
        return { threadId: visibleAligned[0]!.threadId, isChatgptConversation: false };
      }
      return { threadId: visibleAligned.at(-1)!.threadId, isChatgptConversation: false };
    }

    // Active main-task empty marker is mounted first in DOM
    if (zeroSizeMarkers.length > 0) {
      return { threadId: zeroSizeMarkers[0]!.threadId, isChatgptConversation: false };
    }
  }

  // 3. Fallback to active route URL.
  const routeText =
    location.pathname === "/index.html"
      ? `${location.pathname}${location.search}${location.hash}`
      : `${location.pathname}${location.hash}`;
  const fromUrl = THREAD_UUID_RE.exec(routeText);
  return {
    threadId: fromUrl ? fromUrl[0].toLowerCase() : null,
    isChatgptConversation
  };
}

function findComposerAnchor(): (ComposerAnchorMeasurement & { threadId: string | null }) | null {
  const inputs = Array.from(
    document.querySelectorAll<HTMLElement>(
      'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor], [role="textbox"]'
    )
  ).filter((el) => {
    if (el.closest(`#${HOST_ID}`) || el.closest(INACTIVE_SHELL_SELECTOR)) return false;
    const r = el.getBoundingClientRect();
    return isVisibleRect(r) && r.width >= 180 && r.bottom >= window.innerHeight * 0.4;
  });

  if (inputs.length === 0) return null;

  // Try candidate inputs from bottom-most upward so a non-composer textbox doesn't block fallback
  inputs.sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom);

  for (const input of inputs) {
    const inputRect = input.getBoundingClientRect();
    const placeholder = [
      input.getAttribute("placeholder") ?? "",
      input.getAttribute("aria-placeholder") ?? "",
      input.getAttribute("aria-label") ?? "",
      input.dataset.placeholder ?? ""
    ].join(" ");

    // Walk upward to find the composer card enclosing both input & bottom toolbar buttons
    let composer: Element | null = null;
    let cur: Element | null = input.parentElement;
    for (let depth = 0; cur && depth < 8 && cur !== document.body; depth++, cur = cur.parentElement) {
      const r = cur.getBoundingClientRect();
      if (r.height > window.innerHeight * 0.72) break;
      const btns = cur.querySelectorAll('button, [role="button"], [role="combobox"]');
      if (btns.length >= 2 && r.width >= inputRect.width && r.bottom >= inputRect.bottom) {
        composer = cur;
        if (r.height >= 64 && btns.length >= 3) break;
      }
    }
    if (!composer) continue;

    const compRect = composer.getBoundingClientRect();
    const rawButtons = Array.from(composer.querySelectorAll('button, [role="button"], [role="combobox"]')).filter((b) => {
      if (b.closest(`#${HOST_ID}`) || b.closest(INACTIVE_SHELL_SELECTOR)) return false;
      const r = b.getBoundingClientRect();
      // Strictly footer buttons below/aligned with bottom of composer card (even for tall multi-line inputs)
      return (
        isVisibleRect(r) &&
        r.width <= 320 &&
        r.height >= 16 &&
        r.height <= 56 &&
        r.top >= inputRect.bottom - 14 &&
        r.bottom >= compRect.bottom - 62
      );
    });

    if (rawButtons.length < 2) continue;

    const items = rawButtons.map((el) => {
      const rect = el.getBoundingClientRect();
      const label = elementLabel(el);
      const cy = rect.top + rect.height / 2;
      const cx = rect.left + rect.width / 2;
      const isCodexAccess = CODEX_ACCESS_RE.test(label);
      const isLeft = LEFT_CONTROL_RE.test(label);
      const isRight = RIGHT_CONTROL_RE.test(label);
      return { el, rect, label, cy, cx, isCodexAccess, isLeft, isRight };
    });

    items.sort((a, b) => b.cy - a.cy);
    const anchorRowY = items[0]!.cy;
    const row = items.filter((it) => Math.abs(it.cy - anchorRowY) <= 22);
    if (row.length < 2) continue;

    const byLeft = [...row].sort((a, b) => a.rect.left - b.rect.left);
    let bestGap = -1;
    let splitIndex = -1;
    let runningMaxRight = byLeft[0]!.rect.right;

    for (let i = 0; i < byLeft.length - 1; i++) {
      runningMaxRight = Math.max(runningMaxRight, byLeft[i]!.rect.right);
      const nextLeft = byLeft[i + 1]!.rect.left;
      const gap = nextLeft - runningMaxRight;
      if (gap > bestGap) {
        bestGap = gap;
        splitIndex = i;
      }
    }
    if (splitIndex < 0) continue;

    const leftCluster = byLeft.slice(0, splitIndex + 1);
    const rightCluster = byLeft.slice(splitIndex + 1);
    const leftEnd = Math.max(...leftCluster.map((it) => it.rect.right));
    const rightStart = Math.min(...rightCluster.map((it) => it.rect.left));
    const availableGapPx = Math.max(0, rightStart - leftEnd);

    const labeledRow = row.filter((it) => it.isCodexAccess || it.isLeft || it.isRight);
    const centerPool = labeledRow.length > 0 ? labeledRow : row;
    const centerY = centerPool.reduce((sum, it) => sum + it.cy, 0) / centerPool.length;
    const centerX = (leftEnd + rightStart) / 2;

    const markers = inspectActiveConversationMarkers(composer, compRect);
    const hasCodexAccessControl = row.some((it) => it.isCodexAccess);
    const hasModelControl = row.some((it) => it.isRight);
    const hasWorkspaceIndicator =
      CODEX_PLACEHOLDER_RE.test(placeholder) || (markers.threadId !== null && !markers.isChatgptConversation);

    const isOrdinaryChatSurface =
      markers.isChatgptConversation ||
      ORDINARY_CHAT_PLACEHOLDER_RE.test(placeholder) ||
      (!hasCodexAccessControl && !hasWorkspaceIndicator && /\/c\/|chat/i.test(location.pathname + location.hash));

    const isVoiceMode = Array.from(document.querySelectorAll('button, [role="dialog"]'))
      .slice(0, 40)
      .some((el) => {
        if (el.closest(`#${HOST_ID}`) || el.closest(INACTIVE_SHELL_SELECTOR)) return false;
        const r = el.getBoundingClientRect();
        return isVisibleRect(r) && VOICE_OVERLAY_RE.test(elementLabel(el));
      });

    return {
      composer,
      leftEnd,
      rightStart,
      centerX,
      centerY,
      availableGapPx,
      threadId: markers.threadId,
      signals: {
        url: `${location.pathname}${location.search}${location.hash}`,
        hasCodexAccessControl,
        hasWorkspaceIndicator,
        hasModelControl,
        isOrdinaryChatSurface,
        isVoiceMode
      }
    };
  }

  return null;
}

/* ============================================================
   INSTALL / MOUNT WIDGET (IDEMPOTENT FOR HOT-RELOAD)
   ============================================================ */
(function installCodexDashboardCdpWidget(): void {
  const win = window as BridgeWindow;
  win.__codexHudTeardown?.();

  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.dataset.codexHud = "true";
  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = WIDGET_CSS;
  shadow.appendChild(styleEl);

  const wrapper = document.createElement("div");
  wrapper.innerHTML = WIDGET_HTML;
  const root = wrapper.firstElementChild as HTMLElement;
  shadow.appendChild(root);

  const mountTarget = document.body ?? document.documentElement;
  mountTarget.appendChild(host);

  const $ = <T extends Element = HTMLElement>(id: string): T => {
    const el = shadow.getElementById(id);
    if (!el) throw new Error(`Missing shadow element #${id}`);
    return el as unknown as T;
  };

  const CTX_RING_CIRCUMFERENCE = 33.93;

  let currentSnapshot: TelemetrySnapshot = createEmptySnapshot();
  let currentConfig: OverlayConfig = { ...DEFAULT_OVERLAY_CONFIG };
  let currentUpdate: UpdateStatus = createDefaultUpdateStatus("0.1.0", currentConfig);
  let layoutMode: HudLayoutMode = "expanded";
  let cachedExpandedWidth = 340;
  let cachedIconsWidth = 144;
  let openPanel: PanelKey | null = null;
  let openFromCompact = false;
  let activeTrigger: HTMLElement | null = null;
  let lastThreadHint: string | null | undefined = undefined;
  let layoutRaf = 0;
  let disposed = false;

  const anchorBox = $("anchor-box");
  const hudGroup = $("hud-group");
  const compactBtn = $<HTMLButtonElement>("btn-compact");
  const popoverCard = $("popover-card");
  const compactTabs = $("compact-tabs");

  function sendToHost(msg: CdpWidgetMessage): void {
    try {
      win[CDP_BINDING_NAME]?.(JSON.stringify(msg));
    } catch {}
  }

  function setPill(el: HTMLElement, text: string, tone: "ok" | "info" | "warn" | "danger" = "ok"): void {
    el.textContent = text;
    el.className = "pop-pill" + (tone === "ok" ? "" : ` is-${tone}`);
  }

  function setBanner(el: HTMLElement, text: string | null, tone: "ok" | "info" | "warn" | "danger" = "info"): void {
    if (!text) {
      el.className = "pop-banner";
      el.textContent = "";
      return;
    }
    el.className = `pop-banner is-visible is-${tone}`;
    el.textContent = text;
  }

  function renderBarSeries(container: HTMLElement, values: number[], mode: "speed" | "ctx" | "cache"): void {
    const padded = values.slice(-7);
    while (padded.length < 7) padded.unshift(0);
    const maxVal = mode === "speed" ? Math.max(10, ...padded) : 100;
    const frag = document.createDocumentFragment();
    padded.forEach((raw, idx) => {
      const bar = document.createElement("span");
      const isLast = idx === padded.length - 1;
      let cls = "bar-col";
      if (raw <= 0) {
        bar.style.height = "8%";
        bar.style.opacity = "0.25";
      } else {
        bar.style.height = `${Math.max(12, Math.min(100, (raw / maxVal) * 100)).toFixed(1)}%`;
        if (mode === "cache") {
          cls += raw < 50 ? " is-danger" : raw < 80 ? " is-warn" : " is-ok";
        } else if (mode === "ctx") {
          if (raw >= 80) cls += " is-ctx-danger";
          else if (raw >= 60) cls += " is-ctx-warn";
          else cls += isLast ? " is-ctx-latest" : " is-ctx-hist";
        } else if (isLast) {
          cls += " is-latest";
        }
      }
      bar.className = cls;
      frag.appendChild(bar);
    });
    container.replaceChildren(frag);
  }

  function updateCompactDot(): void {
    const dot = $("compact-dot");
    let cls = "compact-status-dot";
    if (currentSnapshot.cache.dropAlert || currentSnapshot.context.percent >= 80) {
      cls += " is-danger";
    } else if (currentSnapshot.context.percent >= 60) {
      cls += " is-warn";
    } else if (currentUpdate.state === "available" || currentUpdate.state === "applied_restart_required") {
      cls += " is-info";
    } else if (currentSnapshot.status === "no_data" || currentSnapshot.status === "waiting_codex") {
      cls += " is-idle";
    }
    dot.className = cls;

    const tps = currentSnapshot.speed.latestStepTps !== null ? `${currentSnapshot.speed.latestStepTps.toFixed(1)} t/s` : "-- t/s";
    const ctx = `Ctx ${Math.round(currentSnapshot.context.percent)}%`;
    const cache =
      currentSnapshot.cache.weightedHitRate !== null ? `Cache ${Math.round(currentSnapshot.cache.weightedHitRate)}%` : "Cache --";
    const tok = `${formatCompactTokens(currentSnapshot.tokens.totalTokens)} tok`;
    compactBtn.title = `${tps} · ${ctx} · ${cache} · ${tok}`;
  }

  function renderSnapshot(snap: TelemetrySnapshot): void {
    currentSnapshot = snap;
    root.dataset.status = snap.status;

    const dot = $("live-dot");
    dot.className = "live-dot";
    if (snap.cache.dropAlert) dot.classList.add("is-danger");
    else if (snap.context.percent >= 80) dot.classList.add("is-warn");

    // 1. Speed
    const tps = snap.speed.latestStepTps;
    const tpsText = tps !== null && Number.isFinite(tps) ? tps.toFixed(1) : "--";
    $("hud-tps").textContent = tpsText;
    $("sp-tps").textContent = tpsText;
    const ttftText = formatMs(snap.speed.latestTtftMs);
    $("sp-ttft").textContent = ttftText;
    $("sp-note").textContent = snap.speed.note;
    $("sp-model").textContent = `${snap.model}${snap.reasoningEffort ? ` · ${snap.reasoningEffort}` : ""}`;

    const speedIconDot = $("speed-icon-dot");
    let speedDotCls = "icon-corner-dot";
    if (snap.status === "streaming" || snap.status === "idle") speedDotCls += " is-ok";
    else speedDotCls += " is-idle";
    speedIconDot.className = speedDotCls;
    $<HTMLButtonElement>("btn-speed").title =
      tps !== null && Number.isFinite(tps)
        ? `模型速度：${tpsText} tok/s · TTFT ${ttftText}`
        : "模型速度：等待数据";

    if (snap.status === "streaming") setPill($("sp-pill"), "生成中", "ok");
    else if (snap.status === "idle") setPill($("sp-pill"), "空闲 · 上轮", "ok");
    else setPill($("sp-pill"), "等待日志", "info");

    const validSpeeds = snap.speed.recentStepTps.filter((v) => v > 0);
    $("sp-range").textContent =
      validSpeeds.length > 0 ? `${Math.min(...validSpeeds).toFixed(0)} – ${Math.max(...validSpeeds).toFixed(0)} t/s` : "--";
    renderBarSeries($("sp-bars"), snap.speed.recentStepTps, "speed");

    const llmMs = Math.max(0, snap.speed.lastTurnLlmMs);
    const toolMs = Math.max(0, snap.speed.lastTurnToolMs);
    const totalMs = llmMs + toolMs;
    const llmPct = totalMs > 0 ? Math.round((llmMs / totalMs) * 100) : 100;
    $("sp-llm-sec").textContent = `${(llmMs / 1000).toFixed(1)}s`;
    $("sp-tool-sec").textContent = `${(toolMs / 1000).toFixed(1)}s`;
    $("sp-llm-bar").style.width = `${llmPct}%`;
    $("sp-tool-bar").style.width = `${100 - llmPct}%`;

    // 2. Context
    const ctxPct = Math.max(0, Math.min(100, snap.context.percent));
    const ctxLevel = ctxPct >= 80 ? "danger" : ctxPct >= 60 ? "warn" : "ok";
    const usedK = formatCompactTokens(snap.context.usedTokens);
    const winK = formatCompactTokens(snap.context.windowTokens);
    const remainK = formatCompactTokens(Math.max(0, snap.context.windowTokens - snap.context.usedTokens));

    $("hud-ctx-track").className = "mini-bar" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`);
    const miniBar = $("hud-ctx-bar");
    miniBar.className = "mini-bar-fill" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`);
    miniBar.style.width = `${ctxPct.toFixed(1)}%`;
    miniBar.style.minWidth = ctxPct > 0 || snap.context.usedTokens > 0 ? "" : "0";
    const miniPct = $("hud-ctx-pct");
    miniPct.textContent = `${Math.round(ctxPct)}%`;
    miniPct.className = "hud-val mono " + (ctxLevel === "ok" ? "is-ctx-ok" : `is-${ctxLevel}`);

    const ctxRingTrack = $<SVGCircleElement>("hud-ctx-ring-track");
    const ctxRingFill = $<SVGCircleElement>("hud-ctx-ring-fill");
    ctxRingTrack.setAttribute("class", "ctx-ring-track" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`));
    ctxRingFill.setAttribute("class", "ctx-ring-fill" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`));
    const ringFrac = snap.context.usedTokens > 0 || ctxPct > 0 ? Math.max(0.06, Math.min(1, ctxPct / 100)) : 0;
    ctxRingFill.setAttribute("stroke-dashoffset", (CTX_RING_CIRCUMFERENCE * (1 - ringFrac)).toFixed(2));
    $<HTMLButtonElement>("btn-ctx").title = `上下文：${Math.round(ctxPct)}% (${usedK} / ${winK})`;

    const heroCtx = $("ctx-pct");
    heroCtx.textContent = `${ctxPct.toFixed(1)}%`;
    heroCtx.style.color =
      ctxLevel === "danger" ? "var(--ctx-danger)" : ctxLevel === "warn" ? "var(--ctx-warn)" : "var(--ctx-ok)";
    $("ctx-used").textContent = `${usedK} / ${winK}`;
    $("ctx-window").textContent = `${snap.context.windowTokens.toLocaleString("en-US")} tokens`;
    $("ctx-remain").textContent = `${remainK} tokens`;

    if (snap.context.lastCompactionSavedTokens && snap.context.compactionCount > 0) {
      $("ctx-delta").textContent = `已压缩 -${formatCompactTokens(snap.context.lastCompactionSavedTokens)}`;
      $("ctx-compact-tag").textContent = `本会话已压缩 ${snap.context.compactionCount} 次`;
    } else if (snap.context.deltaTokens !== null) {
      const sign = snap.context.deltaTokens >= 0 ? "+" : "-";
      $("ctx-delta").textContent = `${sign}${formatCompactTokens(Math.abs(snap.context.deltaTokens))}`;
      $("ctx-compact-tag").textContent = "80% 处标有压缩线";
    } else {
      $("ctx-delta").textContent = "--";
      $("ctx-compact-tag").textContent = "80% 处标有压缩线";
    }

    $("ctx-track").className = "progress-track progress-track-ctx" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`);
    $("ctx-bar").className = "seg-ctx" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`);
    $("ctx-bar").style.width = `${ctxPct.toFixed(1)}%`;
    $("ctx-bar").style.minWidth = ctxPct > 0 || snap.context.usedTokens > 0 ? "" : "0";

    if (ctxLevel === "danger") {
      setPill($("ctx-pill"), "接近压缩", "danger");
      setBanner($("ctx-banner"), `当前上下文已达 ${ctxPct.toFixed(1)}%，超过 80% 警戒线，建议新开会话或等待自动压缩。`, "danger");
    } else if (ctxLevel === "warn") {
      setPill($("ctx-pill"), "中高水位", "warn");
      setBanner($("ctx-banner"), `当前上下文已占 ${ctxPct.toFixed(1)}%，长上下文可能略微增加首字延迟。`, "warn");
    } else {
      setPill($("ctx-pill"), "余量充足", "info");
      setBanner($("ctx-banner"), null);
    }
    renderBarSeries($("ctx-bars"), snap.context.recentPercents, "ctx");

    // 3. Cache
    const hit = snap.cache.weightedHitRate;
    const hudCache = $("hud-cache-pct");
    const cacheIconDot = $("cache-icon-dot");
    if (hit === null) {
      hudCache.textContent = "--";
      hudCache.className = "hud-val mono";
      cacheIconDot.className = "icon-corner-dot is-hidden";
      $<HTMLButtonElement>("btn-cache").title = "缓存命中率：暂无输入数据";
      $("ca-pct").textContent = "--";
      setPill($("ca-pill"), "无输入", "info");
      $("ca-hit-bar").style.width = "0%";
      $("ca-miss-bar").style.width = "100%";
    } else {
      const caLevel = hit < 50 ? "danger" : hit < 80 ? "warn" : "ok";
      hudCache.textContent = `${Math.round(hit)}%`;
      hudCache.className = `hud-val mono is-${caLevel}`;
      cacheIconDot.className =
        snap.cache.dropAlert || caLevel === "danger"
          ? "icon-corner-dot is-danger"
          : caLevel === "warn"
            ? "icon-corner-dot is-warn"
            : "icon-corner-dot is-hidden";
      $<HTMLButtonElement>("btn-cache").title =
        `缓存命中率：${Math.round(hit)}%（命中 ${formatCompactTokens(snap.cache.cachedInputTokens)} · 写入 ${formatCompactTokens(snap.cache.cacheWriteTokens)}）`;
      $("ca-pct").textContent = `${hit.toFixed(1)}%`;
      setPill(
        $("ca-pill"),
        snap.cache.dropAlert ? "命中骤降" : hit >= 90 ? "高命中" : hit >= 70 ? "良好" : "偏低",
        snap.cache.dropAlert ? "danger" : caLevel
      );
      $("ca-hit-bar").style.width = `${hit.toFixed(1)}%`;
      $("ca-miss-bar").style.width = `${Math.max(0, 100 - hit).toFixed(1)}%`;
    }

    $("ca-write").textContent = formatCompactTokens(snap.cache.cacheWriteTokens);
    $("ca-cached").textContent = formatCompactTokens(snap.cache.cachedInputTokens);
    $("ca-uncached").textContent = formatCompactTokens(snap.cache.uncachedInputTokens);
    $("ca-latest-step").textContent =
      snap.cache.latestStepHitRate !== null ? `最近一步 ${Math.round(snap.cache.latestStepHitRate)}%` : "--";

    if (snap.cache.dropAlert) {
      const a = snap.cache.dropAlert;
      setBanner(
        $("ca-banner"),
        `命中率由基线 ${a.previousAvg.toFixed(0)}% 骤降至 ${a.current.toFixed(1)}%（-${a.dropPoints.toFixed(1)}%）：${a.reason}`,
        "danger"
      );
    } else {
      setBanner($("ca-banner"), null);
    }
    renderBarSeries($("ca-bars"), snap.cache.recentStepHitRates, "cache");

    // 4. Tokens & Quota
    const totalTokText = formatCompactTokens(snap.tokens.totalTokens);
    $("hud-tokens").textContent = totalTokText;
    $("tk-total").textContent = totalTokText;
    $("tk-input").textContent = formatCompactTokens(snap.tokens.inputTokens);
    $("tk-output").textContent = formatCompactTokens(snap.tokens.outputTokens);
    $("tk-reas").textContent = formatCompactTokens(snap.tokens.reasoningOutputTokens);
    $("tk-vis").textContent = formatCompactTokens(snap.tokens.visibleOutputTokens);
    const reasPct = Math.max(0, Math.min(100, Math.round(snap.tokens.reasoningSharePercent)));
    $("tk-reas-pct").textContent = `推理占 ${reasPct}%`;
    $("tk-reas-bar").style.width = `${reasPct}%`;
    $("tk-vis-bar").style.width = `${100 - reasPct}%`;
    $("tk-session").textContent = snap.sessionId
      ? `会话 ${snap.sessionId.slice(0, 8)}`
      : snap.tokens.totalTokens === 0
        ? "新对话"
        : "本会话累计";

    const p5 = snap.rateLimits.primary;
    $("quota-5h-text").textContent = p5
      ? `${Math.round(p5.usedPercent)}%${formatResetEta(p5.resetsAtSec) ? ` · ${formatResetEta(p5.resetsAtSec)}` : ""}`
      : "暂无配额数据";
    $("quota-5h-bar").style.width = p5 ? `${Math.min(100, Math.max(0, p5.usedPercent))}%` : "0%";

    const p7 = snap.rateLimits.secondary;
    $("quota-7d-text").textContent = p7
      ? `${Math.round(p7.usedPercent)}%${formatResetEta(p7.resetsAtSec) ? ` · ${formatResetEta(p7.resetsAtSec)}` : ""}`
      : "暂无配额数据";
    $("quota-7d-bar").style.width = p7 ? `${Math.min(100, Math.max(0, p7.usedPercent))}%` : "0%";

    $<HTMLButtonElement>("btn-tokens").title =
      `Token 消耗：${totalTokText}（输入 ${formatCompactTokens(snap.tokens.inputTokens)} · 输出 ${formatCompactTokens(snap.tokens.outputTokens)}）` +
      (p5 ? ` · 5h 额度 ${Math.round(p5.usedPercent)}%` : "");

    updateCompactDot();
    scheduleLayout();
  }

  function renderUpdateStatus(status: UpdateStatus): void {
    currentUpdate = status;
    $("upd-local-ver").textContent = status.currentVersion.startsWith("v") ? status.currentVersion : `v${status.currentVersion}`;
    $("upd-remote-ver").textContent = status.latestVersion
      ? status.latestVersion.startsWith("v") ? status.latestVersion : `v${status.latestVersion}`
      : "--";

    $("upd-repo-value").textContent = OFFICIAL_GITHUB_REPO;

    $("update-dot").classList.toggle("is-visible", status.state === "available" || status.state === "applied_restart_required");
    $<HTMLButtonElement>("btn-update").title =
      status.state === "available"
        ? `发现新版本 ${status.latestVersion ?? ""} · 点击检查更新`
        : status.state === "applied_restart_required"
          ? "更新已就绪 · 点击热重载生效"
          : "检查更新与设置";

    const checkBtn = $<HTMLButtonElement>("btn-check-now");
    const applyBtn = $<HTMLButtonElement>("btn-apply-update");
    const busy =
      status.state === "checking" ||
      status.state === "downloading" ||
      status.state === "verifying" ||
      status.state === "applying";
    checkBtn.disabled = busy;

    const pillMap: Record<UpdateStatus["state"], [string, "ok" | "info" | "warn" | "danger"]> = {
      idle: ["未检查", "info"],
      checking: ["检查中…", "info"],
      available: [`发现 ${status.latestVersion ?? "新版本"}`, "info"],
      up_to_date: ["已是最新", "ok"],
      downloading: ["下载中…", "info"],
      verifying: ["校验中…", "info"],
      applying: ["覆盖更新中…", "warn"],
      applied_restart_required: ["待热重载生效", "ok"],
      error: ["检查失败", "danger"]
    };
    const [pillText, pillTone] = pillMap[status.state];
    setPill($("upd-pill"), pillText, pillTone);
    setBanner($("upd-banner"), status.error ? `${status.message} (${status.error})` : status.message, pillTone);

    const notesEl = $("upd-notes");
    if (status.releaseNotes.length > 0) {
      const frag = document.createDocumentFragment();
      for (const line of status.releaseNotes.slice(0, 6)) {
        const li = document.createElement("li");
        li.textContent = line;
        frag.appendChild(li);
      }
      notesEl.replaceChildren(frag);
      notesEl.hidden = false;
    } else {
      notesEl.replaceChildren();
      notesEl.hidden = true;
    }

    if (status.state === "applied_restart_required") {
      applyBtn.disabled = false;
      applyBtn.textContent = "热重载生效";
    } else if (status.canApply && !busy) {
      applyBtn.disabled = false;
      applyBtn.textContent = "覆盖更新文件";
    } else {
      applyBtn.disabled = true;
      applyBtn.textContent = status.state === "up_to_date" ? "已是最新" : "覆盖更新";
    }

    if (!busy && status.state !== "applied_restart_required") {
      $("upd-progress-wrap").classList.remove("is-visible");
    }

    updateCompactDot();
    if (openPanel) positionPopover();
  }

  function renderUpdateProgress(progress: UpdateProgress): void {
    $("upd-progress-wrap").classList.add("is-visible");
    const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));
    $("upd-progress-bar").style.width = `${pct}%`;
    $("upd-progress-pct").textContent = `${pct}%`;
    $("upd-progress-label").textContent = progress.message;
    if (openPanel) positionPopover();
  }

  function renderConfig(cfg: OverlayConfig): void {
    currentConfig = cfg;
    $("upd-repo-value").textContent = OFFICIAL_GITHUB_REPO;
    shadow.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.theme === cfg.theme));
    });
    scheduleLayout();
  }

  /* ============================================================
     POPOVER MANAGEMENT (EXPANDED INDIVIDUAL vs COMPACT 5-TAB)
     ============================================================ */
  function syncActiveButtonState(): void {
    shadow.querySelectorAll<HTMLButtonElement>(".hud-btn[data-panel]").forEach((b) => {
      const active = !openFromCompact && openPanel === b.dataset.panel;
      b.dataset.open = String(active);
      b.setAttribute("aria-expanded", String(active));
    });
    const compactActive = openFromCompact && openPanel !== null;
    compactBtn.dataset.open = String(compactActive);
    compactBtn.setAttribute("aria-expanded", String(compactActive));
  }

  function selectPanelView(key: PanelKey): void {
    openPanel = key;
    shadow.querySelectorAll<HTMLElement>(".panel-view").forEach((sec) => {
      sec.hidden = sec.dataset.view !== key;
    });
    shadow.querySelectorAll<HTMLButtonElement>(".compact-tab").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === key));
    });
    compactTabs.hidden = !openFromCompact;
    syncActiveButtonState();
    positionPopover();
  }

  function positionPopover(): void {
    if (!openPanel || popoverCard.hidden || !activeTrigger) return;
    const trig = activeTrigger.getBoundingClientRect();
    if (trig.width <= 0 || trig.height <= 0) return;

    const spaceAbove = Math.max(140, Math.floor(trig.top - 22));
    popoverCard.style.maxHeight = `${Math.min(470, spaceAbove)}px`;

    const cardRect = popoverCard.getBoundingClientRect();
    const cardW = cardRect.width || 318;
    const cardH = Math.min(cardRect.height || 260, spaceAbove);

    let left = trig.left + trig.width / 2 - cardW / 2;
    left = Math.max(12, Math.min(window.innerWidth - cardW - 12, left));

    const top = Math.max(12, trig.top - cardH - 10);

    popoverCard.style.left = `${Math.round(left)}px`;
    popoverCard.style.top = `${Math.round(top)}px`;
  }

  function openPopoverFor(key: PanelKey, trigger: HTMLElement, fromCompact: boolean): void {
    if (openPanel === key && openFromCompact === fromCompact && !popoverCard.hidden) {
      closePopover();
      return;
    }
    activeTrigger = trigger;
    openFromCompact = fromCompact;
    popoverCard.hidden = false;
    selectPanelView(key);
    requestAnimationFrame(() => {
      positionPopover();
      popoverCard.classList.add("is-open");
    });
  }

  function closePopover(restoreFocus = false): void {
    if (popoverCard.hidden) return;
    const prevTrigger = activeTrigger;
    openPanel = null;
    openFromCompact = false;
    popoverCard.classList.remove("is-open");
    popoverCard.hidden = true;
    syncActiveButtonState();
    if (restoreFocus && prevTrigger) {
      prevTrigger.focus({ preventScroll: true });
    }
  }

  /* ============================================================
     COLLISION-AWARE LAYOUT & SURFACE FILTERING (0ms SINGLE-FRAME)
     ============================================================ */
  function measureStripWidth(mode: "expanded" | "icons"): number {
    if (!hudGroup.hidden && hudGroup.dataset.layout === mode) {
      const live = hudGroup.getBoundingClientRect().width;
      if (live > 80) {
        if (mode === "expanded") cachedExpandedWidth = Math.ceil(live);
        else cachedIconsWidth = Math.ceil(live);
      }
      return mode === "expanded" ? cachedExpandedWidth : cachedIconsWidth;
    }
    // Measure natural strip width invisibly off-flow in a single sync turn (never painted)
    const prevHidden = hudGroup.hidden;
    const prevLayout = hudGroup.dataset.layout;
    const prevPos = hudGroup.style.position;
    const prevVis = hudGroup.style.visibility;
    hudGroup.style.position = "fixed";
    hudGroup.style.visibility = "hidden";
    hudGroup.dataset.layout = mode;
    hudGroup.hidden = false;
    const measured = hudGroup.getBoundingClientRect().width;
    hudGroup.hidden = prevHidden;
    if (prevLayout !== undefined) hudGroup.dataset.layout = prevLayout;
    hudGroup.style.position = prevPos;
    hudGroup.style.visibility = prevVis;
    if (measured > 80) {
      if (mode === "expanded") cachedExpandedWidth = Math.ceil(measured);
      else cachedIconsWidth = Math.ceil(measured);
    }
    return mode === "expanded" ? cachedExpandedWidth : cachedIconsWidth;
  }

  function updateLayout(): void {
    if (disposed) return;

    const anchor = findComposerAnchor();
    if (!anchor) {
      layoutMode = "expanded";
      anchorBox.hidden = true;
      closePopover();
      return;
    }

    // Report active thread UUID discovered from active Codex DOM markers (or URL fallback)
    if (anchor.threadId !== lastThreadHint) {
      lastThreadHint = anchor.threadId;
      sendToHost({ type: "thread_hint", threadId: anchor.threadId });
    }

    const decision = classifyCodexSurface(anchor.signals);
    if (!decision.show) {
      layoutMode = "expanded";
      anchorBox.hidden = true;
      closePopover();
      return;
    }

    // Apply matching theme (follow Codex actual surface unless user pinned light/dark)
    const resolvedTheme =
      currentConfig.theme === "system" ? detectHostTheme(anchor.composer) : currentConfig.theme;
    root.dataset.theme = resolvedTheme;

    anchorBox.hidden = false;
    const expandedWidthPx = measureStripWidth("expanded");
    const iconsWidthPx = measureStripWidth("icons");

    const nextMode = computeHudLayoutMode({
      availableGapPx: anchor.availableGapPx,
      expandedWidthPx,
      iconsWidthPx,
      singleWidthPx: 28,
      currentMode: layoutMode,
      safetyMarginPx: 18,
      hysteresisPx: 20
    });

    if (nextMode === "hidden") {
      layoutMode = "hidden";
      anchorBox.hidden = true;
      closePopover();
      return;
    }

    if (nextMode !== layoutMode) {
      layoutMode = nextMode;
      if (openPanel) {
        const useCompactTabs = layoutMode === "single";
        openFromCompact = useCompactTabs;
        activeTrigger = useCompactTabs
          ? compactBtn
          : shadow.querySelector<HTMLElement>(`.hud-btn[data-panel="${openPanel}"]`) ?? compactBtn;
        compactTabs.hidden = !openFromCompact;
        syncActiveButtonState();
      }
    }

    const isSingle = layoutMode === "single";
    if (!isSingle) {
      hudGroup.dataset.layout = layoutMode;
    }
    hudGroup.hidden = isSingle;
    compactBtn.hidden = !isSingle;

    const activeEl = isSingle ? compactBtn : hudGroup;
    const boxRect = activeEl.getBoundingClientRect();
    const x = Math.round(anchor.centerX - boxRect.width / 2);
    const y = Math.round(anchor.centerY - boxRect.height / 2);
    anchorBox.style.transform = `translate3d(${x}px, ${y}px, 0)`;

    if (openPanel && !popoverCard.hidden) {
      positionPopover();
    }
  }

  function scheduleLayout(): void {
    if (disposed || layoutRaf) return;
    layoutRaf = requestAnimationFrame(() => {
      layoutRaf = 0;
      updateLayout();
    });
  }

  /* ============================================================
     EVENT BINDINGS
     ============================================================ */
  const toolbarButtons = Array.from(hudGroup.querySelectorAll<HTMLButtonElement>(".hud-btn[data-panel]"));
  toolbarButtons.forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPopoverFor(btn.dataset.panel as PanelKey, btn, false);
    });
  });

  // Roving-tabindex fallback only where native HTML focusgroup is unsupported
  if (!("focusGroup" in HTMLElement.prototype) && toolbarButtons.length > 0) {
    toolbarButtons.forEach((b, i) => {
      b.tabIndex = i === 0 ? 0 : -1;
    });
    hudGroup.addEventListener("focusin", (e) => {
      const target = e.target;
      if (target instanceof HTMLButtonElement && toolbarButtons.includes(target)) {
        toolbarButtons.forEach((b) => {
          b.tabIndex = b === target ? 0 : -1;
        });
      }
    });
    hudGroup.addEventListener("keydown", (e) => {
      const idx = toolbarButtons.findIndex((b) => b === shadow.activeElement);
      if (idx < 0) return;
      const rtl = getComputedStyle(hudGroup).direction === "rtl";
      let next = -1;
      if (e.key === "ArrowRight") next = (idx + (rtl ? -1 : 1) + toolbarButtons.length) % toolbarButtons.length;
      else if (e.key === "ArrowLeft") next = (idx + (rtl ? 1 : -1) + toolbarButtons.length) % toolbarButtons.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = toolbarButtons.length - 1;
      if (next >= 0) {
        e.preventDefault();
        toolbarButtons[next]!.focus();
      }
    });
  }

  compactBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openPopoverFor(openPanel ?? "speed", compactBtn, true);
  });

  shadow.querySelectorAll<HTMLButtonElement>(".compact-tab").forEach((tab) => {
    tab.addEventListener("click", (e) => {
      e.stopPropagation();
      selectPanelView(tab.dataset.tab as PanelKey);
    });
  });

  shadow.querySelectorAll<HTMLButtonElement>("[data-close]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      closePopover(true);
    });
  });

  shadow.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.theme as ThemePreference;
      renderConfig({ ...currentConfig, theme });
      sendToHost({ type: "update_config", patch: { theme } });
    });
  });

  $("btn-check-now").addEventListener("click", () => {
    renderUpdateStatus({ ...currentUpdate, state: "checking", repo: OFFICIAL_GITHUB_REPO, message: "正在检查远程更新…" });
    sendToHost({ type: "check_updates", repo: OFFICIAL_GITHUB_REPO });
  });

  $("btn-apply-update").addEventListener("click", () => {
    if (currentUpdate.state === "applied_restart_required") {
      sendToHost({ type: "restart_monitor" });
      return;
    }
    sendToHost({ type: "apply_update" });
  });

  // Dismiss popover on outside click or Escape
  const onDocPointerDown = (e: Event): void => {
    if (popoverCard.hidden) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!path.includes(host)) closePopover();
  };

  const onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !popoverCard.hidden) {
      closePopover(true);
    }
  };

  const onWinResize = (): void => scheduleLayout();

  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onDocKeyDown, true);
  window.addEventListener("resize", onWinResize, { passive: true });
  window.addEventListener("popstate", onWinResize);
  window.addEventListener("hashchange", onWinResize);

  const mutationObserver = new MutationObserver(() => scheduleLayout());
  mutationObserver.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "aria-label", "placeholder", "data-state"]
  });

  const resizeObserver = new ResizeObserver(() => scheduleLayout());
  resizeObserver.observe(document.documentElement);

  const layoutHeartbeat = window.setInterval(() => scheduleLayout(), 600);

  // Receive push events from Node CDP host
  win[CDP_RECEIVE_FN] = (event: CdpHostEvent): void => {
    if (disposed || !event || typeof event !== "object") return;
    switch (event.type) {
      case "snapshot":
        renderSnapshot(event.payload);
        break;
      case "config":
        renderConfig(event.payload);
        break;
      case "update_status":
        renderUpdateStatus(event.payload);
        break;
      case "update_progress":
        renderUpdateProgress(event.payload);
        break;
      case "teardown":
        teardown();
        break;
    }
  };

  function teardown(): void {
    if (disposed) return;
    disposed = true;
    if (layoutRaf) cancelAnimationFrame(layoutRaf);
    window.clearInterval(layoutHeartbeat);
    mutationObserver.disconnect();
    resizeObserver.disconnect();
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onDocKeyDown, true);
    window.removeEventListener("resize", onWinResize);
    window.removeEventListener("popstate", onWinResize);
    window.removeEventListener("hashchange", onWinResize);
    delete win[CDP_RECEIVE_FN];
    delete win.__codexHudTeardown;
    host.remove();
  }

  win.__codexHudTeardown = teardown;

  // Initial render + notify host we are ready
  renderSnapshot(currentSnapshot);
  renderConfig(currentConfig);
  renderUpdateStatus(currentUpdate);
  scheduleLayout();
  sendToHost({ type: "ready" });
})();
