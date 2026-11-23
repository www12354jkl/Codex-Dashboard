import { build } from "esbuild";
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const includeTests = process.argv.includes("--tests");

await mkdir(path.join(distDir, "overlay"), { recursive: true });
await mkdir(path.join(distDir, "ui"), { recursive: true });
await mkdir(path.join(distDir, "updater"), { recursive: true });
await mkdir(path.join(distDir, "cdp"), { recursive: true });

// 1. Electron Main Process (ESM)
await build({
  entryPoints: [path.join(root, "overlay", "main.ts")],
  outfile: path.join(distDir, "overlay", "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron", "node:sqlite"],
  sourcemap: true
});

// 2. Electron Sandboxed Preload (MUST be CommonJS .cjs for sandbox: true)
await build({
  entryPoints: [path.join(root, "overlay", "preload.ts")],
  outfile: path.join(distDir, "overlay", "preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true
});

// 3. Renderer UI Bundle (Browser ESM)
await build({
  entryPoints: [path.join(root, "ui", "renderer.ts")],
  outfile: path.join(distDir, "ui", "renderer.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "chrome134",
  sourcemap: true
});

// Copy static UI assets
await cp(path.join(root, "ui", "index.html"), path.join(distDir, "ui", "index.html"));
await cp(path.join(root, "ui", "styles.css"), path.join(distDir, "ui", "styles.css"));

// Copy post-exit atomic swap helper if present
try {
  await cp(
    path.join(root, "updater", "applyStaged.mjs"),
    path.join(distDir, "updater", "applyStaged.mjs")
  );
} catch {
  // updater helper may not exist yet during early scaffold
}

// 4. Optional standalone collector bundle for smoke script
await build({
  entryPoints: [path.join(root, "collector", "service.ts")],
  outfile: path.join(distDir, "collector", "service.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:sqlite"],
  sourcemap: true
}).catch(() => {
  // collector/service.ts may not exist yet before parallel build completes
});

// 4b. CDP Shadow DOM inline widget (IIFE browser script) & Node CDP host/launcher
await build({
  entryPoints: [path.join(root, "cdp", "widget.ts")],
  outfile: path.join(distDir, "cdp", "widget.js"),
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome134",
  sourcemap: false
}).catch(() => {
  // cdp/widget.ts may not exist yet before parallel build completes
});

await build({
  entryPoints: [path.join(root, "cdp", "launcher.ts")],
  outfile: path.join(distDir, "cdp", "launcher.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["node:sqlite"],
  sourcemap: true
}).catch(() => {
  // cdp/launcher.ts may not exist yet before parallel build completes
});

await build({
  entryPoints: [path.join(root, "cdp", "trayApp.ts")],
  outfile: path.join(distDir, "cdp", "trayApp.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron", "node:sqlite"],
  sourcemap: true
});

// 5. Optional test bundles
if (includeTests) {
  const testsDir = path.join(root, "tests");
  const files = (await readdir(testsDir)).filter((f) => f.endsWith(".test.ts"));
  if (files.length > 0) {
    await mkdir(path.join(distDir, "tests"), { recursive: true });
    await build({
      entryPoints: files.map((f) => path.join(testsDir, f)),
      outdir: path.join(distDir, "tests"),
      outExtension: { ".js": ".mjs" },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["electron", "node:sqlite"],
      sourcemap: true
    });
  }
}

console.log("[build] done");
