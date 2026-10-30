import { createHash } from "node:crypto";

import type { GitHubQueueIssue, GitHubQueueSnapshot, GitHubQueueSnapshotReader } from "../github/queue-snapshot.js";
import { createTask, type TaskId, type TaskRisk, type TaskSnapshot, type UtcTimestamp } from "./task-domain.js";
import type { RuntimeSqliteStore } from "./sqlite.js";

export const GITHUB_QUEUE_SYNC_SCHEMA_VERSION = 1 as const;
export const GITHUB_QUEUE_SYNC_LIMITS = Object.freeze({ maximumCriteria: 40, maximumCapabilities: 16 } as const);

export interface GitHubQueueSynchronizerOptions {
  readonly workerCapabilities: readonly string[];
  readonly repositories: readonly string[];
}

export type GitHubQueueSyncResult =
  | { readonly outcome: "synchronized"; readonly created: number; readonly updated: number; readonly queued: number; readonly unqueued: number }
  | { readonly outcome: "invalid_snapshot" | "conflict" | "storage_error"; readonly message: string };

export type GitHubQueueReconcileResult =
  | GitHubQueueSyncResult
  | { readonly outcome: "rate_limited" | "provider_error" | "schema_drift"; readonly message: string };

interface PlannedTask {
  readonly issue: GitHubQueueIssue;
  readonly goal: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly priority: number;
  readonly risk: TaskRisk;
}

const PRIORITY: Readonly<Record<string, number>> = Object.freeze({ P0: 100, P1: 75, P2: 50, P3: 25 });
const RISK: Readonly<Record<string, TaskRisk>> = Object.freeze({ Low: "low", Medium: "medium", High: "high", "Prod-sensitive": "critical" });
const EXECUTABLE_STATUS = new Set(["Todo", "Open", "In Progress"]);
const EXECUTABLE_TYPE = new Set(["Task", "Bug", "Experiment"]);

function failure(outcome: Exclude<GitHubQueueSyncResult["outcome"], "synchronized">, message: string): GitHubQueueSyncResult { return { outcome, message: message.slice(0, 256) }; }
function identity(issue: Pick<GitHubQueueIssue, "owner" | "repository" | "issueNumber">): string { return `${issue.owner}/${issue.repository}#${issue.issueNumber}`; }
function section(body: string, name: string): string | undefined {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return undefined;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/u.test(line.trim()));
  const value = lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset).join("\n").trim();
  return value === undefined || value.length === 0 || value.length > 2_000 ? undefined : value;
}
function planning(issue: GitHubQueueIssue): PlannedTask | undefined {
  const goal = section(issue.body, "Goal");
  const scope = section(issue.body, "Implementation scope");
  const acceptance = section(issue.body, "Acceptance criteria");
  if (goal === undefined || scope === undefined || acceptance === undefined || issue.priority === undefined || issue.risk === undefined) return undefined;
  const acceptanceCriteria = acceptance.split(/\r?\n/u).map((line) => /^\s*- \[[ xX]\]\s+(.+)\s*$/u.exec(line)?.[1]?.trim()).filter((value): value is string => value !== undefined && value.length > 0 && value.length <= 512);
  const priority = PRIORITY[issue.priority]; const risk = RISK[issue.risk];
  if (acceptanceCriteria.length === 0 || acceptanceCriteria.length > GITHUB_QUEUE_SYNC_LIMITS.maximumCriteria || priority === undefined || risk === undefined) return undefined;
  return { issue, goal, scope, acceptanceCriteria: Object.freeze([...new Set(acceptanceCriteria)]), priority, risk };
}
function taskId(issue: GitHubQueueIssue): TaskId { return `gh-${issue.issueNumber}-${createHash("sha256").update(issue.nodeId).digest("hex").slice(0, 16)}` as TaskId; }

export class GitHubQueueSynchronizer {
  readonly #store: RuntimeSqliteStore;
  readonly #capabilities: readonly string[];
  readonly #repositories: ReadonlySet<string>;

  public constructor(store: RuntimeSqliteStore, options: GitHubQueueSynchronizerOptions) {
    if (!Array.isArray(options.workerCapabilities) || options.workerCapabilities.length === 0 || options.workerCapabilities.length > GITHUB_QUEUE_SYNC_LIMITS.maximumCapabilities) throw new RangeError("Queue worker capabilities are invalid.");
    if (!Array.isArray(options.repositories) || options.repositories.length === 0) throw new RangeError("Queue repository allowlist is empty.");
    this.#store = store;
    this.#capabilities = Object.freeze([...new Set(options.workerCapabilities)].sort());
    this.#repositories = new Set(options.repositories);
  }

  public synchronize(snapshot: GitHubQueueSnapshot): GitHubQueueSyncResult {
    if (snapshot.schemaVersion !== GITHUB_QUEUE_SYNC_SCHEMA_VERSION || !Number.isFinite(Date.parse(snapshot.synchronizedAt)) || new Date(snapshot.synchronizedAt).toISOString() !== snapshot.synchronizedAt) return failure("invalid_snapshot", "Queue snapshot envelope is invalid.");
    const orders = new Map<number, string>();
    const planned: PlannedTask[] = [];
    for (const issue of snapshot.items) {
      if (issue.queueOrder === undefined) continue;
      if (!Number.isSafeInteger(issue.queueOrder) || issue.queueOrder <= 0 || orders.has(issue.queueOrder)) return failure("invalid_snapshot", "Queue Order must be positive and unique across the Project.");
      orders.set(issue.queueOrder, identity(issue));
      if (issue.worker === undefined || issue.status === undefined || issue.workType === undefined) return failure("invalid_snapshot", "A queued Project item is missing required planning metadata.");
      if (issue.worker !== "Pirx" || issue.state !== "OPEN" || !EXECUTABLE_STATUS.has(issue.status) || !EXECUTABLE_TYPE.has(issue.workType)) continue;
      if (!this.#repositories.has(`${issue.owner}/${issue.repository}`)) return failure("invalid_snapshot", "A Pirx Queue item targets a repository outside the configured allowlist.");
      const parsed = planning(issue);
      if (parsed === undefined) return failure("invalid_snapshot", `Queued Issue ${identity(issue)} has an invalid planning contract.`);
      planned.push(parsed);
    }
    const plannedIdentities = new Set(planned.map((value) => identity(value.issue)));
    const result = this.#store.transaction(({ tasks, attempts, selection }) => {
      let created = 0; let updated = 0; let unqueued = 0;
      const taskByIssue = new Map<string, TaskSnapshot>();
      for (const plan of planned) {
        const issueIdentity = { owner: plan.issue.owner, repository: plan.issue.repository, issueNumber: plan.issue.issueNumber };
        let current = tasks.getByIssue(issueIdentity);
        if (current.outcome === "not_found") {
          if (plan.issue.status === "In Progress") return { outcome: "conflict" as const, message: "GitHub marks an Issue In Progress but no durable runtime Task exists." };
          const built = createTask({
            id: taskId(plan.issue), githubReference: { ...issueIdentity, nodeId: plan.issue.nodeId, url: plan.issue.url },
            goal: plan.goal, scope: plan.scope, acceptanceCriteria: plan.acceptanceCriteria, priority: plan.priority, risk: plan.risk,
            requiredCapabilities: this.#capabilities, createdAt: plan.issue.createdAt as UtcTimestamp,
          });
          if (!built.ok) return { outcome: "invalid_record" as const, message: built.error.message };
          const inserted = tasks.create(built.value); if (inserted.outcome !== "success") return inserted;
          current = inserted; created += 1;
        }
        if (current.outcome !== "success") return current;
        if (current.value.githubReference?.nodeId !== plan.issue.nodeId) return { outcome: "conflict" as const, message: "GitHub Issue linkage conflicts with the durable runtime Task." };
        const history = attempts.listByTask(current.value.id); if (history.outcome !== "success") return history;
        if (current.value.state === "ready" && history.value.length === 0) {
          const rebuilt = createTask({ ...current.value, githubReference: { owner: plan.issue.owner, repository: plan.issue.repository, issueNumber: plan.issue.issueNumber, nodeId: plan.issue.nodeId, url: plan.issue.url }, goal: plan.goal, scope: plan.scope, acceptanceCriteria: plan.acceptanceCriteria, priority: plan.priority, risk: plan.risk, requiredCapabilities: this.#capabilities, updatedAt: snapshot.synchronizedAt as UtcTimestamp });
          if (!rebuilt.ok) return { outcome: "invalid_record" as const, message: rebuilt.error.message };
          if (JSON.stringify(rebuilt.value) !== JSON.stringify(current.value)) {
            const changed = tasks.update(rebuilt.value, { state: current.value.state, updatedAt: current.value.updatedAt }); if (changed.outcome !== "success") return changed;
            current = changed; updated += 1;
          }
        }
        taskByIssue.set(identity(plan.issue), current.value);
      }
      for (const plan of planned) {
        const current = taskByIssue.get(identity(plan.issue));
        if (current === undefined) return { outcome: "storage_error" as const, message: "Queue Task projection was not available." };
        const blockers: TaskId[] = []; const externalBlockers: string[] = [];
        for (const blocker of plan.issue.blockers.filter((value) => value.state === "OPEN")) {
          const blockerIdentity = identity(blocker);
          const projected = taskByIssue.get(blockerIdentity) ?? (() => { const value = tasks.getByIssue({ owner: blocker.owner, repository: blocker.repository, issueNumber: blocker.issueNumber }); return value.outcome === "success" && value.value.state !== "completed" ? value.value : undefined; })();
          if (projected === undefined) externalBlockers.push(blockerIdentity); else blockers.push(projected.id);
        }
        const old = selection.get(current.id);
        const synced = selection.synchronize({ taskId: current.id, queueOrder: plan.issue.queueOrder!, dependencyState: "known", synchronizedAt: snapshot.synchronizedAt as UtcTimestamp, blockers, externalBlockers, ...(old.outcome === "success" && old.value.cooldownUntil !== undefined ? { cooldownUntil: old.value.cooldownUntil } : {}) });
        if (synced.outcome !== "success") return synced;
      }
      const all = tasks.list(); if (all.outcome !== "success") return all;
      for (const task of all.value) {
        const reference = task.githubReference;
        if (reference === undefined || !this.#repositories.has(`${reference.owner}/${reference.repository}`) || plannedIdentities.has(`${reference.owner}/${reference.repository}#${reference.issueNumber}`) || task.state !== "ready") continue;
        const history = attempts.listByTask(task.id); if (history.outcome !== "success") return history;
        if (history.value.length > 0) continue;
        const old = selection.get(task.id); if (old.outcome !== "success" || old.value.queueOrder === undefined) continue;
        const cleared = selection.synchronize({ taskId: task.id, dependencyState: "known", synchronizedAt: snapshot.synchronizedAt as UtcTimestamp, blockers: [], externalBlockers: [], ...(old.value.cooldownUntil === undefined ? {} : { cooldownUntil: old.value.cooldownUntil }) });
        if (cleared.outcome !== "success") return cleared; unqueued += 1;
      }
      return { outcome: "success" as const, value: { created, updated, queued: planned.length, unqueued } };
    });
    if (result.outcome !== "success") return failure(result.outcome === "conflict" ? "conflict" : "storage_error", result.message);
    return { outcome: "synchronized", ...result.value };
  }
}

export class GitHubQueueReconciler {
  readonly #reader: GitHubQueueSnapshotReader;
  readonly #synchronizer: GitHubQueueSynchronizer;
  public constructor(reader: GitHubQueueSnapshotReader, synchronizer: GitHubQueueSynchronizer) { this.#reader = reader; this.#synchronizer = synchronizer; }
  public async reconcile(): Promise<GitHubQueueReconcileResult> {
    const read = await this.#reader.read();
    if (read.outcome !== "success") return { outcome: read.outcome === "invalid_request" ? "schema_drift" : read.outcome, message: read.message };
    return this.#synchronizer.synchronize(read.snapshot);
  }
}
