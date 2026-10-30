import { pathToFileURL } from "node:url";

import { ProductionClaudeWorker } from "./claude/production-worker.js";
import { HeadlessConfigurationError, loadHeadlessOrchestratorConfig } from "./runtime/headless-config.js";
import { HeadlessOrchestratorService, type HeadlessServiceEvent } from "./runtime/headless-service.js";
import { ProductionRuntime } from "./runtime/production-runtime.js";
import { RuntimeSqliteStore } from "./runtime/sqlite.js";

export interface HeadlessCliProcess {
  readonly env: NodeJS.ProcessEnv;
  readonly argv: readonly string[];
  once(event: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
  stdout: { write(value: string): unknown };
  stderr: { write(value: string): unknown };
  exitCode: string | number | null | undefined;
}

function writeEvent(target: { write(value: string): unknown }, event: HeadlessServiceEvent | Record<string, unknown>): void {
  target.write(`${JSON.stringify(event)}\n`);
}

export async function runHeadlessCli(host: HeadlessCliProcess = process): Promise<number> {
  let runtime: ProductionRuntime | undefined;
  try {
    const config = await loadHeadlessOrchestratorConfig(host.env);
    const store = RuntimeSqliteStore.open({ filename: config.databasePath });
    const worker = new ProductionClaudeWorker({ store, repositories: config.repositories });
    runtime = new ProductionRuntime(store, {
      workerId: config.workerId, provider: config.provider, workerCapabilities: config.workerCapabilities,
      repositories: config.repositories.map(({ repository, repositoryRoot, baseBranch, baseRevision }) => ({ repository, repositoryRoot, baseBranch, baseRevision })),
      worktreeParent: config.worktreeParent, leaseDurationMs: config.leaseDurationMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs, workerTimeoutMs: config.workerTimeoutMs,
      workerOutputBytes: config.workerOutputBytes, workerErrorBytes: config.workerErrorBytes,
      maximumConsecutiveResumeFailures: config.maximumConsecutiveResumeFailures,
      workerAdapters: { get: (provider) => provider === config.provider ? worker : undefined },
    });
    const service = new HeadlessOrchestratorService(runtime, {
      cycleIntervalMs: config.cycleIntervalMs, errorIntervalMs: config.errorIntervalMs,
      emit: (event) => writeEvent(event.event === "cycle_error" || event.outcome.includes("failed") || event.outcome.includes("timeout") ? host.stderr : host.stdout, event),
    });
    const stop = (signal: NodeJS.Signals): void => { void service.stop(signal); };
    host.once("SIGTERM", stop);
    host.once("SIGINT", stop);
    const result = await service.run();
    host.exitCode = result.exitCode;
    return result.exitCode;
  } catch (error: unknown) {
    try { runtime?.close(); } catch { /* preserve the original bounded failure */ }
    const code = error instanceof HeadlessConfigurationError ? error.code : "startup_failure";
    writeEvent(host.stderr, { schemaVersion: 1, event: "startup_failed", outcome: code });
    host.exitCode = 1;
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) void runHeadlessCli();
