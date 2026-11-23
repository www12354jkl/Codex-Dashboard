import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_OVERLAY_CONFIG, type OverlayConfig } from "../shared/types.js";

export function mergeOverlayConfig(value: unknown, base: OverlayConfig = DEFAULT_OVERLAY_CONFIG): OverlayConfig {
  const patch = value && typeof value === "object" ? value as Partial<OverlayConfig> : {};
  return {
    theme: patch.theme === "system" || patch.theme === "light" || patch.theme === "dark" ? patch.theme : base.theme,
    repo: typeof patch.repo === "string" && patch.repo.trim() ? patch.repo.trim() : base.repo,
    updateChannel: patch.updateChannel === "auto" || patch.updateChannel === "git" || patch.updateChannel === "release"
      ? patch.updateChannel : base.updateChannel,
    alignmentMode: patch.alignmentMode === "auto" || patch.alignmentMode === "manual" ? patch.alignmentMode : base.alignmentMode,
    offsetX: typeof patch.offsetX === "number" && Number.isFinite(patch.offsetX) ? patch.offsetX : base.offsetX,
    offsetY: typeof patch.offsetY === "number" && Number.isFinite(patch.offsetY) ? patch.offsetY : base.offsetY,
    onlyWhenCodexFocused: typeof patch.onlyWhenCodexFocused === "boolean" ? patch.onlyWhenCodexFocused : base.onlyWhenCodexFocused,
    hideOnApprovalDialog: typeof patch.hideOnApprovalDialog === "boolean" ? patch.hideOnApprovalDialog : base.hideOnApprovalDialog
  };
}

export class OverlayConfigStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(readonly filename = path.join(homedir(), ".codex-dashboard", "config.json")) {}

  async load(): Promise<OverlayConfig> {
    await this.pending;
    return this.read();
  }

  update(patch: Partial<OverlayConfig>): Promise<OverlayConfig> {
    const operation = this.pending.then(async () => {
      const config = mergeOverlayConfig(patch, await this.read());
      const directory = path.dirname(this.filename);
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, "." + path.basename(this.filename) + "." + randomUUID() + ".tmp");
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(config, null, 2) + "\n", "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.filename);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
      return config;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }

  private async read(): Promise<OverlayConfig> {
    try {
      return mergeOverlayConfig(JSON.parse(await readFile(this.filename, "utf8")));
    } catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...DEFAULT_OVERLAY_CONFIG };
      }
      throw error;
    }
  }
}

