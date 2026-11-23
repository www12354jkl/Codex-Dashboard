import { readdir, stat } from "node:fs/promises";
import path from "node:path";

async function findIndexedRollout(codexHome: string): Promise<string | null> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"), { readOnly: true });
    try {
      const columns = new Set(db.prepare("PRAGMA table_info(threads)").all().map(row => row.name));
      const updated = columns.has("updated_at_ms") && columns.has("updated_at")
        ? "COALESCE(updated_at_ms, updated_at * 1000)" : columns.has("updated_at_ms") ? "updated_at_ms" : "updated_at";
      const filter = columns.has("archived") ? "AND archived = 0" : "";
      const rows = db.prepare("SELECT rollout_path FROM threads WHERE rollout_path <> '' " + filter
        + " ORDER BY " + updated + " DESC LIMIT 64").all();
      for (const { rollout_path } of rows) {
        if (typeof rollout_path !== "string" || !rollout_path.toLowerCase().endsWith(".jsonl")) continue;
        const filename = path.resolve(codexHome, rollout_path);
        if ((await stat(filename).catch(() => null))?.isFile()) return filename;
      }
    } finally {
      db.close();
    }
  } catch {
    // Older Node versions, locked databases and missing indexes all use the same fallback.
  }
  return null;
}

async function scanRollouts(directory: string): Promise<string | null> {
  let newest: string | null = null;
  let newestMtime = -Infinity;
  const dirs = [directory];
  for (const dir of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const filename = path.join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(filename);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(filename);
    }
    for (const filename of files) {
      const metadata = await stat(filename).catch(() => null);
      if (metadata?.isFile() && (metadata.mtimeMs > newestMtime
        || (metadata.mtimeMs === newestMtime && filename > (newest ?? "")))) {
        newest = filename;
        newestMtime = metadata.mtimeMs;
      }
    }
  }
  return newest;
}

export async function findLatestRollout(codexHome: string): Promise<string | null> {
  return await findIndexedRollout(codexHome) ?? await scanRollouts(path.join(codexHome, "sessions"));
}

