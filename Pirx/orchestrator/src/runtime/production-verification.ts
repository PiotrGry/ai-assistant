import { createHash } from "node:crypto";

import { ReleaseCorrelationService } from "./release-correlation.js";
import { releaseId, releaseText, releaseTimestamp, type ReleaseId } from "./release.js";
import { SafetyEnforcementGate } from "./safety-policy.js";
import type { CapabilityApproval } from "./capabilities.js";
import type { RuntimeSqliteStore, StorageResult } from "./sqlite.js";
import { transitionTask, type TaskId, type UtcTimestamp } from "./task-domain.js";

export const PRODUCTION_VERIFICATION_SCHEMA_VERSION = 1 as const;
export const PRODUCTION_VERIFICATION_LIMITS = Object.freeze({
  signals: 4,
  summary: 512,
  timeoutMs: 300_000,
  observationWindowMs: 3_600_000,
} as const);

export const PRODUCTION_SIGNAL_KINDS = Object.freeze(["version", "health", "metrics", "application_logs"] as const);
export type ProductionSignalKind = (typeof PRODUCTION_SIGNAL_KINDS)[number];
export type ProductionSignalOutcome = "healthy" | "pending" | "failed" | "degraded" | "unavailable" | "ambiguous" | "superseded" | "unknown";
export type ProductionVerificationOutcome = "verified" | "pending" | "failed" | "degraded" | "unavailable" | "stale" | "ambiguous" | "policy_blocked" | "unknown";

export interface ProductionSignalEvidence {
  readonly schemaVersion: typeof PRODUCTION_VERIFICATION_SCHEMA_VERSION;
  readonly kind: ProductionSignalKind;
  readonly repository: string;
  readonly environment: string;
  readonly outcome: ProductionSignalOutcome;
  readonly observedRevision?: string;
  readonly observedVersion?: string;
  readonly evidenceDigest: string;
  readonly summary?: string;
  readonly observedAt: UtcTimestamp;
}

export interface ProductionSignalResult {
  readonly outcome: ProductionSignalOutcome;
  readonly evidence?: ProductionSignalEvidence;
  readonly message: string;
}

export interface ProductionSignalQuery {
  readonly repository: string;
  readonly environment: string;
  readonly deployedRevision: string;
  readonly signal: ProductionSignalKind;
}

export interface ProductionSignalContext {
  readonly correlationId: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ProductionSignalGateway {
  read(query: ProductionSignalQuery, context: ProductionSignalContext): Promise<ProductionSignalResult>;
}

export type ProductionVersionPolicy =
  | { readonly mode: "exact_revision" }
  | { readonly mode: "configured_version"; readonly expectedVersion: string };

export interface ProductionVerificationPolicy {
  readonly requiredSignals: readonly ProductionSignalKind[];
  readonly version: ProductionVersionPolicy;
  readonly maxEvidenceAgeMs: number;
}

export interface ProductionReadAuthorization {
  readonly taskId: TaskId;
  readonly workerId: string;
  readonly workerGrants: readonly unknown[];
  readonly approvals: readonly CapabilityApproval[];
  readonly assignedWorktree: string;
}

export interface VerifyProductionRequest {
  readonly releaseId: ReleaseId;
  readonly repository: string;
  readonly environment: string;
  readonly deployedRevision: string;
  readonly policy: ProductionVerificationPolicy;
  readonly authorization: ProductionReadAuthorization;
  readonly correlationId: string;
  readonly now: UtcTimestamp;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface PersistedProductionSignal {
  readonly signal: ProductionSignalKind;
  readonly outcome: ProductionSignalOutcome;
  readonly message: string;
  readonly evidence?: ProductionSignalEvidence;
}

export interface ProductionVerificationRecord {
  readonly schemaVersion: typeof PRODUCTION_VERIFICATION_SCHEMA_VERSION;
  readonly releaseId: ReleaseId;
  readonly observationKey: string;
  readonly repository: string;
  readonly environment: string;
  readonly deployedRevision: string;
  readonly productionVersion?: string;
  readonly policyDigest: string;
  readonly outcome: ProductionVerificationOutcome;
  readonly evidenceDigest: string;
  readonly signals: readonly PersistedProductionSignal[];
  readonly observedAt: UtcTimestamp;
  readonly createdAt: UtcTimestamp;
}

export type VerifyProductionResult =
  | { readonly outcome: ProductionVerificationOutcome | "replayed"; readonly releaseId: ReleaseId; readonly message: string; readonly record?: ProductionVerificationRecord }
  | { readonly outcome: "conflict" | "invalid_request" | "storage_error"; readonly releaseId: ReleaseId; readonly message: string };

function bounded(value: string, field: string, maximum: number = PRODUCTION_VERIFICATION_LIMITS.summary): string {
  const result = releaseText(value, field, maximum);
  if (/[\u0000-\u001f\u007f]/u.test(result)) throw new Error(`${field} is invalid.`);
  return result;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function providerMessage(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  return (sanitized.length === 0 ? "Production signal returned no details." : sanitized).slice(0, PRODUCTION_VERIFICATION_LIMITS.summary);
}

function validatePolicy(value: ProductionVerificationPolicy): ProductionVerificationPolicy {
  if (!Array.isArray(value.requiredSignals) || value.requiredSignals.length === 0 || value.requiredSignals.length > PRODUCTION_VERIFICATION_LIMITS.signals) throw new Error("Production verification signals are invalid.");
  if (value.requiredSignals.some((item) => !PRODUCTION_SIGNAL_KINDS.includes(item)) || new Set(value.requiredSignals).size !== value.requiredSignals.length || !value.requiredSignals.includes("version")) throw new Error("Production verification requires one unique version signal.");
  if (!Number.isSafeInteger(value.maxEvidenceAgeMs) || value.maxEvidenceAgeMs <= 0 || value.maxEvidenceAgeMs > PRODUCTION_VERIFICATION_LIMITS.observationWindowMs) throw new Error("Production verification window is invalid.");
  const requiredSignals = Object.freeze([...value.requiredSignals]);
  if (value.version.mode === "exact_revision") return Object.freeze({ requiredSignals, version: Object.freeze({ mode: "exact_revision" as const }), maxEvidenceAgeMs: value.maxEvidenceAgeMs });
  if (value.version.mode !== "configured_version") throw new Error("Production version policy is invalid.");
  return Object.freeze({ requiredSignals, version: Object.freeze({ mode: "configured_version" as const, expectedVersion: bounded(value.version.expectedVersion, "expected production version", 256) }), maxEvidenceAgeMs: value.maxEvidenceAgeMs });
}

export function validateProductionSignalEvidence(value: ProductionSignalEvidence): ProductionSignalEvidence {
  if (value.schemaVersion !== PRODUCTION_VERIFICATION_SCHEMA_VERSION || !PRODUCTION_SIGNAL_KINDS.includes(value.kind) || !["healthy", "pending", "failed", "degraded", "unavailable", "ambiguous", "superseded", "unknown"].includes(value.outcome)) throw new Error("Production signal evidence is invalid.");
  if (!/^[a-f0-9]{64}$/u.test(value.evidenceDigest)) throw new Error("Production signal digest is invalid.");
  const observedRevision = value.observedRevision === undefined ? undefined : bounded(value.observedRevision, "observed revision", 256);
  const observedVersion = value.observedVersion === undefined ? undefined : bounded(value.observedVersion, "observed version", 256);
  return Object.freeze({
    schemaVersion: PRODUCTION_VERIFICATION_SCHEMA_VERSION,
    kind: value.kind,
    repository: bounded(value.repository, "repository"),
    environment: bounded(value.environment, "environment"),
    outcome: value.outcome,
    ...(observedRevision === undefined ? {} : { observedRevision }),
    ...(observedVersion === undefined ? {} : { observedVersion }),
    evidenceDigest: value.evidenceDigest,
    ...(value.summary === undefined ? {} : { summary: bounded(value.summary, "signal summary") }),
    observedAt: releaseTimestamp(value.observedAt),
  });
}

function validatePersistedSignal(value: PersistedProductionSignal): PersistedProductionSignal {
  if (!PRODUCTION_SIGNAL_KINDS.includes(value.signal) || !["healthy", "pending", "failed", "degraded", "unavailable", "ambiguous", "superseded", "unknown"].includes(value.outcome)) throw new Error("Persisted production signal is invalid.");
  const evidence = value.evidence === undefined ? undefined : validateProductionSignalEvidence(value.evidence);
  if (evidence !== undefined && (evidence.kind !== value.signal || evidence.outcome !== value.outcome)) throw new Error("Production signal identity conflicts with its evidence.");
  return Object.freeze({ signal: value.signal, outcome: value.outcome, message: providerMessage(value.message), ...(evidence === undefined ? {} : { evidence }) });
}

function recordKey(release: ReleaseId, policyDigest: string, outcome: ProductionVerificationOutcome, evidenceDigest: string, observedAt: UtcTimestamp): string {
  return digest([release, policyDigest, outcome, evidenceDigest, observedAt]);
}

function parseRow(row: Record<string, unknown>): StorageResult<ProductionVerificationRecord> {
  try {
    if (row.schema_version !== PRODUCTION_VERIFICATION_SCHEMA_VERSION || typeof row.observation_key !== "string" || !/^[a-f0-9]{64}$/u.test(row.observation_key) || typeof row.policy_digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.policy_digest) || typeof row.evidence_digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.evidence_digest)) throw new Error("invalid identity");
    const parsed = JSON.parse(String(row.signals_json)) as unknown;
    if (!Array.isArray(parsed)) throw new Error("invalid signals");
    const signals = Object.freeze(parsed.map((item) => validatePersistedSignal(item as PersistedProductionSignal)));
    if (signals.length === 0 || signals.length > PRODUCTION_VERIFICATION_LIMITS.signals) throw new Error("invalid signal count");
    const outcome = String(row.outcome) as ProductionVerificationOutcome;
    if (!["verified", "pending", "failed", "degraded", "unavailable", "stale", "ambiguous", "policy_blocked", "unknown"].includes(outcome)) throw new Error("invalid outcome");
    return { outcome: "success", value: Object.freeze({
      schemaVersion: PRODUCTION_VERIFICATION_SCHEMA_VERSION,
      releaseId: releaseId(String(row.release_id)),
      observationKey: row.observation_key,
      repository: bounded(String(row.repository), "repository"),
      environment: bounded(String(row.environment), "environment"),
      deployedRevision: bounded(String(row.deployed_revision), "deployed revision", 256),
      ...(row.production_version === null ? {} : { productionVersion: bounded(String(row.production_version), "production version", 256) }),
      policyDigest: row.policy_digest,
      outcome,
      evidenceDigest: row.evidence_digest,
      signals,
      observedAt: releaseTimestamp(String(row.observed_at)),
      createdAt: releaseTimestamp(String(row.created_at)),
    }) };
  } catch {
    return { outcome: "invalid_record", message: "Stored production verification is invalid." };
  }
}

export class ProductionVerificationRepository {
  readonly #store: RuntimeSqliteStore;
  public constructor(store: RuntimeSqliteStore) { this.#store = store; }

  public save(input: Omit<ProductionVerificationRecord, "schemaVersion" | "observationKey" | "createdAt">): StorageResult<ProductionVerificationRecord> {
    return this.#store.execute(() => {
      try {
        const release = releaseId(input.releaseId);
        const signals = Object.freeze(input.signals.map(validatePersistedSignal));
        if (signals.length === 0 || signals.length > PRODUCTION_VERIFICATION_LIMITS.signals || !/^[a-f0-9]{64}$/u.test(input.policyDigest) || !/^[a-f0-9]{64}$/u.test(input.evidenceDigest)) return { outcome: "invalid_record", message: "Production verification record is invalid." };
        const observedAt = releaseTimestamp(input.observedAt);
        const key = recordKey(release, input.policyDigest, input.outcome, input.evidenceDigest, observedAt);
        this.#store.database.prepare("INSERT OR IGNORE INTO runtime_release_production_verifications (release_id, observation_key, schema_version, repository, environment, deployed_revision, production_version, policy_digest, outcome, evidence_digest, signals_json, observed_at, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(release, key, bounded(input.repository, "repository"), bounded(input.environment, "environment"), bounded(input.deployedRevision, "deployed revision", 256), input.productionVersion === undefined ? null : bounded(input.productionVersion, "production version", 256), input.policyDigest, input.outcome, input.evidenceDigest, JSON.stringify(signals), observedAt, observedAt);
        const row = this.#store.database.prepare("SELECT * FROM runtime_release_production_verifications WHERE observation_key = ?").get(key) as Record<string, unknown> | undefined;
        return row === undefined ? { outcome: "storage_error", message: "Production verification was not stored." } : parseRow(row);
      } catch {
        return { outcome: "storage_error", message: "Production verification could not be stored." };
      }
    });
  }

  public latest(release: ReleaseId): StorageResult<ProductionVerificationRecord> {
    return this.#store.execute(() => {
      try {
        const row = this.#store.database.prepare("SELECT * FROM runtime_release_production_verifications WHERE release_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1").get(release) as Record<string, unknown> | undefined;
        return row === undefined ? { outcome: "not_found", message: "Production verification was not found." } : parseRow(row);
      } catch {
        return { outcome: "storage_error", message: "Production verification could not be read." };
      }
    });
  }

  public list(release: ReleaseId): StorageResult<readonly ProductionVerificationRecord[]> {
    return this.#store.execute(() => {
      try {
        const rows = this.#store.database.prepare("SELECT * FROM runtime_release_production_verifications WHERE release_id = ? ORDER BY observed_at, id").all(release) as Record<string, unknown>[];
        const values: ProductionVerificationRecord[] = [];
        for (const row of rows) { const parsed = parseRow(row); if (parsed.outcome !== "success") return parsed; values.push(parsed.value); }
        return { outcome: "success", value: Object.freeze(values) };
      } catch {
        return { outcome: "storage_error", message: "Production verifications could not be read." };
      }
    });
  }
}

function outcomeFor(signals: readonly PersistedProductionSignal[]): ProductionVerificationOutcome {
  const outcomes = new Set(signals.map((item) => item.outcome));
  if (outcomes.has("superseded")) return "stale";
  if (outcomes.has("failed")) return "failed";
  if (outcomes.has("degraded")) return "degraded";
  if (outcomes.has("pending")) return "pending";
  if (outcomes.has("unavailable")) return "unavailable";
  if (outcomes.has("ambiguous")) return "ambiguous";
  if (outcomes.has("unknown")) return "unknown";
  return "verified";
}

function result(request: VerifyProductionRequest, outcome: VerifyProductionResult["outcome"], message: string, record?: ProductionVerificationRecord): VerifyProductionResult {
  return { outcome, releaseId: request.releaseId, message: providerMessage(message), ...(record === undefined ? {} : { record }) } as VerifyProductionResult;
}

export class ProductionVerificationCoordinator {
  readonly #store: RuntimeSqliteStore;
  readonly #gateway: ProductionSignalGateway;
  readonly #safety: SafetyEnforcementGate;
  readonly #records: ProductionVerificationRepository;
  readonly #correlations: ReleaseCorrelationService;

  public constructor(store: RuntimeSqliteStore, gateway: ProductionSignalGateway, safety: SafetyEnforcementGate) {
    this.#store = store;
    this.#gateway = gateway;
    this.#safety = safety;
    this.#records = new ProductionVerificationRepository(store);
    this.#correlations = new ReleaseCorrelationService(store);
  }

  public async verify(request: VerifyProductionRequest): Promise<VerifyProductionResult> {
    let policy: ProductionVerificationPolicy;
    try {
      releaseId(request.releaseId);
      bounded(request.repository, "repository");
      bounded(request.environment, "environment");
      bounded(request.deployedRevision, "deployed revision", 256);
      bounded(request.correlationId, "correlation ID", 256);
      bounded(request.authorization.workerId, "worker ID", 256);
      bounded(request.authorization.assignedWorktree, "assigned worktree", 2_048);
      releaseTimestamp(request.now);
      policy = validatePolicy(request.policy);
    } catch (error: unknown) {
      return result(request, "invalid_request", error instanceof Error ? error.message : "Production verification request is invalid.");
    }
    if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0 || request.timeoutMs > PRODUCTION_VERIFICATION_LIMITS.timeoutMs)) return result(request, "invalid_request", "Production verification timeout is invalid.");

    const release = this.#store.releases.get(request.releaseId);
    const correlation = this.#correlations.getByRelease(request.releaseId);
    if (release.outcome !== "success" || correlation.outcome !== "success") return result(request, "conflict", "Production verification requires a durable Release and delivery correlation.");
    if (release.value.repository !== request.repository || release.value.mergeRevision !== request.deployedRevision || correlation.value.mergeRevision !== request.deployedRevision || correlation.value.deployment?.deployedRevision !== request.deployedRevision || correlation.value.deployment.environment !== request.environment) return result(request, "stale", "Production verification does not match the exact deployed Release revision and environment.");
    if (release.value.state === "deployed" && correlation.value.productionVersion !== undefined) {
      const latest = this.#records.latest(request.releaseId);
      return result(request, "replayed", "Replayed the durable production verification.", latest.outcome === "success" ? latest.value : undefined);
    }
    if (release.value.state !== "production_verification") return result(request, "conflict", "Release is not awaiting production verification.");
    const members = this.#store.releases.listTasks(request.releaseId);
    if (members.outcome !== "success" || members.value.length === 0) return result(request, members.outcome === "storage_error" ? "storage_error" : "conflict", "Release membership is unavailable for production verification.");
    if (!members.value.some((member) => member.taskId === request.authorization.taskId)) return result(request, "policy_blocked", "Production read authorization must be bound to a Release member Task.");

    const policyDigest = digest(policy);
    const previous = this.#records.latest(request.releaseId);
    if (previous.outcome !== "success" && previous.outcome !== "not_found") return result(request, previous.outcome === "storage_error" ? "storage_error" : "conflict", previous.message);
    if (previous.outcome === "success" && previous.value.policyDigest !== policyDigest) return result(request, "policy_blocked", "Production verification policy conflicts with durable prior observations.");

    const authorized = await this.#safety.execute({
      taskId: request.authorization.taskId,
      grantTaskId: request.authorization.taskId,
      workerId: request.authorization.workerId,
      grantWorkerId: request.authorization.workerId,
      requestedAction: "production.read",
      workerGrants: request.authorization.workerGrants,
      repository: request.repository,
      assignedBranch: release.value.baseBranch,
      assignedWorktree: request.authorization.assignedWorktree,
      resourceScope: { repository: request.repository, branch: release.value.baseBranch, worktree: request.authorization.assignedWorktree, environment: request.environment },
      approvals: request.authorization.approvals,
      correlationId: request.correlationId,
      evaluatedAt: request.now,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }, async () => {
      const values: PersistedProductionSignal[] = [];
      for (const signal of policy.requiredSignals) {
        let remote: ProductionSignalResult;
        try {
          remote = await this.#gateway.read({ repository: request.repository, environment: request.environment, deployedRevision: request.deployedRevision, signal }, { correlationId: request.correlationId, ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }), ...(request.signal === undefined ? {} : { signal: request.signal }) });
        } catch {
          remote = { outcome: "unknown", message: "Production signal provider failed." };
        }
        let evidence: ProductionSignalEvidence | undefined;
        if (remote.evidence !== undefined) {
          try { evidence = validateProductionSignalEvidence(remote.evidence); }
          catch { remote = { outcome: "unknown", message: "Production signal provider returned invalid evidence." }; }
        }
        if (!["healthy", "pending", "failed", "degraded", "unavailable", "ambiguous", "superseded", "unknown"].includes(remote.outcome)) remote = { outcome: "unknown", message: "Production signal provider returned an unknown outcome." };
        if (evidence !== undefined && (evidence.kind !== signal || evidence.outcome !== remote.outcome)) remote = { outcome: "ambiguous", message: "Production signal result conflicts with its evidence." };
        if (remote.outcome === "healthy" && evidence === undefined) remote = { outcome: "unknown", message: "Healthy production status requires correlated evidence." };
        values.push(Object.freeze({ signal, outcome: remote.outcome, message: providerMessage(remote.message), ...(evidence === undefined || evidence.kind !== signal || evidence.outcome !== remote.outcome ? {} : { evidence }) }));
      }
      return Object.freeze(values);
    });
    if (authorized.outcome !== "allowed") return result(request, "policy_blocked", authorized.outcome === "human_action_required" || authorized.outcome === "denied" ? authorized.humanAction.nextInstruction : "Production read authorization did not complete.");

    const signals = authorized.value;
    let stale = false;
    for (const item of signals) {
      const evidence = item.evidence;
      if (evidence === undefined) continue;
      const observed = Date.parse(evidence.observedAt);
      const now = Date.parse(request.now);
      const exactRevision = evidence.observedRevision === request.deployedRevision;
      const configuredVersion = evidence.observedRevision === undefined && policy.version.mode === "configured_version" && evidence.observedVersion === policy.version.expectedVersion;
      if (evidence.repository !== request.repository || evidence.environment !== request.environment || observed > now || now - observed > policy.maxEvidenceAgeMs || (!exactRevision && !configuredVersion)) stale = true;
    }
    const terminalOutcome = stale ? "stale" : outcomeFor(signals);
    const versionEvidence = signals.find((item) => item.signal === "version")?.evidence;
    if (terminalOutcome === "verified" && versionEvidence === undefined) return result(request, "unknown", "Verified production requires version evidence.");
    const productionVersion = versionEvidence?.observedVersion ?? (policy.version.mode === "configured_version" ? policy.version.expectedVersion : request.deployedRevision);
    const evidenceDigest = digest(signals);
    const recordInput = { releaseId: request.releaseId, repository: request.repository, environment: request.environment, deployedRevision: request.deployedRevision, ...(productionVersion === undefined ? {} : { productionVersion }), policyDigest, outcome: terminalOutcome, evidenceDigest, signals, observedAt: request.now } as const;
    if (terminalOutcome !== "verified") {
      const saved = this.#records.save(recordInput);
      return saved.outcome === "success" ? result(request, terminalOutcome, `Production verification is ${terminalOutcome}.`, saved.value) : result(request, saved.outcome === "storage_error" ? "storage_error" : "conflict", saved.message);
    }

    const completed = this.#store.transaction(({ releases, tasks, attempts }) => {
      const currentRelease = releases.get(request.releaseId);
      if (currentRelease.outcome !== "success") return currentRelease;
      if (currentRelease.value.state !== "production_verification" || currentRelease.value.version !== release.value.version || currentRelease.value.mergeRevision !== request.deployedRevision) return { outcome: "conflict" as const, message: "Release changed during production verification." };
      const saved = this.#records.save(recordInput);
      if (saved.outcome !== "success") return saved;
      const correlated = this.#correlations.correlate({ ...correlation.value, productionVersion: productionVersion!, observedAt: request.now });
      if (correlated.outcome !== "correlated" && correlated.outcome !== "replayed") return { outcome: correlated.outcome === "storage_error" ? "storage_error" as const : "conflict" as const, message: correlated.message };
      for (const member of members.value) {
        const task = tasks.get(member.taskId);
        const history = attempts.listByTask(member.taskId);
        if (task.outcome !== "success") return task;
        if (history.outcome !== "success") return history;
        const selected = history.value.find((attempt) => attempt.id === member.attemptId);
        if (selected?.state !== "terminal" || selected.result !== "CODE_PUSHED" || selected.finalCommit !== member.selectedRevision) return { outcome: "conflict" as const, message: "Release member is not backed by its selected CODE_PUSHED Attempt." };
        if (task.value.state === "completed") {
          if (task.value.completionEvidence?.attemptId !== member.attemptId || task.value.completionEvidence.finalCommit !== member.selectedRevision) return { outcome: "conflict" as const, message: "Completed Release member has conflicting completion evidence." };
          continue;
        }
        if (task.value.state !== "in_progress") return { outcome: "conflict" as const, message: "Release member Task is not eligible for completion." };
        const transitioned = transitionTask(task.value, "in_progress", { type: "complete", evidence: { attemptId: member.attemptId, finalCommit: member.selectedRevision, evidenceReference: `production-verification:${evidenceDigest}` }, attempts: history.value }, request.now);
        if (!transitioned.ok) return { outcome: "conflict" as const, message: transitioned.error.message };
        const updated = tasks.update(transitioned.value, { state: task.value.state, updatedAt: task.value.updatedAt });
        if (updated.outcome !== "success") return updated;
      }
      const deployed = releases.transition(request.releaseId, { to: "deployed", expectedVersion: currentRelease.value.version, now: request.now, productionVersion: productionVersion! });
      if (deployed.outcome !== "success") return deployed;
      return { outcome: "success" as const, value: saved.value };
    });
    return completed.outcome === "success" ? result(request, "verified", "Production verification passed and the Release membership completed atomically.", completed.value) : result(request, completed.outcome === "storage_error" ? "storage_error" : "conflict", completed.message);
  }
}
