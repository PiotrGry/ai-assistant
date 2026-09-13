import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { GpuSampler } from "./gpu/gpu-sampler.js";
import { createErrorReporter, loadGpuSamplerConfig } from "./gpu/gpu-sampler-config.js";
import { GpuStore } from "./gpu/gpu-store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

async function main(): Promise<void> {
  const config = loadGpuSamplerConfig();
  await mkdir(dirname(config.databasePath), { recursive: true, mode: 0o700 });
  const store = GpuStore.open(config.databasePath);
  const reporter = createErrorReporter((line) => process.stderr.write(`${line}\n`));
  const sampler = new GpuSampler(store, {
    intervalMs: config.intervalMs,
    retentionMs: config.retentionMs,
    onError: (error) => reporter.error(error),
    onSample: () => reporter.sample(),
  });

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    void sampler.stop().finally(() => {
      store.close();
      process.stdout.write(`GPU sampler stopped (${signal}).\n`);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  process.stdout.write(
    `GPU sampler: ${config.databasePath}, every ${config.intervalMs} ms, keeping ${config.retentionMs / DAY_MS} days.\n`,
  );
  sampler.start();
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`GPU sampler failed to start: ${detail}\n`);
  process.exitCode = 1;
});
