import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { composerGapScript, overlayPosition } from "../overlay/winTracker.js";
import { DEFAULT_OVERLAY_CONFIG } from "../shared/types.js";

const size = { width: 620, height: 560 };
const codexWindow = { x: 100, y: 50, width: 1200, height: 900 };
const composerSlot = { x: 580, y: 872, width: 280, height: 32 };

test("UIA centers the HUD strip horizontally and vertically in the Composer slot", () => {
  assert.deepEqual(overlayPosition(codexWindow, size, DEFAULT_OVERLAY_CONFIG, { composerSlot }), {
    x: 410, y: 350, alignmentSource: "uia"
  });
});

test("UIA uses the adjacent labeled buttons for its optical center", { skip: process.platform !== "win32" }, () => {
  const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${composerGapScript}
$buttons = @(
    [pscustomobject]@{ Left = 390; Right = 420; Top = 883; Bottom = 907; CenterY = 895; Side = 'left' }
    [pscustomobject]@{ Left = 450; Right = 580; Top = 886; Bottom = 910; CenterY = 898; Side = 'left' }
    [pscustomobject]@{ Left = 860; Right = 980; Top = 890; Bottom = 914; CenterY = 902; Side = 'right' }
    [pscustomobject]@{ Left = 990; Right = 1054; Top = 880; Bottom = 944; CenterY = 912; Side = 'right' }
)
$slots = @(
    Find-ComposerGap $buttons 700
    $buttons[2].Side = $null
    $buttons[3].Side = $null
    Find-ComposerGap $buttons 700
)
[Console]::WriteLine((ConvertTo-Json -InputObject $slots -Compress))
`;
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const [bothLabels, leftLabel] = JSON.parse(execFileSync(powershell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
  ], { encoding: "utf8", windowsHide: true, timeout: 10000 }));

  assert.deepEqual(bothLabels, { x: 580, y: 866, width: 280, height: 64 });
  assert.deepEqual(leftLabel, { x: 580, y: 864, width: 280, height: 64 });
  assert.deepEqual(overlayPosition(codexWindow, size, DEFAULT_OVERLAY_CONFIG, { composerSlot: bothLabels }), {
    x: 410, y: 360, alignmentSource: "uia"
  });
});

test("DWM centers the HUD in the chat area when the window is at least 960 DIP wide", () => {
  const wideWindow = { ...codexWindow, width: 960 };
  assert.deepEqual(overlayPosition(wideWindow, size, DEFAULT_OVERLAY_CONFIG, { composerSlot: null }), {
    x: 390, y: 360, alignmentSource: "dwm"
  });
});

test("DWM uses the full width of a narrow Codex window", () => {
  const narrowWindow = { ...codexWindow, x: -1000, width: 959 };
  assert.deepEqual(overlayPosition(narrowWindow, size, DEFAULT_OVERLAY_CONFIG), {
    x: -830, y: 360, alignmentSource: "dwm"
  });
});

test("positive offsets move the HUD right and up in both attachment modes", () => {
  const config = { ...DEFAULT_OVERLAY_CONFIG, offsetX: 13, offsetY: 9 };
  assert.deepEqual(overlayPosition(codexWindow, size, config, { composerSlot }), {
    x: 423, y: 341, alignmentSource: "uia"
  });
  assert.deepEqual(overlayPosition(codexWindow, size, config), {
    x: 523, y: 351, alignmentSource: "dwm"
  });
});

test("standalone mode anchors the HUD to the bottom center of the work area", () => {
  assert.deepEqual(overlayPosition(codexWindow, size, DEFAULT_OVERLAY_CONFIG, { standalone: true }), {
    x: 390, y: 390, alignmentSource: "standalone"
  });
});
