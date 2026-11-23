import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

function inside(parent, filename) {
  const relative = path.relative(parent, filename);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

async function moveDirectory(source, destination) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (process.platform !== "win32" || attempt >= 7 || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
      await delay(200);
    }
  }
}

export async function stageAndSwapDirectory(target, staged, afterSwap) {
  const sourceInfo = await lstat(staged);
  const targetInfo = await lstat(target);
  if (!sourceInfo.isDirectory() || !targetInfo.isDirectory() || sourceInfo.dev !== targetInfo.dev) {
    throw new Error("Update staging and installation must be real directories on the same volume");
  }
  const [source, destination] = await Promise.all([realpath(staged), realpath(target)]);
  const configDir = path.join(await realpath(homedir()), ".codex-dashboard");
  const configFile = path.join(configDir, "config.json");
  const settings = [configDir, await realpath(configDir).catch(() => configDir),
    await realpath(configFile).catch(() => configFile)];
  if (inside(source, destination) || inside(destination, source)
    || settings.some(filename => inside(destination, filename) || inside(filename, destination)
      || inside(source, filename) || inside(filename, source))) {
    throw new Error("Update staging, installation and settings must occupy separate directories");
  }

  const backup = await mkdtemp(path.join(path.dirname(destination), ".codex-dashboard-backup-"));
  const original = path.join(backup, "original");
  let oldMoved = false;
  let newMoved = false;
  try {
    await moveDirectory(destination, original);
    oldMoved = true;
    await moveDirectory(source, destination);
    newMoved = true;
    await afterSwap?.();
  } catch (error) {
    try {
      if (newMoved) await moveDirectory(destination, source);
      if (oldMoved) await moveDirectory(original, destination);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Rollback could not finish. Original files are in " + original);
    }
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => {});
}

async function waitForExit(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error("Invalid application PID");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      if (error.code !== "EPERM") throw error;
    }
    await delay(200);
  }
  throw new Error("Timed out waiting for the application to exit");
}

function launch(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, args, {
      cwd, env: environment, detached: true, stdio: "ignore", windowsHide: true
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function applyManifest(filename) {
  const update = JSON.parse(await readFile(filename, "utf8"));
  const workspace = path.dirname(path.resolve(filename));
  if (path.dirname(workspace) !== path.dirname(path.resolve(update.target))
    || !path.basename(workspace).startsWith(".codex-dashboard-update-")
    || !inside(workspace, path.resolve(update.staged))
    || path.resolve(update.staged) === workspace
    || typeof update.relaunch !== "boolean" || !path.isAbsolute(update.executable) || !Array.isArray(update.args)
    || !update.args.every(arg => typeof arg === "string")) {
    throw new Error("Invalid update manifest paths");
  }
  await waitForExit(update.pid);
  try {
    const git = await lstat(path.join(update.target, ".git")).catch(error => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (git) throw new Error("Release ZIP cannot replace a Git checkout");
    await stageAndSwapDirectory(update.target, update.staged, update.relaunch
      ? () => launch(update.executable, update.args, update.target) : undefined);
  } catch (error) {
    // Restart a restored installation and leave the manifest for diagnosis.
    if (update.relaunch && !(error instanceof AggregateError)) {
      await launch(update.executable, update.args, update.target).catch(() => {});
    }
    throw error;
  }
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

if (process.argv[1] && path.basename(process.argv[1]) === "applyStaged.mjs"
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--apply-staged") {
  try {
    await applyManifest(process.argv[3]);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

