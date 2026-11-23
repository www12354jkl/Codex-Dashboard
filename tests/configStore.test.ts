import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { OverlayConfigStore } from "../overlay/configStore.js";
import { overlayPosition } from "../overlay/winTracker.js";
import { DEFAULT_OVERLAY_CONFIG, OFFICIAL_GITHUB_REPO } from "../shared/types.js";

test("config loads defaults, merges saved fields, and serializes concurrent patches", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "hud-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "nested", "config.json");
  const store = new OverlayConfigStore(filename);
  assert.equal(DEFAULT_OVERLAY_CONFIG.repo, OFFICIAL_GITHUB_REPO);
  assert.deepEqual(await store.load(), { ...DEFAULT_OVERLAY_CONFIG, offsetX: 0, offsetY: 0 });

  await Promise.all([store.update({ theme: "dark", offsetY: 42 }), store.update({ offsetX: 15, repo: " owner/repo " })]);
  const expected = { ...DEFAULT_OVERLAY_CONFIG, theme: "dark", offsetY: 42, offsetX: 15, repo: "owner/repo" };
  assert.deepEqual(await new OverlayConfigStore(filename).load(), expected);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), expected);
  assert.deepEqual(await readdir(path.dirname(filename)), ["config.json"]);

  await writeFile(filename, JSON.stringify({ theme: "light", repo: "", offsetX: "invalid" }));
  assert.deepEqual(await store.load(), { ...DEFAULT_OVERLAY_CONFIG, theme: "light", offsetX: 0, offsetY: 0 });
  await writeFile(filename, "{incomplete");
  assert.deepEqual(await store.load(), DEFAULT_OVERLAY_CONFIG);
});

test("a failed update leaves the destination intact and the store can retry", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "hud-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "config.json");
  const store = new OverlayConfigStore(filename);
  // A directory at the destination forces the initial read to fail without overwriting anything.
  await mkdir(filename);
  await assert.rejects(store.update({ theme: "dark" }));
  assert.deepEqual(await readdir(dir), ["config.json"]);
  await rm(filename, { recursive: true });
  assert.equal((await store.update({ theme: "light" })).theme, "light");
});

test("persisted offsets apply to both the DWM baseline and the measured Composer slot", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "hud-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "config.json");
  await new OverlayConfigStore(filename).update({ offsetX: 13, offsetY: 9 });
  const config = await new OverlayConfigStore(filename).load();
  const anchor = { x: 100, y: 50, width: 1200, height: 900 };
  const size = { width: 620, height: 560 };
  const composerSlot = { x: 580, y: 882, width: 280, height: 32 };

  assert.deepEqual(overlayPosition(anchor, size, config), { x: 523, y: 351, alignmentSource: "dwm" });
  assert.deepEqual(overlayPosition(anchor, size, config, { composerSlot }), { x: 423, y: 351, alignmentSource: "uia" });
});

