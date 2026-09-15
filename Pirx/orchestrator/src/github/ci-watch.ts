import { randomUUID } from "node:crypto";

import type { GitHubConfig } from "./config.js";
import {
  failure,
  type GitHubOperationResult,
  type GitHubResponseMetadata,
} from "./outcome.js";
import { executeWithGitHubRetry, type GitHubRetryPolicyOptions } from "./retry-policy.js";
import type { GitHubRequestContext, GitHubRestReadRequest } from "./transport-types.js";

export type GitHubActionsRunStatus = "requested" | "queued" | "waiting" | "pending" | "in_progress" | "completed" | "unknown";
export type GitHubActionsRunConclusion =
  | "success"
  | "failure"
  | "cancelled"
  | "neutral"
  | "skipped"
  | "timed_out"
  | "action_required"
  | "startup_failure"
  | "stale"
  | "unknown";

export interface GitHubActionsWorkflowRun {
  readonly id: number;
  readonly name?: string;
  readonly workflowId?: number;
  readonly runNumber?: number;
  readonly status: GitHubActionsRunStatus;
  readonly conclusion?: GitHubActionsRunConclusion;
  readonly headSha: string;
  readonly headBranch?: string;
  readonly pullRequestNumbers: readonly number[];
  readonly url: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface GitHubActionsStepReference {
  readonly name: string;
  readonly number?: number;
}

export interface GitHubActionsFailedJobReference {
  readonly id: number;
  readonly name: string;
  readonly url?: string;
  readonly failedSteps: readonly GitHubActionsStepReference[];
}

export interface GitHubActionsRunJobs {
  readonly failedJobs: readonly GitHubActionsFailedJobReference[];
}

export interface GitHubActionsReadGateway {
  getWorkflowRun(
    runId: number,
    context: GitHubRequestContext,
  ): Promise<GitHubOperationResult<GitHubActionsWorkflowRun>>;
  listWorkflowRunsForPullRequest(
    pullRequestNumber: number,
    context: GitHubRequestContext,
  ): Promise<GitHubOperationResult<readonly GitHubActionsWorkflowRun[]>>;
  listWorkflowRunJobs(
    runId: number,
    context: GitHubRequestContext,
  ): Promise<GitHubOperationResult<GitHubActionsRunJobs>>;
}

export interface GitHubActionsReadTransport {
  restRead<T>(
    request: GitHubRestReadRequest,
    context: GitHubRequestContext,
  ): Promise<GitHubOperationResult<T>>;
}

export interface GitHubActionsGatewayOptions {
  readonly retryPolicy?: GitHubRetryPolicyOptions;
}

interface RestWorkflowRun {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly workflow_id?: unknown;
  readonly run_number?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly head_sha?: unknown;
  readonly head_branch?: unknown;
  readonly html_url?: unknown;
  readonly pull_requests?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
}

interface RestWorkflowRunsPayload {
  readonly workflow_runs?: unknown;
}

interface RestJobStep {
  readonly name?: unknown;
  readonly number?: unknown;
  readonly conclusion?: unknown;
}

interface RestJob {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly html_url?: unknown;
  readonly conclusion?: unknown;
  readonly steps?: unknown;
}

interface RestJobsPayload {
  readonly jobs?: unknown;
}

const DEFAULT_GATEWAY_RETRY: GitHubRetryPolicyOptions = {
  maxAttempts: 2,
  maxTotalDelayMs: 5_000,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  jitterRatio: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function text(value: unknown, maxLength = 256): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return undefined;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function url(value: unknown): string | undefined {
  const candidate = text(value, 512);
  return candidate !== undefined && /^https:\/\//u.test(candidate) ? candidate : undefined;
}

function timestamp(value: unknown): string | undefined {
  const candidate = text(value, 64);
  if (candidate === undefined || Number.isNaN(Date.parse(candidate))) return undefined;
  return candidate;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["requested", "queued", "waiting", "pending", "in_progress", "completed"]);

function runStatus(value: unknown): GitHubActionsRunStatus {
  return typeof value === "string" && RUN_STATUSES.has(value) ? value as GitHubActionsRunStatus : "unknown";
}

function runConclusion(value: unknown): GitHubActionsRunConclusion | undefined {
  if (value === null || value === undefined) return undefined;
  return value === "success" || value === "failure" || value === "cancelled" || value === "neutral" ||
    value === "skipped" || value === "timed_out" || value === "action_required" || value === "startup_failure" ||
    value === "stale" ? value : "unknown";
}

function pullRequestNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const number = positiveInteger(item.number);
    return number === undefined ? [] : [number];
  });
}

function mapRun(value: unknown): GitHubActionsWorkflowRun | undefined {
  if (!isRecord(value)) return undefined;
  const id = positiveInteger(value.id);
  const headSha = text(value.head_sha, 128);
  const runUrl = url(value.html_url);
  if (id === undefined || headSha === undefined || runUrl === undefined) return undefined;
  const name = text(value.name);
  const workflowId = positiveInteger(value.workflow_id);
  const runNumber = positiveInteger(value.run_number);
  const conclusion = runConclusion(value.conclusion);
  const headBranch = text(value.head_branch);
  const createdAt = timestamp(value.created_at);
  const updatedAt = timestamp(value.updated_at);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(runNumber === undefined ? {} : { runNumber }),
    status: runStatus(value.status),
    ...(conclusion === undefined ? {} : { conclusion }),
    headSha,
    ...(headBranch === undefined ? {} : { headBranch }),
    pullRequestNumbers: pullRequestNumbers(value.pull_requests),
    url: runUrl,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function malformed<T>(correlationId: string, response?: GitHubResponseMetadata): GitHubOperationResult<T> {
  return failure(
    "permanent_error",
    "malformed_response",
    "GitHub returned malformed Actions data.",
    correlationId,
    "not_accepted",
    response,
  );
}

function repositoryPath(config: GitHubConfig): string {
  return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}`;
}

export class GitHubActionsGateway implements GitHubActionsReadGateway {
  readonly #transport: GitHubActionsReadTransport;
  readonly #config: GitHubConfig;
  readonly #retryPolicy: GitHubRetryPolicyOptions;

  constructor(
    transport: GitHubActionsReadTransport,
    config: GitHubConfig,
    options: GitHubActionsGatewayOptions = {},
  ) {
    this.#transport = transport;
    this.#config = config;
    this.#retryPolicy = { ...DEFAULT_GATEWAY_RETRY, ...options.retryPolicy };
  }

  async getWorkflowRun(runId: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubActionsWorkflowRun>> {
    const result = await this.#read<RestWorkflowRun>({
      method: "GET",
      path: `${repositoryPath(this.#config)}/actions/runs/${runId}`,
    }, context);
    if (result.outcome !== "success") return result;
    const run = mapRun(result.value);
    return run === undefined ? malformed(result.correlationId, result.response) : { ...result, value: run };
  }

  async listWorkflowRunsForPullRequest(
    pullRequestNumber: number,
    context: GitHubRequestContext,
  ): Promise<GitHubOperationResult<readonly GitHubActionsWorkflowRun[]>> {
    const result = await this.#read<RestWorkflowRunsPayload>({
      method: "GET",
      path: `${repositoryPath(this.#config)}/actions/runs`,
      query: { event: "pull_request", per_page: 100 },
    }, context);
    if (result.outcome !== "success") return result;
    if (!isRecord(result.value) || !Array.isArray(result.value.workflow_runs)) return malformed(result.correlationId, result.response);
    const runs = result.value.workflow_runs.map(mapRun);
    if (runs.some((run): run is undefined => run === undefined)) return malformed(result.correlationId, result.response);
    return { ...result, value: (runs as GitHubActionsWorkflowRun[]).filter((run) => run.pullRequestNumbers.includes(pullRequestNumber)) };
  }

  async listWorkflowRunJobs(
    runId: number,
    context: GitHubRequestContext,
  ): Promise<GitHubOperationResult<GitHubActionsRunJobs>> {
    const result = await this.#read<RestJobsPayload>({
      method: "GET",
      path: `${repositoryPath(this.#config)}/actions/runs/${runId}/jobs`,
      query: { per_page: 100 },
    }, context);
    if (result.outcome !== "success") return result;
    if (!isRecord(result.value) || !Array.isArray(result.value.jobs)) return malformed(result.correlationId, result.response);
    const failedJobs: GitHubActionsFailedJobReference[] = [];
    for (const rawJob of result.value.jobs) {
      if (!isRecord(rawJob)) return malformed(result.correlationId, result.response);
      const job = rawJob as RestJob;
      const id = positiveInteger(job.id);
      const name = text(job.name, 160);
      if (id === undefined || name === undefined) return malformed(result.correlationId, result.response);
      if (job.conclusion !== "failure" && job.conclusion !== "timed_out" && job.conclusion !== "cancelled" && job.conclusion !== "startup_failure") continue;
      const steps = Array.isArray(job.steps) ? job.steps : [];
      const failedSteps: GitHubActionsStepReference[] = [];
      for (const rawStep of steps) {
        if (!isRecord(rawStep) || (rawStep.conclusion !== "failure" && rawStep.conclusion !== "timed_out" && rawStep.conclusion !== "cancelled")) continue;
        const stepName = text(rawStep.name, 160);
        if (stepName === undefined) continue;
        const stepNumber = positiveInteger(rawStep.number);
        failedSteps.push({
          name: stepName,
          ...(stepNumber === undefined ? {} : { number: stepNumber }),
        });
      }
      const jobUrl = url(job.html_url);
      failedJobs.push({ id, name, ...(jobUrl === undefined ? {} : { url: jobUrl }), failedSteps });
    }
    return { ...result, value: { failedJobs } };
  }

  async #read<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    const decision = await executeWithGitHubRetry<T>({
      operation: "read",
      correlationId: context.correlationId,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      execute: ({ signal }) => this.#transport.restRead<T>(request, {
        correlationId: context.correlationId,
        ...(context.timeoutMs === undefined ? {} : { timeoutMs: context.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      }),
    }, this.#retryPolicy);
    return decision.finalOutcome;
  }
}

export type GitHubActionsWatchErrorOutcome =
  | "invalid_request"
  | "rate_limited"
  | "not_found"
  | "stale"
  | "ambiguous"
  | "provider_error"
  | "unknown"
  | "timeout"
  | "cancelled";

export interface GitHubActionsWatchRequest {
  readonly workflowRunId?: number;
  readonly pullRequestNumber?: number;
  readonly expectedHeadSha?: string;
  /** Exact top-level workflow name required for a PR gate. */
  readonly requiredWorkflowName?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxFailedJobs?: number;
  readonly maxFailedSteps?: number;
  readonly correlationId?: string;
  readonly signal?: AbortSignal;
}

interface WatchIdentity {
  readonly workflowRunId?: number;
  readonly pullRequestNumber?: number;
  readonly expectedHeadSha?: string;
}

export interface GitHubActionsWatchTerminalResult extends WatchIdentity {
  readonly outcome: "success" | "failed" | "cancelled";
  readonly repository: string;
  readonly testedRevision: string;
  readonly status: "completed";
  readonly conclusion: GitHubActionsRunConclusion;
  readonly runUrl: string;
  readonly workflowName?: string;
  readonly failedJobs?: readonly GitHubActionsFailedJobReference[];
  /** Set when the run failed but its job details could not be read; failedJobs is then absent. */
  readonly failedJobsErrorCode?: string;
  readonly polls: number;
  readonly providerAttempts: number;
}

export interface GitHubActionsWatchErrorResult extends WatchIdentity {
  readonly outcome: GitHubActionsWatchErrorOutcome;
  readonly repository: string;
  readonly errorCode: string;
  readonly message: string;
  readonly polls: number;
  readonly providerAttempts: number;
}

export type GitHubActionsWatchResult = GitHubActionsWatchTerminalResult | GitHubActionsWatchErrorResult;

export interface GitHubActionsWatchClock {
  now(): number;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
}

export interface GitHubActionsWatcherOptions {
  readonly clock?: GitHubActionsWatchClock;
  readonly maxTimeoutMs?: number;
  readonly maxPollIntervalMs?: number;
  readonly maxFailedJobs?: number;
  readonly maxFailedSteps?: number;
}

const defaultClock: GitHubActionsWatchClock = {
  now: () => Date.now(),
  sleep: (delayMs, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("CI watch was cancelled.", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("CI watch was cancelled.", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

function requestIdentity(request: GitHubActionsWatchRequest): WatchIdentity {
  return {
    ...(request.workflowRunId === undefined ? {} : { workflowRunId: request.workflowRunId }),
    ...(request.pullRequestNumber === undefined ? {} : { pullRequestNumber: request.pullRequestNumber }),
    ...(request.expectedHeadSha === undefined ? {} : { expectedHeadSha: request.expectedHeadSha }),
  };
}

function invalidResult(config: GitHubConfig, request: GitHubActionsWatchRequest, message: string): GitHubActionsWatchErrorResult {
  return { outcome: "invalid_request", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: "invalid_request", message, polls: 0, providerAttempts: 0 };
}

function safeHead(value: string): boolean {
  return value.length >= 4 && value.length <= 128 && /^[A-Za-z0-9._-]+$/u.test(value);
}

function mapProviderFailure(
  config: GitHubConfig,
  request: GitHubActionsWatchRequest,
  result: Exclude<GitHubOperationResult<unknown>, { outcome: "success" }>,
  polls: number,
  providerAttempts: number,
  deadlineExpired: boolean,
): GitHubActionsWatchErrorResult {
  if (deadlineExpired || result.error.code === "timeout") {
    return { outcome: "timeout", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: "timeout", message: "GitHub Actions watch timed out.", polls, providerAttempts };
  }
  if (result.error.code === "cancelled") {
    return { outcome: "cancelled", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: "cancelled", message: "GitHub Actions watch was cancelled.", polls, providerAttempts };
  }
  if (result.outcome === "rate_limited" || result.error.code === "rate_limited") {
    return { outcome: "rate_limited", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: "rate_limited", message: "GitHub rate limit prevented the CI watch.", polls, providerAttempts };
  }
  if (result.error.code === "not_found") {
    return { outcome: "not_found", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: "not_found", message: "The requested GitHub Actions run was not found.", polls, providerAttempts };
  }
  if (result.error.code === "validation_failed") {
    return { outcome: "stale", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: "stale", message: "The pull request has Actions runs, but none tests the requested head revision.", polls, providerAttempts };
  }
  if (result.error.code === "conflict") {
    return { outcome: "ambiguous", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: "ambiguous", message: "Multiple GitHub Actions runs match the requested pull request head.", polls, providerAttempts };
  }
  if (result.outcome === "unknown") {
    return { outcome: "unknown", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: result.error.code, message: "GitHub returned an unknown CI watch result.", polls, providerAttempts };
  }
  return { outcome: "provider_error", repository: `${config.owner}/${config.repository}`, ...requestIdentity(request), errorCode: result.error.code, message: "GitHub provider failed while observing Actions.", polls, providerAttempts };
}

export class GitHubActionsWatcher {
  readonly #gateway: GitHubActionsReadGateway;
  readonly #config: GitHubConfig;
  readonly #clock: GitHubActionsWatchClock;
  readonly #maxTimeoutMs: number;
  readonly #maxPollIntervalMs: number;
  readonly #maxFailedJobs: number;
  readonly #maxFailedSteps: number;

  constructor(gateway: GitHubActionsReadGateway, config: GitHubConfig, options: GitHubActionsWatcherOptions = {}) {
    this.#gateway = gateway;
    this.#config = config;
    this.#clock = options.clock ?? defaultClock;
    this.#maxTimeoutMs = options.maxTimeoutMs ?? 300_000;
    this.#maxPollIntervalMs = options.maxPollIntervalMs ?? 60_000;
    this.#maxFailedJobs = options.maxFailedJobs ?? 10;
    this.#maxFailedSteps = options.maxFailedSteps ?? 20;
  }

  async watch(request: GitHubActionsWatchRequest): Promise<GitHubActionsWatchResult> {
    const validation = this.#validate(request);
    if (validation !== undefined) return invalidResult(this.#config, request, validation);
    const timeoutMs = request.timeoutMs ?? 60_000;
    const pollIntervalMs = request.pollIntervalMs ?? 2_000;
    const maxFailedJobs = request.maxFailedJobs ?? this.#maxFailedJobs;
    const maxFailedSteps = request.maxFailedSteps ?? this.#maxFailedSteps;
    const correlationId = request.correlationId?.trim() || randomUUID();
    const startedAt = this.#clock.now();
    const deadline = startedAt + timeoutMs;
    const controller = new AbortController();
    let deadlineExpired = false;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort(new DOMException("CI watch timed out.", "TimeoutError"));
    }, timeoutMs);
    timer.unref?.();
    const abortExternal = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted === true) abortExternal();
    else request.signal?.addEventListener("abort", abortExternal, { once: true });

    let polls = 0;
    let providerAttempts = 0;
    try {
      while (true) {
        if (request.signal?.aborted === true) {
          return { outcome: "cancelled", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), errorCode: "cancelled", message: "GitHub Actions watch was cancelled.", polls, providerAttempts };
        }
        if (this.#clock.now() >= deadline || deadlineExpired) {
          return { outcome: "timeout", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), errorCode: "timeout", message: "GitHub Actions watch timed out.", polls, providerAttempts };
        }
        polls += 1;
        const context: GitHubRequestContext = {
          correlationId,
          signal: controller.signal,
          timeoutMs: Math.max(1, Math.min(this.#config.timeoutMs, deadline - this.#clock.now())),
        };
        const resolved = await this.#resolveRun(request, context);
        providerAttempts += resolved.attempts;
        if (resolved.result.outcome !== "success") {
          // GitHub may acknowledge a PR before its pull_request workflow run is
          // visible through the Actions API. For a named gate, keep polling the
          // bounded window; a gate that never appears still ends fail-closed as
          // timeout rather than being mistaken for green evidence.
          if (request.requiredWorkflowName !== undefined && resolved.result.error.code === "not_found") {
            const remaining = deadline - this.#clock.now();
            if (remaining <= 0) {
              return { outcome: "timeout", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), errorCode: "timeout", message: "The required GitHub Actions workflow did not become observable before the watch timed out.", polls, providerAttempts };
            }
            try {
              await this.#clock.sleep(Math.min(pollIntervalMs, remaining), controller.signal);
            } catch {
              if (request.signal !== undefined && request.signal.aborted) {
                return { outcome: "cancelled", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), errorCode: "cancelled", message: "GitHub Actions watch was cancelled.", polls, providerAttempts };
              }
              return { outcome: "timeout", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), errorCode: "timeout", message: "The required GitHub Actions workflow did not become observable before the watch timed out.", polls, providerAttempts };
            }
            continue;
          }
          return mapProviderFailure(this.#config, request, resolved.result, polls, providerAttempts, deadlineExpired);
        }
        const run = resolved.result.value;
        if (run.status === "unknown") {
          return { outcome: "unknown", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), workflowRunId: run.id, errorCode: "unknown_status", message: "GitHub returned an unsupported Actions run status.", polls, providerAttempts };
        }
        if (run.status === "completed") {
          if (run.conclusion === undefined || run.conclusion === "unknown") {
            return { outcome: "unknown", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), workflowRunId: run.id, errorCode: "unknown_conclusion", message: "GitHub returned an unsupported Actions conclusion.", polls, providerAttempts };
          }
          const terminal = this.#terminal(run, request, polls, providerAttempts);
          if (terminal.outcome === "failed") {
            const jobs = await this.#gateway.listWorkflowRunJobs(run.id, context);
            providerAttempts += 1;
            if (jobs.outcome === "success") {
              return {
                ...terminal,
                failedJobs: jobs.value.failedJobs.slice(0, maxFailedJobs).map((job) => ({
                  ...job,
                  failedSteps: job.failedSteps.slice(0, maxFailedSteps),
                })),
              };
            }
            return { ...terminal, failedJobsErrorCode: jobs.error.code };
          }
          return terminal;
        }
        const remaining = deadline - this.#clock.now();
        if (remaining <= 0) continue;
        try {
          await this.#clock.sleep(Math.min(pollIntervalMs, remaining), controller.signal);
        } catch {
          if (request.signal !== undefined && request.signal.aborted) {
            return { outcome: "cancelled", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), errorCode: "cancelled", message: "GitHub Actions watch was cancelled.", polls, providerAttempts };
          }
          return { outcome: "timeout", repository: `${this.#config.owner}/${this.#config.repository}`, ...requestIdentity(request), errorCode: "timeout", message: "GitHub Actions watch timed out.", polls, providerAttempts };
        }
      }
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", abortExternal);
    }
  }

  #validate(request: GitHubActionsWatchRequest): string | undefined {
    const hasRun = request.workflowRunId !== undefined;
    const hasPullRequest = request.pullRequestNumber !== undefined;
    if (hasRun === hasPullRequest) return "Provide exactly one of workflowRunId or pullRequestNumber.";
    if (hasRun && (!Number.isSafeInteger(request.workflowRunId) || request.workflowRunId! <= 0 || request.expectedHeadSha !== undefined)) return "workflowRunId must be positive and cannot be combined with expectedHeadSha.";
    if (hasPullRequest && (!Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber! <= 0 || request.expectedHeadSha === undefined || !safeHead(request.expectedHeadSha))) return "pullRequestNumber requires a bounded expectedHeadSha.";
    if (request.requiredWorkflowName !== undefined && (request.workflowRunId !== undefined || request.requiredWorkflowName.trim().length === 0 || request.requiredWorkflowName.length > 256 || /[\u0000-\u001f\u007f]/u.test(request.requiredWorkflowName))) return "requiredWorkflowName is only valid for a pull-request watch and must be bounded.";
    const timeoutMs = request.timeoutMs ?? 60_000;
    const pollIntervalMs = request.pollIntervalMs ?? 2_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.#maxTimeoutMs) return `timeoutMs must be a positive integer no greater than ${this.#maxTimeoutMs}.`;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > this.#maxPollIntervalMs) return `pollIntervalMs must be a positive integer no greater than ${this.#maxPollIntervalMs}.`;
    if (request.maxFailedJobs !== undefined && (!Number.isSafeInteger(request.maxFailedJobs) || request.maxFailedJobs < 0 || request.maxFailedJobs > this.#maxFailedJobs)) return `maxFailedJobs must be between 0 and ${this.#maxFailedJobs}.`;
    if (request.maxFailedSteps !== undefined && (!Number.isSafeInteger(request.maxFailedSteps) || request.maxFailedSteps < 0 || request.maxFailedSteps > this.#maxFailedSteps)) return `maxFailedSteps must be between 0 and ${this.#maxFailedSteps}.`;
    if (request.correlationId !== undefined && (request.correlationId.trim().length === 0 || request.correlationId.length > 256)) return "correlationId must be bounded and non-empty.";
    return undefined;
  }

  async #resolveRun(request: GitHubActionsWatchRequest, context: GitHubRequestContext): Promise<{ readonly result: GitHubOperationResult<GitHubActionsWorkflowRun>; readonly attempts: number }> {
    if (request.workflowRunId !== undefined) {
      return { result: await this.#gateway.getWorkflowRun(request.workflowRunId, context), attempts: 1 };
    }
    const result = await this.#gateway.listWorkflowRunsForPullRequest(request.pullRequestNumber!, context);
    if (result.outcome !== "success") return { result, attempts: 1 };
    const matches = result.value.filter((run) => run.headSha === request.expectedHeadSha && (request.requiredWorkflowName === undefined || run.name === request.requiredWorkflowName));
    if (matches.length === 0) {
      const candidates = result.value.filter((run) => request.requiredWorkflowName === undefined || run.name === request.requiredWorkflowName);
      return {
        result: failure("permanent_error", candidates.length === 0 ? "not_found" : "validation_failed", candidates.length === 0 ? (request.requiredWorkflowName === undefined ? "No GitHub Actions run matches the requested pull request head." : "No GitHub Actions run matches the requested pull request head and required workflow.") : "An Actions run exists for the pull request, but it tests a different head revision.", result.correlationId, "not_accepted", result.response),
        attempts: 1,
      };
    }
    if (matches.length > 1) {
      return {
        result: failure("permanent_error", "conflict", request.requiredWorkflowName === undefined ? "Multiple GitHub Actions runs match the requested pull request head." : "Multiple GitHub Actions runs match the requested pull request head and required workflow.", result.correlationId, "not_accepted", result.response),
        attempts: 1,
      };
    }
    return { result: { ...result, value: matches[0]! }, attempts: 1 };
  }

  #terminal(run: GitHubActionsWorkflowRun, request: GitHubActionsWatchRequest, polls: number, providerAttempts: number): GitHubActionsWatchTerminalResult {
    const conclusion = run.conclusion ?? "unknown";
    const outcome = conclusion === "success" ? "success" : conclusion === "cancelled" ? "cancelled" : "failed";
    return {
      outcome,
      repository: `${this.#config.owner}/${this.#config.repository}`,
      ...requestIdentity(request),
      workflowRunId: run.id,
      testedRevision: run.headSha,
      status: "completed",
      conclusion,
      runUrl: run.url,
      ...(run.name === undefined ? {} : { workflowName: run.name }),
      polls,
      providerAttempts,
    };
  }
}
