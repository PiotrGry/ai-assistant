import { pathToFileURL } from "node:url";

import { ProductionClaudeWorker } from "./claude/production-worker.js";
import { loadGitHubConfig, type GitHubConfig } from "./github/config.js";
import { GitHubActionsGateway } from "./github/ci-watch.js";
import { GitHubCiGatewayAdapter } from "./github/ci-adapter.js";
import { GitHubPullRequestGateway } from "./github/pull-request.js";
import { GitHubQueueSnapshotReader } from "./github/queue-snapshot.js";
import { GitHubTransport } from "./github/transport.js";
import { HeadlessConfigurationError, loadHeadlessOrchestratorConfig } from "./runtime/headless-config.js";
import { HeadlessDeliveryCoordinator } from "./runtime/headless-delivery.js";
import { GitHubQueueReconciler, GitHubQueueSynchronizer } from "./runtime/github-queue-sync.js";
import { HeadlessOrchestratorService, type HeadlessDeliveryReconciliationPort, type HeadlessQueueReconciliationPort, type HeadlessServiceEvent } from "./runtime/headless-service.js";
import { ProductionRuntime } from "./runtime/production-runtime.js";
import { ReleaseMergeCoordinator } from "./runtime/release-merge.js";
import { ShipmentCycleCoordinator } from "./runtime/shipment-coordinator.js";
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

export interface HeadlessCliOptions {
  readonly queue?: HeadlessQueueReconciliationPort;
  readonly delivery?: HeadlessDeliveryReconciliationPort;
  readonly githubConfigLoader?: (environment: NodeJS.ProcessEnv) => GitHubConfig;
}

export async function runHeadlessCli(host: HeadlessCliProcess = process, options: HeadlessCliOptions = {}): Promise<number> {
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
    const githubConfigLoader = options.githubConfigLoader ?? loadGitHubConfig;
    const deliveryRepositories = config.repositories.map((repository) => {
      const repositoryParts = repository.repository.split("/");
      const githubConfig = githubConfigLoader({
        ...host.env,
        PIRX_GITHUB_OWNER: repositoryParts[0], PIRX_GITHUB_REPOSITORY: repositoryParts[1],
        PIRX_GITHUB_PROJECT_OWNER: config.githubProjectOwner, PIRX_GITHUB_PROJECT_NUMBER: String(config.githubProjectNumber),
        PIRX_GITHUB_API_URL: config.githubApiUrl, PIRX_GITHUB_TIMEOUT_MS: String(config.githubTimeoutMs),
      });
      const transport = new GitHubTransport(githubConfig);
      const pullRequests = new GitHubPullRequestGateway(transport, githubConfig);
      const ci = new GitHubCiGatewayAdapter(new GitHubActionsGateway(transport, githubConfig), githubConfig);
      return { repository, githubConfig, transport, pullRequests, ci };
    });
    const projectGitHub = deliveryRepositories[0]!;
    const queue = options.queue ?? (() => {
      const reader = new GitHubQueueSnapshotReader(projectGitHub.transport, projectGitHub.githubConfig);
      const synchronizer = new GitHubQueueSynchronizer(store, { workerCapabilities: config.workerCapabilities, repositories: config.repositories.map((item) => item.repository) });
      return new GitHubQueueReconciler(reader, synchronizer);
    })();
    const delivery = options.delivery ?? new HeadlessDeliveryCoordinator(store, deliveryRepositories.map((item) => ({
      config: item.repository,
      shipment: new ShipmentCycleCoordinator(store, item.pullRequests, item.ci),
      releaseMerge: new ReleaseMergeCoordinator(store, item.pullRequests, item.ci),
    })), { timeoutMs: config.githubTimeoutMs });
    const service = new HeadlessOrchestratorService(runtime, {
      cycleIntervalMs: config.cycleIntervalMs, errorIntervalMs: config.errorIntervalMs,
      queue, delivery,
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
