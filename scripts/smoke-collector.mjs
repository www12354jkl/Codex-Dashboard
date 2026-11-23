import { build } from "esbuild";
import { fileURLToPath } from "node:url";

try {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL("../collector/service.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["node:sqlite"],
    logLevel: "silent"
  });
  const moduleUrl = "data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].contents).toString("base64");
  const { TelemetryCollectorService } = await import(moduleUrl);
  const snapshot = await new TelemetryCollectorService().refresh();
  const round = value => value === null ? null : Number(value.toFixed(2));
  console.log(JSON.stringify({
    status: snapshot.status,
    rolloutFound: Boolean(snapshot.rolloutPath),
    context: {
      usedTokens: snapshot.context.usedTokens,
      windowTokens: snapshot.context.windowTokens,
      percent: round(snapshot.context.percent),
      compactionCount: snapshot.context.compactionCount
    },
    tokens: snapshot.tokens,
    cache: {
      weightedHitRate: round(snapshot.cache.weightedHitRate),
      latestStepHitRate: round(snapshot.cache.latestStepHitRate),
      dropAlert: Boolean(snapshot.cache.dropAlert)
    },
    speed: {
      latestStepTps: round(snapshot.speed.latestStepTps),
      avgRecentTps: round(snapshot.speed.avgRecentTps),
      ttftMs: snapshot.speed.latestTtftMs,
      llmMs: snapshot.speed.lastTurnLlmMs,
      toolMs: snapshot.speed.lastTurnToolMs
    }
  }, null, 2));
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? " (" + error.code + ")" : "";
  console.error("Collector smoke test failed" + code);
  process.exitCode = 1;
}

