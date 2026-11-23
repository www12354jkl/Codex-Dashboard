import {
  DEFAULT_OVERLAY_CONFIG,
  OFFICIAL_GITHUB_REPO,
  type HitRect,
  type OverlayConfig,
  type OverlayRuntimeState,
  type TelemetrySnapshot,
  type ThemePreference,
  type UpdateProgress,
  type UpdateStatus
} from "../shared/types.js";
import {
  createDefaultUpdateStatus,
  createInitialRuntimeState,
  createPreviewMockSnapshot
} from "../shared/mock.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const api = window.codexHud;
let currentConfig: OverlayConfig = { ...DEFAULT_OVERLAY_CONFIG };
let currentUpdateStatus: UpdateStatus = createDefaultUpdateStatus("0.1.0", currentConfig);

const POPOVER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["btn-speed", "pop-speed"],
  ["btn-ctx", "pop-ctx"],
  ["btn-cache", "pop-cache"],
  ["btn-tokens", "pop-tokens"],
  ["btn-update", "pop-update"]
];

/* ============================================================
   FORMATTING HELPERS
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
  const days = Math.floor(hours / 24);
  return `${days}d 后重置`;
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

function renderBarSeries(
  container: HTMLElement,
  values: number[],
  mode: "speed" | "ctx" | "cache"
): void {
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
      const pctHeight = Math.max(12, Math.min(100, (raw / maxVal) * 100));
      bar.style.height = `${pctHeight.toFixed(1)}%`;

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

/* ============================================================
   RENDER SNAPSHOT TO STYLE A BAR & 4 METRIC POPOVERS
   ============================================================ */
function renderSnapshot(snap: TelemetrySnapshot): void {
  document.body.dataset.status = snap.status;

  // Live indicator dot severity
  const dot = $("live-dot");
  dot.className = "live-dot";
  if (snap.cache.dropAlert) {
    dot.classList.add("is-danger");
  } else if (snap.context.percent >= 80) {
    dot.classList.add("is-warn");
  }

  // ---- 1. SPEED ----
  const tps = snap.speed.latestStepTps;
  const tpsText = tps !== null && Number.isFinite(tps) ? tps.toFixed(1) : "--";
  $("hud-tps").textContent = tpsText;
  $("sp-tps").textContent = tpsText;
  $("sp-ttft").textContent = formatMs(snap.speed.latestTtftMs);
  $("sp-note").textContent = snap.speed.note;
  $("sp-model").textContent = `${snap.model}${snap.reasoningEffort ? ` · ${snap.reasoningEffort}` : ""}`;

  if (snap.status === "streaming") {
    setPill($("sp-pill"), "生成中", "ok");
  } else if (snap.status === "idle") {
    setPill($("sp-pill"), "空闲 · 上轮", "ok");
  } else {
    setPill($("sp-pill"), "等待日志", "info");
  }

  const validSpeeds = snap.speed.recentStepTps.filter((v) => v > 0);
  if (validSpeeds.length > 0) {
    const lo = Math.min(...validSpeeds);
    const hi = Math.max(...validSpeeds);
    $("sp-range").textContent = `${lo.toFixed(0)} – ${hi.toFixed(0)} t/s`;
  } else {
    $("sp-range").textContent = "--";
  }
  renderBarSeries($("sp-bars"), snap.speed.recentStepTps, "speed");

  const llmMs = Math.max(0, snap.speed.lastTurnLlmMs);
  const toolMs = Math.max(0, snap.speed.lastTurnToolMs);
  const totalMs = llmMs + toolMs;
  const llmPct = totalMs > 0 ? Math.round((llmMs / totalMs) * 100) : 100;
  $("sp-llm-sec").textContent = `${(llmMs / 1000).toFixed(1)}s`;
  $("sp-tool-sec").textContent = `${(toolMs / 1000).toFixed(1)}s`;
  $("sp-llm-bar").style.width = `${llmPct}%`;
  $("sp-tool-bar").style.width = `${100 - llmPct}%`;

  // ---- 2. CONTEXT (COLORED PROGRESS BAR) ----
  const ctxPct = Math.max(0, Math.min(100, snap.context.percent));
  const ctxLevel = ctxPct >= 80 ? "danger" : ctxPct >= 60 ? "warn" : "ok";
  const usedK = formatCompactTokens(snap.context.usedTokens);
  const winK = formatCompactTokens(snap.context.windowTokens);
  const remainK = formatCompactTokens(Math.max(0, snap.context.windowTokens - snap.context.usedTokens));

  const miniTrack = $("hud-ctx-track");
  const miniBar = $("hud-ctx-bar");
  const miniPct = $("hud-ctx-pct");

  miniTrack.className = "mini-bar" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`);
  miniBar.className = "mini-bar-fill" + (ctxLevel === "ok" ? "" : ` is-${ctxLevel}`);
  miniBar.style.width = `${ctxPct.toFixed(1)}%`;
  miniPct.textContent = `${Math.round(ctxPct)}%`;
  miniPct.className = "hud-val mono " + (ctxLevel === "ok" ? "is-ctx-ok" : `is-${ctxLevel}`);

  const heroCtxPct = $("ctx-pct");
  heroCtxPct.textContent = `${ctxPct.toFixed(1)}%`;
  heroCtxPct.style.color =
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

  if (ctxLevel === "danger") {
    setPill($("ctx-pill"), "接近压缩", "danger");
    setBanner(
      $("ctx-banner"),
      `当前上下文已达 ${ctxPct.toFixed(1)}%，超过 80% 警戒线，建议新开会话或等待自动压缩。`,
      "danger"
    );
  } else if (ctxLevel === "warn") {
    setPill($("ctx-pill"), "中高水位", "warn");
    setBanner($("ctx-banner"), `当前上下文已占 ${ctxPct.toFixed(1)}%，长上下文可能略微增加首字延迟。`, "warn");
  } else {
    setPill($("ctx-pill"), "余量充足", "info");
    setBanner($("ctx-banner"), null);
  }

  renderBarSeries($("ctx-bars"), snap.context.recentPercents, "ctx");

  // ---- 3. CACHE HIT RATE ----
  const hit = snap.cache.weightedHitRate;
  const hudCache = $("hud-cache-pct");
  if (hit === null) {
    hudCache.textContent = "--";
    hudCache.className = "hud-val mono";
    $("ca-pct").textContent = "--";
    setPill($("ca-pill"), "无输入", "info");
    $("ca-hit-bar").style.width = "0%";
    $("ca-miss-bar").style.width = "100%";
  } else {
    const caLevel = hit < 50 ? "danger" : hit < 80 ? "warn" : "ok";
    hudCache.textContent = `${Math.round(hit)}%`;
    hudCache.className = `hud-val mono is-${caLevel}`;
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

  // ---- 4. TOKENS & RATE LIMITS ----
  $("hud-tokens").textContent = formatCompactTokens(snap.tokens.totalTokens);
  $("tk-total").textContent = formatCompactTokens(snap.tokens.totalTokens);
  $("tk-input").textContent = formatCompactTokens(snap.tokens.inputTokens);
  $("tk-output").textContent = formatCompactTokens(snap.tokens.outputTokens);
  $("tk-reas").textContent = formatCompactTokens(snap.tokens.reasoningOutputTokens);
  $("tk-vis").textContent = formatCompactTokens(snap.tokens.visibleOutputTokens);
  const reasPct = Math.max(0, Math.min(100, Math.round(snap.tokens.reasoningSharePercent)));
  $("tk-reas-pct").textContent = `推理占 ${reasPct}%`;
  $("tk-reas-bar").style.width = `${reasPct}%`;
  $("tk-vis-bar").style.width = `${100 - reasPct}%`;
  $("tk-session").textContent = snap.sessionId ? `会话 ${snap.sessionId.slice(0, 8)}` : "本会话累计";

  const p5 = snap.rateLimits.primary;
  if (p5) {
    const eta = formatResetEta(p5.resetsAtSec);
    $("quota-5h-text").textContent = `${Math.round(p5.usedPercent)}%${eta ? ` · ${eta}` : ""}`;
    $("quota-5h-bar").style.width = `${Math.min(100, Math.max(0, p5.usedPercent))}%`;
  } else {
    $("quota-5h-text").textContent = "暂无配额数据";
    $("quota-5h-bar").style.width = "0%";
  }

  const p7 = snap.rateLimits.secondary;
  if (p7) {
    const eta = formatResetEta(p7.resetsAtSec);
    $("quota-7d-text").textContent = `${Math.round(p7.usedPercent)}%${eta ? ` · ${eta}` : ""}`;
    $("quota-7d-bar").style.width = `${Math.min(100, Math.max(0, p7.usedPercent))}%`;
  } else {
    $("quota-7d-text").textContent = "暂无配额数据";
    $("quota-7d-bar").style.width = "0%";
  }
}

/* ============================================================
   RENDER UPDATE STATUS & PROGRESS
   ============================================================ */
function renderUpdateStatus(status: UpdateStatus): void {
  currentUpdateStatus = status;

  $("upd-local-ver").textContent = status.currentVersion.startsWith("v")
    ? status.currentVersion
    : `v${status.currentVersion}`;
  $("upd-remote-ver").textContent = status.latestVersion
    ? status.latestVersion.startsWith("v")
      ? status.latestVersion
      : `v${status.latestVersion}`
    : "--";

  $("upd-repo-value").textContent = OFFICIAL_GITHUB_REPO;

  const dot = $("update-dot");
  dot.classList.toggle("is-visible", status.state === "available" || status.state === "applied_restart_required");

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
    applied_restart_required: ["待重启生效", "ok"],
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
    applyBtn.textContent = "立即重启生效";
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

  scheduleHitRectSync();
}

function renderUpdateProgress(progress: UpdateProgress): void {
  const wrap = $("upd-progress-wrap");
  wrap.classList.add("is-visible");
  const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));
  $("upd-progress-bar").style.width = `${pct}%`;
  $("upd-progress-pct").textContent = `${pct}%`;
  $("upd-progress-label").textContent = progress.message;
  scheduleHitRectSync();
}

/* ============================================================
   THEME, CONFIG & RUNTIME STATE
   ============================================================ */
function applyTheme(theme: ThemePreference): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = theme === "system" ? "light dark" : theme;
  }
  document.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.theme === theme));
  });
  try {
    if (theme === "system") localStorage.removeItem("codex-hud-color-scheme");
    else localStorage.setItem("codex-hud-color-scheme", theme);
  } catch {}
}

function renderConfig(cfg: OverlayConfig): void {
  currentConfig = cfg;
  applyTheme(cfg.theme);

  $("upd-repo-value").textContent = OFFICIAL_GITHUB_REPO;
  $("offset-readout").textContent = `(${cfg.offsetX}, ${cfg.offsetY})`;
  $<HTMLInputElement>("chk-focused-only").checked = cfg.onlyWhenCodexFocused;
  $<HTMLInputElement>("chk-hide-approval").checked = cfg.hideOnApprovalDialog;
}

function renderRuntimeState(state: OverlayRuntimeState): void {
  document.body.dataset.attached = String(state.attachedToCodex);
  const labelMap: Record<OverlayRuntimeState["alignmentSource"], string> = {
    uia: "已吸附 Codex (UIA) · 保留 ~/.codex-dashboard/ 配置",
    dwm: "已吸附 Codex (DWM) · 保留 ~/.codex-dashboard/ 配置",
    standalone: "独立浮窗模式 · 保留 ~/.codex-dashboard/ 配置",
    hidden: "已自动隐藏"
  };
  $("runtime-attach-text").textContent = labelMap[state.alignmentSource];
}

async function saveConfigPatch(patch: Partial<OverlayConfig>): Promise<void> {
  const next: OverlayConfig = { ...currentConfig, ...patch };
  renderConfig(next);
  if (api) {
    const saved = await api.updateConfig(patch);
    renderConfig(saved);
  }
}

/* ============================================================
   PRECISION HIT-RECT REPORTER FOR ELECTRON win.setShape()
   ============================================================ */
let hitRectRaf = 0;

function computeInteractiveRects(): HitRect[] {
  const rects: HitRect[] = [];
  const pushRect = (el: HTMLElement, pad: number): void => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const x = Math.max(0, Math.floor(r.left - pad));
    const y = Math.max(0, Math.floor(r.top - pad));
    const width = Math.ceil(r.right + pad) - x;
    const height = Math.ceil(r.bottom + pad) - y;
    rects.push({ x, y, width, height });
  };

  pushRect($("hud-group"), 4);

  for (const [, popId] of POPOVER_PAIRS) {
    const pop = $(popId);
    if (pop.matches(":popover-open")) {
      pushRect(pop, 8);
    }
  }
  return rects;
}

function scheduleHitRectSync(): void {
  if (!api) return;
  if (hitRectRaf) cancelAnimationFrame(hitRectRaf);
  hitRectRaf = requestAnimationFrame(() => {
    hitRectRaf = 0;
    api.reportHitRects(computeInteractiveRects());
  });
}

/* ============================================================
   WIRE INTERACTIVE CONTROLS & IPC SUBSCRIPTIONS
   ============================================================ */
function wireInteractions(): void {
  const ro = new ResizeObserver(() => scheduleHitRectSync());
  ro.observe($("hud-group"));

  for (const [btnId, popId] of POPOVER_PAIRS) {
    const btn = $(btnId);
    const pop = $(popId);
    ro.observe(pop);

    pop.addEventListener("toggle", (e) => {
      const toggleEvent = e as ToggleEvent;
      const isOpen = toggleEvent.newState === "open";
      btn.setAttribute("aria-expanded", String(isOpen));
      btn.dataset.open = String(isOpen);

      if (!isOpen && (pop.contains(document.activeElement) || document.activeElement === document.body)) {
        btn.focus({ preventScroll: true });
      }
      if (isOpen) {
        // Immediately register opened popover rect so clicks work on the first frame
        api?.reportHitRects(computeInteractiveRects());
        scheduleHitRectSync();
      } else {
        // Wait for top-layer exit transition so visual exit isn't clipped prematurely
        setTimeout(scheduleHitRectSync, 210);
      }
    });

    pop.addEventListener("transitionend", () => {
      scheduleHitRectSync();
    });
  }

  $("settings-details").addEventListener("toggle", () => {
    scheduleHitRectSync();
  });

  window.addEventListener("resize", () => scheduleHitRectSync());

  // Theme buttons
  document.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const theme = btn.dataset.theme as ThemePreference;
      void saveConfigPatch({ theme });
    });
  });

  // Nudge offset calibration (hold Shift for 20px coarse steps)
  document.querySelectorAll<HTMLButtonElement>("[data-nudge]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const raw = btn.dataset.nudge ?? "";
      if (raw === "reset") {
        void saveConfigPatch({
          offsetX: DEFAULT_OVERLAY_CONFIG.offsetX,
          offsetY: DEFAULT_OVERLAY_CONFIG.offsetY
        });
        return;
      }
      const mult = e.shiftKey ? 5 : 1;
      const [dx, dy] = raw.split(",").map(Number);
      void saveConfigPatch({
        offsetX: currentConfig.offsetX + (dx || 0) * mult,
        offsetY: currentConfig.offsetY + (dy || 0) * mult
      });
    });
  });

  // Overlay behavior checkboxes
  $<HTMLInputElement>("chk-focused-only").addEventListener("change", (e) => {
    void saveConfigPatch({ onlyWhenCodexFocused: (e.target as HTMLInputElement).checked });
  });

  $<HTMLInputElement>("chk-hide-approval").addEventListener("change", (e) => {
    void saveConfigPatch({ hideOnApprovalDialog: (e.target as HTMLInputElement).checked });
  });

  // Update buttons (fixed official repository)
  $("btn-check-now").addEventListener("click", async () => {
    const repo = OFFICIAL_GITHUB_REPO;
    if (!api) {
      renderUpdateStatus({
        ...currentUpdateStatus,
        state: "up_to_date",
        repo,
        latestVersion: currentUpdateStatus.currentVersion,
        message: "浏览器独立预览模式：启动 Electron 浮窗后可执行真实 GitHub 远程检查。"
      });
      return;
    }
    renderUpdateStatus({ ...currentUpdateStatus, state: "checking", repo, message: "正在检查远程更新…" });
    const status = await api.checkForUpdates(repo);
    renderUpdateStatus(status);
  });

  $("btn-apply-update").addEventListener("click", async () => {
    if (!api) return;
    if (currentUpdateStatus.state === "applied_restart_required") {
      await api.restartApp();
      return;
    }
    const status = await api.applyUpdate();
    renderUpdateStatus(status);
  });
}

async function bootstrap(): Promise<void> {
  wireInteractions();

  if (!api) {
    // Browser standalone preview fallback (no Electron preload)
    document.body.dataset.standalonePreview = "true";
    renderConfig(DEFAULT_OVERLAY_CONFIG);
    renderRuntimeState(createInitialRuntimeState());
    renderSnapshot(createPreviewMockSnapshot());
    renderUpdateStatus(createDefaultUpdateStatus("0.1.0", DEFAULT_OVERLAY_CONFIG));
    return;
  }

  let receivedUpdateStatus = false;
  api.onSnapshot(renderSnapshot);
  api.onConfig(renderConfig);
  api.onRuntimeState(renderRuntimeState);
  api.onUpdateStatus((st) => {
    receivedUpdateStatus = true;
    renderUpdateStatus(st);
  });
  api.onUpdateProgress(renderUpdateProgress);

  const [cfg, rt, snap] = await Promise.all([
    api.getConfig(),
    api.getRuntimeState(),
    api.getSnapshot()
  ]);

  renderConfig(cfg);
  renderRuntimeState(rt);
  renderSnapshot(snap);
  if (!receivedUpdateStatus) {
    renderUpdateStatus(createDefaultUpdateStatus("0.1.0", cfg));
  }
  scheduleHitRectSync();
}

void bootstrap();
