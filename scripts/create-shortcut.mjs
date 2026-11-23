import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { crc32, deflateSync } from "node:zlib";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function buildDashboardIconPng(size = 64) {
  const rgba = Buffer.alloc(size * size * 4);
  const blend = (x, y, r, g, b, alpha) => {
    if (x < 0 || y < 0 || x >= size || y >= size || alpha <= 0) return;
    const a = Math.min(1, alpha);
    const idx = (y * size + x) * 4;
    const dstA = rgba[idx + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    rgba[idx] = Math.round((r * a + rgba[idx] * dstA * (1 - a)) / outA);
    rgba[idx + 1] = Math.round((g * a + rgba[idx + 1] * dstA * (1 - a)) / outA);
    rgba[idx + 2] = Math.round((b * a + rgba[idx + 2] * dstA * (1 - a)) / outA);
    rgba[idx + 3] = Math.round(outA * 255);
  };

  // Rounded dark squircle background (radius 14 on 64x64)
  const pad = 4;
  const radius = 14;
  const min = pad;
  const max = size - pad - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.max(min + radius, Math.min(max - radius, x));
      const cy = Math.max(min + radius, Math.min(max - radius, y));
      const dist = Math.hypot(x - cx, y - cy);
      if (dist <= radius + 0.8) {
        const edgeAlpha = Math.max(0, Math.min(1, radius + 0.8 - dist));
        const grad = (y - min) / (max - min);
        const bgR = Math.round(24 + grad * 10);
        const bgG = Math.round(26 + grad * 10);
        const bgB = Math.round(35 + grad * 14);
        blend(x, y, bgR, bgG, bgB, edgeAlpha);
        // Subtle light top/outer rim
        if (dist >= radius - 1.3) {
          blend(x, y, 255, 255, 255, edgeAlpha * 0.14);
        }
      }
    }
  }

  // Crisp rising 3-bar telemetry glyph + cobalt context ring accent
  const drawRect = (x0, y0, w, h, r, g, b, corner = 2) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const cx = Math.max(x0 + corner, Math.min(x0 + w - 1 - corner, x));
        const cy = Math.max(y0 + corner, Math.min(y0 + h - 1 - corner, y));
        const d = Math.hypot(x - cx, y - cy);
        if (d <= corner + 0.6) {
          blend(x, y, r, g, b, Math.max(0, Math.min(1, corner + 0.6 - d)));
        }
      }
    }
  };

  // 3 telemetry bars: Blue (Ctx), Emerald (Cache), Crisp White (Speed)
  drawRect(15, 34, 9, 15, 96, 165, 250, 3);
  drawRect(27, 25, 9, 24, 52, 211, 153, 3);
  drawRect(39, 17, 9, 32, 244, 244, 248, 3);

  // Subtle emerald live status dot top-left
  for (let y = 12; y <= 24; y++) {
    for (let x = 13; x <= 25; x++) {
      const d = Math.hypot(x - 19, y - 18);
      if (d <= 4.2) {
        blend(x, y, 52, 211, 153, Math.max(0, Math.min(1, 4.2 - d)));
      }
    }
  }

  // Encode valid PNG
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function wrapPngAsIco(pngBuf, size = 64) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // image count

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12); // offset right after header + 1 entry
  return Buffer.concat([header, entry, pngBuf]);
}

function psEscape(str) {
  return `'${str.replace(/'/g, "''")}'`;
}

async function createWindowsShortcut({ shortcutPath, targetPath, args, workingDir, iconPath, description }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    `$s = $shell.CreateShortcut(${psEscape(shortcutPath)})`,
    `$s.TargetPath = ${psEscape(targetPath)}`,
    `$s.Arguments = ${psEscape(args)}`,
    `$s.WorkingDirectory = ${psEscape(workingDir)}`,
    `$s.IconLocation = ${psEscape(iconPath + ",0")}`,
    `$s.Description = ${psEscape(description)}`,
    "$s.Save()"
  ].join("\n");

  await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" + script
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true }
  );
}

async function resolveSpecialFolder(name) {
  const { stdout } = await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Environment]::GetFolderPath('${name}')`
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true }
  );
  return stdout.trim();
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("快捷方式生成脚本仅支持 Windows。");
  }

  const electronExe = path.join(root, "node_modules", "electron", "dist", "electron.exe");
  const entryScript = path.join(root, "dist", "cdp", "trayApp.mjs");
  if (!existsSync(electronExe)) {
    throw new Error(`未找到 Electron 可执行文件：${electronExe}（请先执行 pnpm install）`);
  }
  if (!existsSync(entryScript)) {
    throw new Error(`未找到构建产物：${entryScript}（请先执行 pnpm run build）`);
  }

  const iconDir = path.join(homedir(), ".codex-dashboard");
  await mkdir(iconDir, { recursive: true });
  const iconPath = path.join(iconDir, "codex-dashboard.ico");
  await writeFile(iconPath, wrapPngAsIco(buildDashboardIconPng(64), 64));

  const desktopDir = await resolveSpecialFolder("Desktop");
  const startMenuProgramsDir = await resolveSpecialFolder("Programs");
  const shortcutName = "Codex (Dashboard).lnk";
  const args = `"${entryScript}"`;
  const description = "无黑框启动 Codex Desktop 并自动同步挂载/退出 Codex Dashboard 仪表盘";

  const created = [];
  if (desktopDir) {
    const desktopLnk = path.join(desktopDir, shortcutName);
    await createWindowsShortcut({
      shortcutPath: desktopLnk,
      targetPath: electronExe,
      args,
      workingDir: root,
      iconPath,
      description
    });
    created.push(desktopLnk);
  }

  if (startMenuProgramsDir) {
    const startMenuLnk = path.join(startMenuProgramsDir, shortcutName);
    await createWindowsShortcut({
      shortcutPath: startMenuLnk,
      targetPath: electronExe,
      args,
      workingDir: root,
      iconPath,
      description
    });
    created.push(startMenuLnk);
  }

  for (const file of created) {
    console.log(`[shortcut] 已创建: ${file}`);
  }
  console.log(`[shortcut] 目标: ${electronExe} ${args}`);
  console.log("[shortcut] 提示：以后双击该快捷方式（或右键固定到任务栏）即可无终端黑框联动启停 Codex 与仪表盘。");
}

void main().catch((error) => {
  console.error("[shortcut] 创建失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
