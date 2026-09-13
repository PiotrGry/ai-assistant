import assert from "node:assert/strict";
import test from "node:test";

import { createErrorReporter, loadGpuSamplerConfig } from "../src/gpu/gpu-sampler-config.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

test("GPU sampler defaults to one sample per second for seven days in the Pirx data directory", () => {
  assert.deepEqual(loadGpuSamplerConfig({}, "/home/tester"), {
    databasePath: "/home/tester/.local/share/pirx/gpu.sqlite",
    intervalMs: 1_000,
    retentionMs: 7 * DAY_MS,
  });
});

test("GPU sampler honours XDG_DATA_HOME and explicit overrides", () => {
  assert.equal(loadGpuSamplerConfig({ XDG_DATA_HOME: "/data" }, "/home/tester").databasePath, "/data/pirx/gpu.sqlite");
  assert.deepEqual(
    loadGpuSamplerConfig(
      { PIRX_GPU_DB: "/tmp/gpu.sqlite", PIRX_GPU_INTERVAL_MS: "5000", PIRX_GPU_RETENTION_DAYS: "30" },
      "/home/tester",
    ),
    { databasePath: "/tmp/gpu.sqlite", intervalMs: 5_000, retentionMs: 30 * DAY_MS },
  );
});

test("GPU sampler rejects invalid numbers before it starts", () => {
  assert.throws(() => loadGpuSamplerConfig({ PIRX_GPU_INTERVAL_MS: "0" }, "/home/tester"), /PIRX_GPU_INTERVAL_MS/u);
  assert.throws(() => loadGpuSamplerConfig({ PIRX_GPU_RETENTION_DAYS: "tydzień" }, "/home/tester"), /PIRX_GPU_RETENTION_DAYS/u);
});

test("error reporter logs a failure once until the message changes or sampling recovers", () => {
  const lines: string[] = [];
  const reporter = createErrorReporter((line) => lines.push(line));

  reporter.error(new Error("nvidia-smi: command not found"));
  reporter.error(new Error("nvidia-smi: command not found"));
  reporter.error(new Error("database is locked"));
  reporter.sample();
  reporter.sample();
  reporter.error(new Error("database is locked"));

  assert.deepEqual(lines, [
    "GPU sampler error: nvidia-smi: command not found",
    "GPU sampler error: database is locked",
    "GPU sampler recovered after 3 failed samples",
    "GPU sampler error: database is locked",
  ]);
});
