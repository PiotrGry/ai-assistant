import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { ProductionClaudeWorker } from "./claude/production-worker.js";
import { FeatureBranchSyncService } from "./runtime/feature-branch-sync.js";
import { GitHubConfigurationError, loadGitHubConfig, type GitHubConfig } from "./github/config.js";
import { GitHubActionsGateway } from "./github/ci-watch.js";
import { GitHubCiGatewayAdapter } from "./github/ci-adapter.js";
import { GitHubIssueReader } from "./github/issue-read.js";
import { GitHubProjectSynchronizer } from "./github/project-sync.js";
import { GitHubPullRequestGateway } from "./github/pull-request.js";
import { GitHubQueueSnapshotReader } from "./github/queue-snapshot.js";
import { GitHubTransport } from "./github/transport.js";
import { diagnosticContext } from "./runtime/diagnostic-context.js";
import { HeadlessConfigurationError, loadHeadlessOrchestratorConfig } from "./runtime/headless-config.js";
import { HeadlessDeliveryCoordinator } from "./runtime/headless-delivery.js";
import { GitHubQueueReconciler, GitHubQueueSynchronizer } from "./runtime/github-queue-sync.js";
import { HeadlessOrchestratorService, type HeadlessControlPort, type HeadlessDeliveryReconciliationPort, type HeadlessQueueReconciliationPort, type HeadlessServiceEvent } from "./runtime/headless-service.js";
import { SqliteHeadlessControlPort } from "./runtime/orchestrator-control.js";
import { LinuxSystemctlPowerOffAdapter, SqliteHeadlessHostShutdownPort } from "./runtime/host-shutdown.js";
import { ExecutionObservabilityProjector } from "./runtime/execution-observability-persistence.js";
import { withJournalContext } from "./runtime/journal-context.js";
import { runPreflight, type PreflightOptions } from "./runtime/preflight.js";
import { ProductionRuntime } from "./runtime/production-runtime.js";
import { ReleaseMergeCoordinator } from "./runtime/release-merge.js";
import { ShipmentCycleCoordinator } from "./runtime/shipment-coordinator.js";
import { backupRuntimeBeforeMigration, RuntimeSqliteStore, RuntimeStorageError } from "./runtime/sqlite.js";
import { WorkIntakeCoordinator, WorkIntakeQueueReconciler } from "./runtime/work-intake.js";

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

/** Why the daemon did not start, for the journal: bounded, redacted, and never empty. */
function startupFailureReason(error: unknown): string {
  const typed = error instanceof HeadlessConfigurationError || error instanceof RuntimeStorageError || error instanceof GitHubConfigurationError;
  const text = error instanceof Error ? (typed ? error.message : `${error.name}: ${error.message}`) : `A non-error value was thrown: ${String(error)}`;
  return String(diagnosticContext(text.trim() === "" ? "The error carried no message." : text)).slice(0, 512);
}

export interface HeadlessCliOptions {
  readonly queue?: HeadlessQueueReconciliationPort;
  readonly delivery?: HeadlessDeliveryReconciliationPort;
  readonly control?: HeadlessControlPort;
  readonly githubConfigLoader?: (environment: NodeJS.ProcessEnv) => GitHubConfig;
  /** Overrides for `--check`, for deterministic tests. */
  readonly preflight?: Partial<PreflightOptions>;
}

export async function runHeadlessCli(host: HeadlessCliProcess = process, options: HeadlessCliOptions = {}): Promise<number> {
  let runtime: ProductionRuntime | undefined;
  try {
    const config = await loadHeadlessOrchestratorConfig(host.env);
    if (host.argv.slice(2).includes("--migrate")) {
      const backupPath = await backupRuntimeBeforeMigration(config.databasePath, host.env);
      if (backupPath !== undefined) writeEvent(host.stdout, { schemaVersion: 1, event: "runtime_backup_created", outcome: "success", backupPath });
      const store = RuntimeSqliteStore.open({ filename: config.databasePath, environment: host.env, mode: "migrate" });
      store.close();
      writeEvent(host.stdout, { schemaVersion: 1, event: "runtime_migrated", outcome: "success" });
      host.exitCode = 0;
      return 0;
    }
    if (host.argv.slice(2).includes("--check")) {
      // Read-only: reports every missing piece at once, where a normal start would stop at the first.
      const githubEnvironment = (repository: string): NodeJS.ProcessEnv => ({
        ...host.env,
        PIRX_GITHUB_OWNER: repository.split("/")[0], PIRX_GITHUB_REPOSITORY: repository.split("/")[1],
        PIRX_GITHUB_PROJECT_OWNER: config.githubProjectOwner, PIRX_GITHUB_PROJECT_NUMBER: String(config.githubProjectNumber),
        PIRX_GITHUB_API_URL: config.githubApiUrl, PIRX_GITHUB_TIMEOUT_MS: String(config.githubTimeoutMs),
      });
      const loadGitHub = (): GitHubConfig => (options.githubConfigLoader ?? loadGitHubConfig)(githubEnvironment(config.repositories[0]!.repository));
      const findings = await runPreflight(config, {
        environment: host.env,
        openDatabase: () => { RuntimeSqliteStore.open({ filename: config.databasePath, environment: host.env, mode: "existing" }).close(); },
        githubCredentials: () => { loadGitHub(); },
        readQueue: async () => {
          const githubConfig = loadGitHub();
          const snapshot = await new GitHubQueueSnapshotReader(new GitHubTransport(githubConfig), githubConfig).read();
          return snapshot.outcome === "success"
            ? { ok: true, detail: `Project ${config.githubProjectOwner}/${config.githubProjectNumber} was read: ${snapshot.snapshot.items.length} item(s)` }
            : { ok: false, detail: `Project ${config.githubProjectOwner}/${config.githubProjectNumber} could not be read (${snapshot.outcome}): ${snapshot.message}` };
        },
        ...options.preflight,
      });
      const problems = findings.filter((finding) => finding.outcome === "problem").length;
      for (const finding of findings) writeEvent(finding.outcome === "problem" ? host.stderr : host.stdout, { schemaVersion: 1, event: "preflight", outcome: finding.outcome, check: finding.check, reason: finding.detail });
      writeEvent(problems === 0 ? host.stdout : host.stderr, { schemaVersion: 1, event: "preflight_finished", outcome: problems === 0 ? "ok" : "problems", problems, checks: findings.length });
      host.exitCode = problems === 0 ? 0 : 1;
      return host.exitCode;
    }
    const store = RuntimeSqliteStore.open({ filename: config.databasePath, environment: host.env, mode: "existing" });
    const worker = new ProductionClaudeWorker({ store, repositories: config.repositories, environment: host.env, transcriptDirectory: join(dirname(config.databasePath), "worker-logs") });
    const control = options.control ?? new SqliteHeadlessControlPort(store, undefined, (failure) => writeEvent(host.stderr, { schemaVersion: 1, event: "observation_persistence_failed", ...failure }));
    runtime = new ProductionRuntime(store, {
      workerId: config.workerId, provider: config.provider, workerCapabilities: config.workerCapabilities,
      repositories: config.repositories.map(({ repository, repositoryRoot, baseBranch, baseRevision }) => ({ repository, repositoryRoot, baseBranch, baseRevision })),
      worktreeParent: config.worktreeParent, leaseDurationMs: config.leaseDurationMs,
      shutdownTimeoutMs: config.shutdownTimeoutMs, workerTimeoutMs: config.workerTimeoutMs,
      workerOutputBytes: config.workerOutputBytes, workerErrorBytes: config.workerErrorBytes,
      maximumConsecutiveResumeFailures: config.maximumConsecutiveResumeFailures,
      workerAdapters: { get: (provider) => provider === config.provider ? worker : undefined },
      // A renewal fails inside a running cycle, where the service records nothing: write it here.
      onLeaseRenewalFailure: (failure) => {
        const event: HeadlessServiceEvent = Object.freeze({ schemaVersion: 1, event: "lease_renewal", outcome: failure.stopping ? "lease_lost" : "renewal_failed", reason: failure.reason, details: failure });
        try { control.observe(event); } catch { /* Diagnostics cannot affect Lease handling. */ }
        writeEvent(host.stderr, event);
      },
      onWorkerInvocationError: (error) => {
        const event: HeadlessServiceEvent = Object.freeze({ schemaVersion: 1, event: "worker_invocation", outcome: "threw", reason: error.cause, details: error });
        try { control.observe(event); } catch { /* Diagnostics cannot change the recorded execution result. */ }
        writeEvent(host.stderr, event);
      },
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
      const normalQueue = new GitHubQueueReconciler(reader, synchronizer);
      const project = new GitHubProjectSynchronizer(projectGitHub.transport, projectGitHub.githubConfig);
      const intake = new WorkIntakeCoordinator(store, new Map(deliveryRepositories.map((item) => [item.repository.repository, {
        reader: new GitHubIssueReader(item.transport, item.githubConfig),
        project,
      }])));
      return new WorkIntakeQueueReconciler(intake, normalQueue);
    })();
    const delivery = options.delivery ?? new HeadlessDeliveryCoordinator(store, deliveryRepositories.map((item) => ({
      config: item.repository,
      shipment: new ShipmentCycleCoordinator(store, item.pullRequests, item.ci),
      releaseMerge: new ReleaseMergeCoordinator(store, item.pullRequests, item.ci),
      branchSync: new FeatureBranchSyncService(store),
    })), { timeoutMs: config.githubTimeoutMs });
    const service = new HeadlessOrchestratorService(runtime, {
      cycleIntervalMs: config.cycleIntervalMs, errorIntervalMs: config.errorIntervalMs,
      queue, delivery, control,
      hostShutdown: new SqliteHeadlessHostShutdownPort(store, config.databasePath, config.hostPowerOff === undefined ? undefined : new LinuxSystemctlPowerOffAdapter({ timeoutMs: config.hostPowerOff.acceptanceTimeoutMs })),
      observability: new ExecutionObservabilityProjector(store),
      emit: (event) => writeEvent(event.event === "cycle_error" || event.outcome.includes("failed") || event.outcome.includes("timeout") ? host.stderr : host.stdout, withJournalContext(store, event, { workerId: config.workerId, provider: config.provider })),
    });
    const stop = (signal: NodeJS.Signals): void => { void service.stop(signal); };
    host.once("SIGTERM", stop);
    host.once("SIGINT", stop);
    const result = await service.run();
    host.exitCode = result.exitCode;
    return result.exitCode;
  } catch (error: unknown) {
    try { runtime?.close(); } catch { /* preserve the original bounded failure */ }
    const code = error instanceof HeadlessConfigurationError || error instanceof RuntimeStorageError ? error.code : "startup_failure";
    writeEvent(host.stderr, { schemaVersion: 1, event: "startup_failed", outcome: code, reason: startupFailureReason(error) });
    host.exitCode = 1;
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) void runHeadlessCli();
