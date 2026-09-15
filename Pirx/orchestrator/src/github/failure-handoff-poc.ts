import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ClaudeHandoffRequest, ClaudeHandoffResult } from "../claude/cli-runner.js";
import type {
  GitHubActionsFailedJobReference,
  GitHubActionsReadGateway,
  GitHubActionsWatchRequest,
  GitHubActionsWatchTerminalResult,
  GitHubActionsWatchResult,
} from "./ci-watch.js";
import type { GitHubConfig } from "./config.js";
import { failure, success, type GitHubOperationResult } from "./outcome.js";
import type {
  GitHubShipmentBranchHead,
  GitHubShipmentCreatePullRequestRequest,
  GitHubShipmentPullRequest,
} from "./shipment-poc.js";
import type { GitHubRequestContext } from "./transport-types.js";

export const FAILURE_HANDOFF_POC_REPOSITORY = "PiotrGry/zdrovena-reconciliation" as const;
export const FAILURE_HANDOFF_POC_FEATURE_BASE = "develop" as const;
export const FAILURE_HANDOFF_POC_WORKFLOW = "Develop — Fast Gate" as const;
export const FAILURE_HANDOFF_POC_SCHEMA_VERSION = 1 as const;
export const FAILURE_HANDOFF_POC_MAX_LOG_BYTES = 8_192;
export const FAILURE_HANDOFF_POC_MAX_EVIDENCE_BYTES = 24_000;

export type GitHubFailureHandoffPocOutcome =
  | "failure_handoff_completed"
  | "unexpected_ci_success"
  | "failure_evidence_unavailable"
  | "worker_handoff_failed"
  | "worker_authentication_required"
  | "worker_quota_exhausted"
  | "pending_or_timeout"
  | "stale_head"
  | "not_found"
  | "ambiguous"
  | "policy_blocked"
  | "authorization_required"
  | "rate_limited"
  | "provider_error"
  | "unknown";

export interface GitHubFailureHandoffPocGateway extends GitHubActionsReadGateway {
  getBranchHead(branch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubShipmentBranchHead>>;
  listPullRequests(headBranch: string, baseBranch: string, context: GitHubRequestContext): Promise<GitHubOperationResult<readonly GitHubShipmentPullRequest[]>>;
  getPullRequest(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubShipmentPullRequest>>;
  createPullRequest(request: GitHubShipmentCreatePullRequestRequest): Promise<GitHubOperationResult<GitHubShipmentPullRequest>>;
  /** Optional provider extension. Failure handoff works with jobs/steps when logs are unavailable. */
  getWorkflowRunLog?(runId: number, context: GitHubRequestContext): Promise<GitHubOperationResult<string>>;
}

export interface GitHubFailureHandoffClaudeRunner {
  runHandoff(request: ClaudeHandoffRequest): Promise<ClaudeHandoffResult>;
}

export interface GitHubFailureHandoffEvidence {
  readonly schemaVersion: typeof FAILURE_HANDOFF_POC_SCHEMA_VERSION;
  readonly repository: typeof FAILURE_HANDOFF_POC_REPOSITORY;
  readonly pullRequest: { readonly number: number; readonly url: string; readonly headBranch: string; readonly headSha: string };
  readonly workflow: { readonly name: string; readonly runId: number; readonly url: string; readonly headSha: string; readonly conclusion: string };
  readonly failedJobs: readonly GitHubActionsFailedJobReference[];
  readonly logExcerpt?: string;
  readonly redactionCount: number;
  readonly evidenceBytes: number;
  readonly evidenceDigest: string;
}

export interface GitHubFailureHandoffReceipt {
  readonly handoffId: string;
  readonly outcome: ClaudeHandoffResult["outcome"];
  readonly acknowledgement?: string;
}

export interface GitHubFailureHandoffPocRecord {
  readonly schemaVersion: typeof FAILURE_HANDOFF_POC_SCHEMA_VERSION;
  readonly eventId: string;
  readonly owner: string;
  readonly repository: string;
  readonly featureBase: typeof FAILURE_HANDOFF_POC_FEATURE_BASE;
  readonly requiredWorkflowName: typeof FAILURE_HANDOFF_POC_WORKFLOW;
  readonly headBranch: string;
  readonly expectedHeadSha: string;
  readonly correlationId: string;
  readonly handoffId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string;
  readonly featurePullRequestNumber?: number;
  readonly featurePullRequestUrl?: string;
  readonly featureRunId?: number;
  readonly featureConclusion?: string;
  readonly evidence?: GitHubFailureHandoffEvidence;
  readonly claudeReceipt?: GitHubFailureHandoffReceipt;
  readonly outcome?: GitHubFailureHandoffPocOutcome;
}

export interface GitHubFailureHandoffPocStore {
  get(eventId: string): Promise<GitHubFailureHandoffPocRecord | undefined>;
  save(record: GitHubFailureHandoffPocRecord): Promise<void>;
}

export class InMemoryGitHubFailureHandoffPocStore implements GitHubFailureHandoffPocStore {
  readonly #records = new Map<string, GitHubFailureHandoffPocRecord>();

  async get(eventId: string): Promise<GitHubFailureHandoffPocRecord | undefined> { return this.#records.get(eventId); }
  async save(record: GitHubFailureHandoffPocRecord): Promise<void> { this.#records.set(record.eventId, record); }
}

export class FileGitHubFailureHandoffPocStore implements GitHubFailureHandoffPocStore {
  readonly #filename: string;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(filename: string) {
    if (filename.trim().length === 0) throw new RangeError("Failure handoff state filename is required.");
    this.#filename = filename;
  }

  async get(eventId: string): Promise<GitHubFailureHandoffPocRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.#filename, "utf8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.records)) return undefined;
      const record = parsed.records[eventId];
      return isRecord(record) ? record as unknown as GitHubFailureHandoffPocRecord : undefined;
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  async save(record: GitHubFailureHandoffPocRecord): Promise<void> {
    const write = this.#writeChain.then(async () => {
      let records: Record<string, GitHubFailureHandoffPocRecord> = {};
      try {
        const parsed = JSON.parse(await readFile(this.#filename, "utf8")) as unknown;
        if (isRecord(parsed) && isRecord(parsed.records)) records = parsed.records as unknown as Record<string, GitHubFailureHandoffPocRecord>;
      } catch (error: unknown) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
      records[record.eventId] = record;
      await mkdir(dirname(this.#filename), { recursive: true, mode: 0o700 });
      const temporary = `${this.#filename}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ schemaVersion: FAILURE_HANDOFF_POC_SCHEMA_VERSION, records }), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#filename);
      await chmod(this.#filename, 0o600);
    });
    this.#writeChain = write.catch(() => undefined);
    await write;
  }
}

export interface GitHubFailureHandoffPocRequest {
  readonly eventId: string;
  readonly headBranch: string;
  readonly expectedHeadSha: string;
  readonly requiredWorkflowName?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxFailedJobs?: number;
  readonly maxFailedSteps?: number;
  readonly maxLogBytes?: number;
  readonly claudeTimeoutMs?: number;
  readonly correlationId?: string;
  readonly signal?: AbortSignal;
}

export interface GitHubFailureHandoffPocResult {
  readonly outcome: GitHubFailureHandoffPocOutcome;
  readonly repository: typeof FAILURE_HANDOFF_POC_REPOSITORY;
  readonly featureBase: typeof FAILURE_HANDOFF_POC_FEATURE_BASE;
  readonly requiredWorkflowName: typeof FAILURE_HANDOFF_POC_WORKFLOW;
  readonly eventId: string;
  readonly headBranch: string;
  readonly expectedHeadSha: string;
  readonly correlationId: string;
  readonly handoffId: string;
  readonly message: string;
  readonly errorCode?: string;
  readonly pullRequest?: { readonly number: number; readonly url: string; readonly headSha: string; readonly state: string; readonly merged: boolean };
  readonly run?: { readonly id: number; readonly name: string; readonly url: string; readonly headSha: string; readonly conclusion: string };
  readonly evidence?: GitHubFailureHandoffEvidence;
  readonly claudeReceipt?: GitHubFailureHandoffReceipt;
  readonly replayed: boolean;
  readonly updatedAt: string;
}

interface SanitizedText { readonly value: string; readonly redactions: number; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isNodeError(value: unknown, code: string): boolean { return isRecord(value) && value.code === code; }
function sha(value: string): boolean { return /^[A-Za-z0-9._-]{4,128}$/u.test(value); }
function text(value: string, max: number): boolean { return value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function marker(eventId: string): string { return `<!-- pirx-failure-handoff-poc:v1 event=${digest(eventId)} -->`; }

export function sanitizeFailureText(input: string): SanitizedText {
  const patterns: readonly RegExp[] = [
    /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
    /\b(?:proxy-)?authorization\s*:\s*[^\r\n]+/giu,
    /\bbearer\s+[A-Za-z0-9._~+/=-]+/giu,
    /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/giu,
    /\b(?:password|passwd|pwd|secret|token|api[_-]?key|connection(?:string)?|client[_-]?secret)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/giu,
    /\b(?:ghp_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9_-])[A-Za-z0-9._-]+/gu,
  ];
  let value = input;
  let redactions = 0;
  for (const pattern of patterns) {
    value = value.replace(pattern, () => { redactions += 1; return "[REDACTED]"; });
  }
  return { value, redactions };
}

function boundedSanitized(input: string, maxBytes: number): SanitizedText {
  const sanitized = sanitizeFailureText(input);
  const bytes = Buffer.from(sanitized.value, "utf8");
  if (bytes.byteLength <= maxBytes) return sanitized;
  const bounded = bytes.subarray(0, maxBytes).toString("utf8").replace(/[\uFFFD]$/u, "");
  return { value: `${bounded}\n[TRUNCATED]`, redactions: sanitized.redactions };
}

function sanitizeJobs(jobs: readonly GitHubActionsFailedJobReference[], maxJobs: number, maxSteps: number): { readonly jobs: readonly GitHubActionsFailedJobReference[]; readonly redactions: number } {
  let redactions = 0;
  const result = jobs.slice(0, maxJobs).map((job) => {
    const name = boundedSanitized(job.name, 160); redactions += name.redactions;
    const jobUrl = job.url === undefined ? undefined : boundedSanitized(job.url, 512); if (jobUrl !== undefined) redactions += jobUrl.redactions;
    const failedSteps = job.failedSteps.slice(0, maxSteps).map((step) => { const stepName = boundedSanitized(step.name, 160); redactions += stepName.redactions; return { name: stepName.value, ...(step.number === undefined ? {} : { number: step.number }) }; });
    return { id: job.id, name: name.value, ...(jobUrl === undefined ? {} : { url: jobUrl.value }), failedSteps };
  });
  return { jobs: result, redactions };
}

function validRequest(request: GitHubFailureHandoffPocRequest): string | undefined {
  if (!/^pirx\/poc-failure-[A-Za-z0-9._/-]{1,120}$/u.test(request.headBranch)) return "Only a dedicated pirx/poc-failure-* branch is allowed.";
  if (!sha(request.expectedHeadSha)) return "expectedHeadSha is invalid.";
  if (!text(request.eventId, 256)) return "eventId is invalid.";
  if (request.requiredWorkflowName !== undefined && request.requiredWorkflowName !== FAILURE_HANDOFF_POC_WORKFLOW) return "The required workflow is fixed to the inspected Develop — Fast Gate.";
  const bounded = (value: number | undefined, fallback: number, max: number): boolean => Number.isSafeInteger(value ?? fallback) && (value ?? fallback) > 0 && (value ?? fallback) <= max;
  if (!bounded(request.timeoutMs, 60_000, 300_000) || !bounded(request.pollIntervalMs, 2_000, 60_000) || !bounded(request.claudeTimeoutMs, 30_000, 120_000)) return "Timeout settings exceed the bounded limits.";
  if (request.maxFailedJobs !== undefined && (!Number.isSafeInteger(request.maxFailedJobs) || request.maxFailedJobs <= 0 || request.maxFailedJobs > 10)) return "maxFailedJobs is outside the bounded limit.";
  if (request.maxFailedSteps !== undefined && (!Number.isSafeInteger(request.maxFailedSteps) || request.maxFailedSteps <= 0 || request.maxFailedSteps > 20)) return "maxFailedSteps is outside the bounded limit.";
  if (request.maxLogBytes !== undefined && (!Number.isSafeInteger(request.maxLogBytes) || request.maxLogBytes <= 0 || request.maxLogBytes > FAILURE_HANDOFF_POC_MAX_LOG_BYTES)) return "maxLogBytes is outside the bounded limit.";
  return undefined;
}

function outcomeFromFailure(result: Exclude<GitHubOperationResult<unknown>, { outcome: "success" }>): GitHubFailureHandoffPocOutcome {
  if (result.outcome === "rate_limited" || result.error.code === "rate_limited") return "rate_limited";
  if (result.outcome === "unknown") return "unknown";
  if (result.error.code === "not_found") return "not_found";
  if (result.error.code === "conflict") return "ambiguous";
  if (result.error.code === "timeout" || result.error.code === "cancelled") return "pending_or_timeout";
  return "provider_error";
}

function watchOutcome(watch: GitHubActionsWatchResult): GitHubFailureHandoffPocOutcome {
  if (watch.outcome === "timeout" || watch.outcome === "cancelled") return "pending_or_timeout";
  if (watch.outcome === "not_found") return "not_found";
  if (watch.outcome === "ambiguous") return "ambiguous";
  if (watch.outcome === "rate_limited") return "rate_limited";
  if (watch.outcome === "unknown") return "unknown";
  return "provider_error";
}

function requestContext(request: GitHubFailureHandoffPocRequest, correlationId: string): GitHubRequestContext {
  return { correlationId, ...(request.signal === undefined ? {} : { signal: request.signal }) };
}

const REPLAYABLE_OUTCOMES: ReadonlySet<GitHubFailureHandoffPocOutcome> = new Set([
  "failure_handoff_completed", "unexpected_ci_success", "failure_evidence_unavailable", "worker_handoff_failed", "worker_authentication_required", "worker_quota_exhausted",
]);

export class GitHubFailureHandoffPoc {
  readonly #gateway: GitHubFailureHandoffPocGateway;
  readonly #watcher: { watch(request: GitHubActionsWatchRequest): Promise<GitHubActionsWatchResult> };
  readonly #store: GitHubFailureHandoffPocStore;
  readonly #claude: GitHubFailureHandoffClaudeRunner;
  readonly #config: GitHubConfig;

  constructor(gateway: GitHubFailureHandoffPocGateway, watcher: { watch(request: GitHubActionsWatchRequest): Promise<GitHubActionsWatchResult> }, claude: GitHubFailureHandoffClaudeRunner, store: GitHubFailureHandoffPocStore = new InMemoryGitHubFailureHandoffPocStore(), config: GitHubConfig = { token: "", owner: "PiotrGry", repository: "zdrovena-reconciliation", apiUrl: "https://api.github.com", timeoutMs: 10_000 }) {
    this.#gateway = gateway; this.#watcher = watcher; this.#claude = claude; this.#store = store; this.#config = config;
  }

  async execute(request: GitHubFailureHandoffPocRequest): Promise<GitHubFailureHandoffPocResult> {
    const correlationId = request.correlationId?.trim() || randomUUID();
    const invalid = validRequest(request);
    const handoffId = randomUUID();
    if (invalid !== undefined) return this.#result(request, correlationId, handoffId, "policy_blocked", invalid, "invalid_request", false);
    if (this.#config.owner !== "PiotrGry" || this.#config.repository !== "zdrovena-reconciliation") return this.#result(request, correlationId, handoffId, "policy_blocked", "Failure handoff target is fixed to PiotrGry/zdrovena-reconciliation.", "target_not_allowed", false);
    const existing = await this.#store.get(request.eventId);
    const replayed = existing !== undefined;
    if (existing !== undefined && (existing.headBranch !== request.headBranch || existing.expectedHeadSha !== request.expectedHeadSha)) return this.#result(request, correlationId, existing.handoffId, "policy_blocked", "eventId is already bound to a different branch or revision.", "event_conflict", true);
    if (existing !== undefined && REPLAYABLE_OUTCOMES.has(existing.outcome as GitHubFailureHandoffPocOutcome) && existing.evidence !== undefined) return this.#fromRecord(existing, true);
    let persisted = existing;
    const currentHandoffId = existing?.handoffId ?? handoffId;
    const save = async (patch: Partial<GitHubFailureHandoffPocRecord>): Promise<void> => {
      const now = new Date().toISOString();
      persisted = { schemaVersion: 1, eventId: request.eventId, owner: this.#config.owner, repository: this.#config.repository, featureBase: FAILURE_HANDOFF_POC_FEATURE_BASE, requiredWorkflowName: FAILURE_HANDOFF_POC_WORKFLOW, headBranch: request.headBranch, expectedHeadSha: request.expectedHeadSha, correlationId, handoffId: currentHandoffId, createdAt: persisted?.createdAt ?? now, ...persisted, ...patch, ...(patch.outcome === undefined ? {} : { terminalAt: now }), updatedAt: now };
      await this.#store.save(persisted);
    };
    await save({});
    const context = requestContext(request, correlationId);
    const branch = await this.#gateway.getBranchHead(request.headBranch, context);
    if (branch.outcome !== "success") return this.#finish(request, correlationId, currentHandoffId, this.#failureResult(request, correlationId, currentHandoffId, outcomeFromFailure(branch), branch.error.message, branch.error.code, replayed), save);
    if (branch.value.sha !== request.expectedHeadSha) return this.#finish(request, correlationId, currentHandoffId, this.#failureResult(request, correlationId, currentHandoffId, "stale_head", "Dedicated branch head does not match the recorded revision.", "stale_head", replayed), save);
    const pull = await this.#findOrCreatePull(request, currentHandoffId, correlationId, persisted?.featurePullRequestNumber);
    if (pull.outcome !== "success") return this.#finish(request, correlationId, currentHandoffId, this.#failureResult(request, correlationId, currentHandoffId, outcomeFromFailure(pull), pull.error.message, pull.error.code, replayed), save);
    const pullEvidence = { number: pull.value.number, url: pull.value.url, headSha: pull.value.headSha, state: pull.value.state, merged: pull.value.merged };
    await save({ featurePullRequestNumber: pull.value.number, featurePullRequestUrl: pull.value.url });
    if (pull.value.state !== "open" || pull.value.merged || pull.value.headBranch !== request.headBranch || pull.value.baseBranch !== FAILURE_HANDOFF_POC_FEATURE_BASE || pull.value.headSha !== request.expectedHeadSha) return this.#finish(request, correlationId, currentHandoffId, this.#failureResult(request, correlationId, currentHandoffId, "stale_head", "The controlled feature PR does not match the exact branch, base, or revision.", "stale_head", replayed, pullEvidence), save);
    const watch = await this.#watcher.watch({ pullRequestNumber: pull.value.number, expectedHeadSha: request.expectedHeadSha, requiredWorkflowName: FAILURE_HANDOFF_POC_WORKFLOW, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.pollIntervalMs === undefined ? {} : { pollIntervalMs: request.pollIntervalMs }), ...(request.maxFailedJobs === undefined ? {} : { maxFailedJobs: request.maxFailedJobs }), ...(request.maxFailedSteps === undefined ? {} : { maxFailedSteps: request.maxFailedSteps }), correlationId, ...(request.signal === undefined ? {} : { signal: request.signal }) });
    const run = "workflowRunId" in watch && watch.workflowRunId !== undefined && "runUrl" in watch && watch.runUrl !== undefined ? { id: watch.workflowRunId, name: watch.workflowName ?? FAILURE_HANDOFF_POC_WORKFLOW, url: watch.runUrl, headSha: watch.testedRevision, conclusion: watch.conclusion } : undefined;
    if (watch.outcome !== "failed") {
      const message = watch.outcome === "success" ? "The required workflow succeeded; failure handoff was not invoked." : ("message" in watch ? watch.message : "The required workflow did not complete successfully.");
      const outcome = watch.outcome === "success" ? "unexpected_ci_success" : watchOutcome(watch as GitHubActionsWatchResult);
      return this.#finish(request, correlationId, currentHandoffId, this.#failureResult(request, correlationId, currentHandoffId, outcome, message, "errorCode" in watch ? watch.errorCode : undefined, replayed, pullEvidence, run), save, { ...(run === undefined ? {} : { featureRunId: run.id, featureConclusion: run.conclusion }) });
    }
    const failedWatch = watch as GitHubActionsWatchTerminalResult;
    if (run === undefined || failedWatch.failedJobs === undefined || failedWatch.failedJobs.length === 0) return this.#finish(request, correlationId, currentHandoffId, this.#failureResult(request, correlationId, currentHandoffId, "failure_evidence_unavailable", "The failed run was found but failed job evidence was unavailable.", failedWatch.failedJobsErrorCode ?? "failed_jobs_unavailable", replayed, pullEvidence, run), save, { ...(run === undefined ? {} : { featureRunId: run.id, featureConclusion: run.conclusion }) });
    const evidence = await this.#buildEvidence(request, pull.value, failedWatch, run, context);
    if (evidence === undefined) return this.#finish(request, correlationId, currentHandoffId, this.#failureResult(request, correlationId, currentHandoffId, "failure_evidence_unavailable", "The failed run evidence exceeded the bounded evidence contract.", "evidence_bounds", replayed, pullEvidence, run), save, { ...(run === undefined ? {} : { featureRunId: run.id, featureConclusion: run.conclusion }) });
    const envelope = { schemaVersion: 1, eventId: request.eventId, correlationId, handoffId: currentHandoffId, evidence };
    const claude = await this.#claude.runHandoff({ handoffId: currentHandoffId, envelope, ...(request.claudeTimeoutMs === undefined ? {} : { timeoutMs: request.claudeTimeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
    const receipt: GitHubFailureHandoffReceipt = { handoffId: currentHandoffId, outcome: claude.outcome, ...(claude.outcome === "success" ? { acknowledgement: claude.acknowledgement } : {}) };
    const finalOutcome: GitHubFailureHandoffPocOutcome = claude.outcome === "success" ? "failure_handoff_completed" : claude.outcome === "authentication_required" ? "worker_authentication_required" : claude.outcome === "quota_exhausted" ? "worker_quota_exhausted" : "worker_handoff_failed";
    const result = this.#failureResult(request, correlationId, currentHandoffId, finalOutcome, claude.outcome === "success" ? "Bounded failure evidence was acknowledged by a fresh Claude Code session." : "Claude Code did not acknowledge the bounded failure handoff.", claude.outcome === "success" ? undefined : claude.outcome, replayed, pullEvidence, run, evidence, receipt);
    await save({ ...(run === undefined ? {} : { featureRunId: run.id, featureConclusion: run.conclusion }), evidence, claudeReceipt: receipt, outcome: finalOutcome });
    return result;
  }

  async #buildEvidence(request: GitHubFailureHandoffPocRequest, pull: GitHubShipmentPullRequest, watch: GitHubActionsWatchTerminalResult, run: { readonly id: number; readonly name: string; readonly url: string; readonly headSha: string; readonly conclusion: string }, context: GitHubRequestContext): Promise<GitHubFailureHandoffEvidence | undefined> {
    const boundedJobs = sanitizeJobs(watch.failedJobs ?? [], request.maxFailedJobs ?? 10, request.maxFailedSteps ?? 20);
    let redactionCount = boundedJobs.redactions;
    let logExcerpt: string | undefined;
    if (this.#gateway.getWorkflowRunLog !== undefined) {
      const log = await this.#gateway.getWorkflowRunLog(run.id, context);
      if (log.outcome === "success") { const bounded = boundedSanitized(log.value, request.maxLogBytes ?? FAILURE_HANDOFF_POC_MAX_LOG_BYTES); logExcerpt = bounded.value; redactionCount += bounded.redactions; }
    }
    const base = { schemaVersion: 1 as const, repository: FAILURE_HANDOFF_POC_REPOSITORY, pullRequest: { number: pull.number, url: pull.url, headBranch: pull.headBranch, headSha: pull.headSha }, workflow: { name: run.name, runId: run.id, url: run.url, headSha: run.headSha, conclusion: run.conclusion }, failedJobs: boundedJobs.jobs, ...(logExcerpt === undefined ? {} : { logExcerpt }), redactionCount };
    const evidenceBytes = Buffer.byteLength(JSON.stringify(base), "utf8");
    if (evidenceBytes > FAILURE_HANDOFF_POC_MAX_EVIDENCE_BYTES) return undefined;
    return { ...base, evidenceBytes, evidenceDigest: digest(base) };
  }

  async #findOrCreatePull(request: GitHubFailureHandoffPocRequest, handoffId: string, correlationId: string, knownNumber: number | undefined): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> {
    const context = requestContext(request, correlationId);
    if (knownNumber !== undefined) {
      const known = await this.#gateway.getPullRequest(knownNumber, context);
      if (known.outcome === "success") {
        if (known.value.headBranch !== request.headBranch || known.value.baseBranch !== FAILURE_HANDOFF_POC_FEATURE_BASE) return failure("permanent_error", "conflict", "Recorded failure PR has different branch or base.", correlationId, "not_accepted");
        return known;
      }
      if (known.error.code !== "not_found") return known;
    }
    const listed = await this.#gateway.listPullRequests(request.headBranch, FAILURE_HANDOFF_POC_FEATURE_BASE, context);
    if (listed.outcome !== "success") return listed;
    const expectedMarker = marker(request.eventId);
    const marked = listed.value.filter((pull) => pull.body?.includes(expectedMarker) === true);
    const candidates = marked.length > 0 ? marked : listed.value;
    if (candidates.length > 1) return failure("permanent_error", "conflict", "Multiple open failure POCs match the controlled branch.", correlationId, "not_accepted");
    if (candidates.length === 1) {
      if (marked.length === 0 && knownNumber === undefined) return failure("permanent_error", "conflict", "An unmarked PR already exists for the controlled failure branch.", correlationId, "not_accepted");
      return success(candidates[0]!, correlationId);
    }
    const createRequest: GitHubShipmentCreatePullRequestRequest = { headBranch: request.headBranch, baseBranch: FAILURE_HANDOFF_POC_FEATURE_BASE, title: "Pirx controlled failed-CI handoff POC", body: "Controlled test-only CI failure handoff.\n\n" + expectedMarker, idempotencyKey: `failure-handoff:${request.eventId}:feature-pr`, correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }) };
    const created = await this.#gateway.createPullRequest(createRequest);
    if (created.outcome !== "unknown") return created;
    const reconciled = await this.#gateway.listPullRequests(request.headBranch, FAILURE_HANDOFF_POC_FEATURE_BASE, context);
    if (reconciled.outcome === "success") {
      const exact = reconciled.value.filter((pull) => pull.body?.includes(expectedMarker) === true);
      if (exact.length === 1) return success(exact[0]!, correlationId);
      if (exact.length > 1) return failure("permanent_error", "conflict", "Unknown PR creation reconciled to multiple matching PRs.", correlationId, "not_accepted");
    }
    return created;
  }

  #fromRecord(record: GitHubFailureHandoffPocRecord, replayed: boolean): GitHubFailureHandoffPocResult {
    return { outcome: record.outcome!, repository: FAILURE_HANDOFF_POC_REPOSITORY, featureBase: FAILURE_HANDOFF_POC_FEATURE_BASE, requiredWorkflowName: FAILURE_HANDOFF_POC_WORKFLOW, eventId: record.eventId, headBranch: record.headBranch, expectedHeadSha: record.expectedHeadSha, correlationId: record.correlationId, handoffId: record.handoffId, message: "Replayed the stored bounded failure handoff without another PR or Claude invocation.", ...(record.featurePullRequestNumber === undefined || record.featurePullRequestUrl === undefined ? {} : { pullRequest: { number: record.featurePullRequestNumber, url: record.featurePullRequestUrl, headSha: record.evidence?.pullRequest.headSha ?? record.expectedHeadSha, state: "open", merged: false } }), ...(record.evidence?.workflow === undefined ? {} : { run: { id: record.evidence.workflow.runId, name: record.evidence.workflow.name, url: record.evidence.workflow.url, headSha: record.evidence.workflow.headSha, conclusion: record.evidence.workflow.conclusion } }), ...(record.evidence === undefined ? {} : { evidence: record.evidence }), ...(record.claudeReceipt === undefined ? {} : { claudeReceipt: record.claudeReceipt }), replayed, updatedAt: record.updatedAt };
  }

  #failureResult(request: GitHubFailureHandoffPocRequest, correlationId: string, handoffId: string, outcome: GitHubFailureHandoffPocOutcome, message: string, errorCode: string | undefined, replayed: boolean, pullRequest?: GitHubFailureHandoffPocResult["pullRequest"], run?: GitHubFailureHandoffPocResult["run"], evidence?: GitHubFailureHandoffEvidence, claudeReceipt?: GitHubFailureHandoffReceipt): GitHubFailureHandoffPocResult {
    return { outcome, repository: FAILURE_HANDOFF_POC_REPOSITORY, featureBase: FAILURE_HANDOFF_POC_FEATURE_BASE, requiredWorkflowName: FAILURE_HANDOFF_POC_WORKFLOW, eventId: request.eventId, headBranch: request.headBranch, expectedHeadSha: request.expectedHeadSha, correlationId, handoffId, message, ...(errorCode === undefined ? {} : { errorCode }), ...(pullRequest === undefined ? {} : { pullRequest }), ...(run === undefined ? {} : { run }), ...(evidence === undefined ? {} : { evidence }), ...(claudeReceipt === undefined ? {} : { claudeReceipt }), replayed, updatedAt: new Date().toISOString() };
  }

  #result(request: GitHubFailureHandoffPocRequest, correlationId: string, handoffId: string, outcome: GitHubFailureHandoffPocOutcome, message: string, errorCode: string, replayed: boolean): GitHubFailureHandoffPocResult { return this.#failureResult(request, correlationId, handoffId, outcome, message, errorCode, replayed); }
  async #finish(request: GitHubFailureHandoffPocRequest, correlationId: string, handoffId: string, result: GitHubFailureHandoffPocResult, save: (patch: Partial<GitHubFailureHandoffPocRecord>) => Promise<void>, patch: Partial<GitHubFailureHandoffPocRecord> = {}): Promise<GitHubFailureHandoffPocResult> { await save({ ...patch, outcome: result.outcome }); return result; }
}
