import { createHash } from "node:crypto";

import type { CiConclusion, CiFailureEvidence, CiJobEvidence, CiRun, CiRunQueryContext, ProviderIndependentCiGateway } from "./ci-contract.js";
import type { CiCorrelationRecord } from "./ci-correlation.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import type { AttemptId, TaskId, UtcTimestamp } from "./task-domain.js";

export const CI_FAILURE_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CI_FAILURE_EVIDENCE_LIMITS = {
  maxJobs: 10,
  maxStepsPerJob: 20,
  maxLogLines: 80,
  maxLogBytes: 8_192,
  maxEvidenceBytes: 24_000,
  maxTextBytes: 512,
} as const;

export type CiEvidenceCollectionOutcome = "collected" | "replayed" | "partial" | "unavailable" | "rate_limited" | "retryable" | "permanent" | "stale" | "conflict" | "redaction_failed" | "unknown";

export interface CiFailureEvidenceRecord {
  readonly schemaVersion: typeof CI_FAILURE_EVIDENCE_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repository: string;
  readonly issueNumber: number;
  readonly featurePullRequestNumber: number;
  readonly featurePullRequestUrl: string;
  readonly headBranch: string;
  readonly pushedCommit: string;
  readonly provider: string;
  readonly providerRunId: string;
  readonly providerRunUrl: string;
  readonly workflowName: string;
  readonly conclusion: CiConclusion;
  readonly testedRevision: string;
  readonly failedJobs: readonly CiJobEvidence[];
  readonly logExcerpt?: string;
  readonly redactionCount: number;
  readonly evidenceBytes: number;
  readonly evidenceDigest: string;
  readonly createdAt: UtcTimestamp;
  readonly updatedAt: UtcTimestamp;
  readonly version: number;
}

export interface CiFailureEvidenceRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly correlationId: string;
  readonly now: UtcTimestamp;
  readonly maxJobs?: number;
  readonly maxStepsPerJob?: number;
  readonly maxLogLines?: number;
  readonly maxLogBytes?: number;
  readonly maxEvidenceBytes?: number;
  readonly secretPatterns?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type CiFailureEvidenceResult =
  | { readonly outcome: "collected" | "partial" | "replayed"; readonly record: CiFailureEvidenceRecord; readonly message: string }
  | { readonly outcome: Exclude<CiEvidenceCollectionOutcome, "collected" | "partial" | "replayed">; readonly message: string };

interface Sanitized { readonly value: string; readonly redactions: number; }

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/giu,
  /\b(?:proxy-)?authorization\s*:\s*[^\r\n]+/giu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/giu,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|connection(?:string)?|client[_-]?secret)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/giu,
  /\b(?:ghp_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9_-])[A-Za-z0-9._-]+/gu,
];

function bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function validText(value: string): boolean { return value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }

export function sanitizeCiEvidenceText(input: string, maxBytes: number = CI_FAILURE_EVIDENCE_LIMITS.maxTextBytes, configuredPatterns: readonly string[] = []): Sanitized {
  let value = input;
  let redactions = 0;
  for (const pattern of [...SECRET_PATTERNS, ...configuredPatterns.flatMap((item) => {
    try { return [new RegExp(item, "giu")]; } catch { return []; }
  })]) value = value.replace(pattern, () => { redactions += 1; return "[REDACTED]"; });
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { value, redactions };
  const truncated = encoded.subarray(0, maxBytes).toString("utf8").replace(/[\uFFFD]$/u, "");
  return { value: `${truncated}\n[TRUNCATED]`, redactions };
}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, value ?? fallback));
}

function sanitizeJobs(evidence: CiFailureEvidence, request: CiFailureEvidenceRequest): { jobs: readonly CiJobEvidence[]; redactions: number } {
  const maxJobs = limit(request.maxJobs, CI_FAILURE_EVIDENCE_LIMITS.maxJobs, CI_FAILURE_EVIDENCE_LIMITS.maxJobs);
  const maxSteps = limit(request.maxStepsPerJob, CI_FAILURE_EVIDENCE_LIMITS.maxStepsPerJob, CI_FAILURE_EVIDENCE_LIMITS.maxStepsPerJob);
  let redactions = 0;
  const jobs = evidence.failedJobs.slice(0, maxJobs).map((job) => {
    const providerJobId = sanitizeCiEvidenceText(job.providerJobId, 128, request.secretPatterns); redactions += providerJobId.redactions;
    const name = sanitizeCiEvidenceText(job.name, 160, request.secretPatterns); redactions += name.redactions;
    const jobUrl = job.url === undefined ? undefined : sanitizeCiEvidenceText(job.url, 512, request.secretPatterns); if (jobUrl !== undefined) redactions += jobUrl.redactions;
    const failedSteps = job.failedSteps.slice(0, maxSteps).map((step) => { const stepName = sanitizeCiEvidenceText(step.name, 160, request.secretPatterns); redactions += stepName.redactions; return { name: stepName.value, ...(step.number === undefined ? {} : { number: step.number }) }; });
    return { providerJobId: providerJobId.value, name: name.value, ...(jobUrl === undefined ? {} : { url: jobUrl.value }), conclusion: job.conclusion, failedSteps };
  });
  return { jobs, redactions };
}

function safeRun(correlation: CiCorrelationRecord): CiRun | undefined {
  if (correlation.providerRunId === undefined || correlation.providerRunUrl === undefined || correlation.workflowName === undefined || correlation.testedRevision === undefined) return undefined;
  return { schemaVersion: 1, provider: correlation.provider, providerRunId: correlation.providerRunId, name: correlation.workflowName, status: "completed", conclusion: "failure", testedRevision: correlation.testedRevision, headBranch: correlation.headBranch, pullRequestNumbers: [correlation.featurePullRequest.number], url: correlation.providerRunUrl, ...(correlation.providerPipelineId === undefined ? {} : { pipeline: { provider: correlation.provider, providerPipelineId: correlation.providerPipelineId, name: correlation.workflowName, url: correlation.providerRunUrl } }) };
}

function mapProviderOutcome(outcome: string): Exclude<CiEvidenceCollectionOutcome, "collected" | "replayed" | "partial"> {
  if (outcome === "rate_limited") return "rate_limited";
  if (outcome === "retryable") return "retryable";
  if (outcome === "unknown") return "unknown";
  if (outcome === "unavailable") return "unavailable";
  return "permanent";
}

export class CiFailureEvidenceService {
  readonly #store: RuntimeSqliteStore;
  readonly #gateway: ProviderIndependentCiGateway;
  public constructor(store: RuntimeSqliteStore, gateway: ProviderIndependentCiGateway) { this.#store = store; this.#gateway = gateway; }

  public async collect(request: CiFailureEvidenceRequest): Promise<CiFailureEvidenceResult> {
    if (request.secretPatterns?.some((pattern) => { try { new RegExp(pattern, "giu"); return false; } catch { return true; } }) === true) return { outcome: "redaction_failed", message: "Configured secret patterns are invalid." };
    const correlation = this.#store.ciCorrelations.getByTaskAttempt(request.taskId, request.attemptId);
    if (correlation.outcome !== "success") return { outcome: "conflict", message: "Durable CI correlation was not found." };
    const current = correlation.value;
    const existing = this.#store.ciEvidence.getByTaskAttempt(request.taskId, request.attemptId);
    if (existing.outcome === "success") return { outcome: "replayed", record: existing.value, message: "Replayed the durable CI failure evidence." };
    if (existing.outcome !== "not_found") return { outcome: "conflict", message: "Stored CI failure evidence could not be read." };
    if (current.state !== "failed") return { outcome: current.state === "stale" ? "stale" : "conflict", message: "Only an exact terminal failed CI correlation can produce failure evidence." };
    const run = safeRun(current);
    if (run === undefined) return { outcome: "stale", message: "The correlated failed run is missing a complete provider identity." };
    let providerResult;
    try { providerResult = await this.#gateway.getFailureEvidence(run, { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) }); } catch { return { outcome: "unavailable", message: "The CI provider did not return normalized failure evidence." }; }
    if (providerResult.outcome !== "success" || providerResult.evidence === undefined) return { outcome: mapProviderOutcome(providerResult.outcome), message: "CI failure evidence was unavailable." };
    if (providerResult.evidence.providerRunId !== current.providerRunId || providerResult.evidence.run.testedRevision !== current.pushedCommit || providerResult.evidence.run.headBranch !== current.headBranch || providerResult.evidence.run.name !== current.requiredWorkflowName || !providerResult.evidence.run.pullRequestNumbers.includes(current.featurePullRequest.number)) return { outcome: "stale", message: "CI evidence does not match the durable correlation." };
    const boundedJobs = sanitizeJobs(providerResult.evidence, request);
    let redactionCount = boundedJobs.redactions;
    let logExcerpt: string | undefined;
    let partial = false;
    if (this.#gateway.getFailureLogExcerpt !== undefined) {
      try {
        const log = await this.#gateway.getFailureLogExcerpt(run, { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
        if (log.outcome === "success" && log.excerpt !== undefined) {
          const sanitized = sanitizeCiEvidenceText(log.excerpt.split("\n").slice(0, limit(request.maxLogLines, CI_FAILURE_EVIDENCE_LIMITS.maxLogLines, CI_FAILURE_EVIDENCE_LIMITS.maxLogLines)).join("\n"), limit(request.maxLogBytes, CI_FAILURE_EVIDENCE_LIMITS.maxLogBytes, CI_FAILURE_EVIDENCE_LIMITS.maxLogBytes), request.secretPatterns);
          logExcerpt = sanitized.value; redactionCount += sanitized.redactions;
        } else partial = true;
      } catch { partial = true; }
    }
    const identityFields = [
      ["featurePullRequestUrl", current.featurePullRequest.url], ["headBranch", current.headBranch], ["pushedCommit", current.pushedCommit],
      ["providerRunId", current.providerRunId!], ["providerRunUrl", current.providerRunUrl!], ["workflowName", current.requiredWorkflowName], ["testedRevision", current.testedRevision!],
    ] as const;
    const sanitizedIdentity = new Map(identityFields.map(([key, value]) => [key, sanitizeCiEvidenceText(value, key.includes("Url") ? 512 : 256, request.secretPatterns)] as const));
    for (const value of sanitizedIdentity.values()) redactionCount += value.redactions;
    const base = { schemaVersion: 1 as const, taskId: current.taskId, attemptId: current.attemptId, repository: current.repository, issueNumber: current.issueNumber, featurePullRequestNumber: current.featurePullRequest.number, featurePullRequestUrl: sanitizedIdentity.get("featurePullRequestUrl")!.value, headBranch: sanitizedIdentity.get("headBranch")!.value, pushedCommit: sanitizedIdentity.get("pushedCommit")!.value, provider: current.provider, providerRunId: sanitizedIdentity.get("providerRunId")!.value, providerRunUrl: sanitizedIdentity.get("providerRunUrl")!.value, workflowName: sanitizedIdentity.get("workflowName")!.value, conclusion: "failure" as const, testedRevision: sanitizedIdentity.get("testedRevision")!.value, failedJobs: boundedJobs.jobs, ...(logExcerpt === undefined ? {} : { logExcerpt }), redactionCount, createdAt: current.createdAt, updatedAt: request.now, version: 1 };
    let record = { ...base, evidenceBytes: bytes(JSON.stringify(base)), evidenceDigest: "" } as CiFailureEvidenceRecord;
    if (record.evidenceBytes > limit(request.maxEvidenceBytes, CI_FAILURE_EVIDENCE_LIMITS.maxEvidenceBytes, CI_FAILURE_EVIDENCE_LIMITS.maxEvidenceBytes) && logExcerpt !== undefined) {
      const withoutLog = { ...base, logExcerpt: undefined, redactionCount, evidenceBytes: 0, evidenceDigest: "", version: 1 };
      const noLog = Object.fromEntries(Object.entries(withoutLog).filter(([key, value]) => key !== "logExcerpt" || value !== undefined));
      record = { ...noLog, evidenceBytes: bytes(JSON.stringify(noLog)), evidenceDigest: "" } as CiFailureEvidenceRecord;
      partial = true;
    }
    if (record.evidenceBytes > limit(request.maxEvidenceBytes, CI_FAILURE_EVIDENCE_LIMITS.maxEvidenceBytes, CI_FAILURE_EVIDENCE_LIMITS.maxEvidenceBytes)) return { outcome: "redaction_failed", message: "Sanitized CI evidence exceeded its bounded envelope." };
    record = { ...record, evidenceDigest: digest(record) };
    const saved = this.#store.ciEvidence.save(record);
    if (saved.outcome !== "success") return { outcome: saved.outcome === "storage_error" ? "unavailable" : "conflict", message: saved.message };
    return { outcome: partial ? "partial" : "collected", record: saved.value, message: partial ? "CI failure evidence was durably collected without an optional log excerpt." : "CI failure evidence was durably collected." };
  }
}
