import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  GitHubQueueSnapshotReader,
  GitHubQueueSynchronizer,
  RuntimeSqliteStore,
  failure,
  success,
  type GitHubOperationResult,
  type GitHubProjectTransport,
  type GitHubQueueIssue,
  type GitHubQueueSnapshot,
  type GitHubRequestContext,
  type UtcTimestamp,
} from "../src/index.js";

const now = "2026-10-30T12:00:00.000Z";
const projectId = "PVT_queue";
const config = { projectOwner: "PiotrGry", projectNumber: 3, timeoutMs: 1_000 } as const;

function projectSchema() {
  const selects: Record<string, readonly string[]> = { Status: ["Todo", "Open", "In Progress", "Done"], Priority: ["P0", "P1", "P2", "P3"], Worker: ["Pirx", "Claude", "Codex", "Scout", "Human"], Area: ["Pirx Core", "GitHub", "Orchestrator", "Scheduler", "Checkpoint", "Agent Adapter", "Security", "Architecture Lab", "Research"], Risk: ["Low", "Medium", "High", "Prod-sensitive"], "Work Type": ["Epic", "Feature", "Task", "Bug", "Experiment", "Research"] };
  return { id: projectId, fields: { nodes: [...Object.entries(selects).map(([name, values]) => ({ __typename: "ProjectV2SingleSelectField", id: `field-${name}`, name, options: values.map((value) => ({ id: `${name}-${value}`, name: value })) })), { __typename: "ProjectV2Field", id: "field-order", name: "Queue Order", dataType: "NUMBER" }], pageInfo: { hasNextPage: false } } };
}

function rawIssue(number: number, order: number, overrides: Record<string, unknown> = {}) {
  const fields: Record<string, string | number> = { Status: "Todo", Priority: "P0", Worker: "Pirx", Risk: "High", "Work Type": "Task", "Queue Order": order };
  const fieldValues = Object.entries({ ...fields, ...(overrides.fields as object | undefined) }).map(([name, value]) => typeof value === "number" ? { __typename: "ProjectV2ItemFieldNumberValue", number: value, field: { name } } : { __typename: "ProjectV2ItemFieldSingleSelectValue", name: value, field: { name } });
  return { id: `item-${number}`, content: { __typename: "Issue", id: `issue-${number}`, number, title: `Task ${number}`, body: body(number), state: "OPEN", url: `https://github.com/PiotrGry/ai-assistant/issues/${number}`, createdAt: now, updatedAt: now, repository: { name: "ai-assistant", owner: { login: "PiotrGry" } }, blockedBy: { nodes: [], pageInfo: { hasNextPage: false } }, ...(overrides.content as object | undefined) }, fieldValues: { nodes: fieldValues } };
}

function body(number: number): string { return `## Goal\n\nImplement Task ${number}.\n\n## Implementation scope\n\n- Make one deterministic change.\n\n## Acceptance criteria\n\n- [ ] Behavior is implemented.\n- [ ] Tests pass.\n\n## Out of scope\n\n- Unrelated work.`; }

class QueueTransport implements GitHubProjectTransport {
  pages: unknown[] = [{ node: { items: { nodes: [rawIssue(209, 10)], pageInfo: { hasNextPage: false } } } }];
  readonly queries: string[] = [];
  fail = false;
  async graphqlRead<T>(request: { readonly query: string; readonly variables?: Readonly<Record<string, unknown>> }, _context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    this.queries.push(request.query);
    if (request.query.includes("PirxProjectSchemaForUser")) return success({ user: { projectV2: projectSchema() } }, "queue") as GitHubOperationResult<T>;
    if (this.fail) return failure("rate_limited", "rate_limited", "bounded", "queue", "not_accepted") as GitHubOperationResult<T>;
    return success(this.pages.shift(), "queue") as GitHubOperationResult<T>;
  }
  async graphqlWrite<T>(): Promise<GitHubOperationResult<T>> { throw new Error("Queue reader must not write."); }
}

test("reads a bounded paginated Queue snapshot with exact Issue fields and native blockers", async () => {
  const transport = new QueueTransport();
  const blocker = { id: "issue-1", number: 1, state: "OPEN", repository: { name: "ai-assistant", owner: { login: "PiotrGry" } } };
  transport.pages = [
    { node: { items: { nodes: [rawIssue(209, 10, { content: { blockedBy: { nodes: [blocker], pageInfo: { hasNextPage: false } } } })], pageInfo: { hasNextPage: true, endCursor: "next" } } } },
    { node: { items: { nodes: [rawIssue(210, 20)], pageInfo: { hasNextPage: false } } } },
  ];
  const result = await new GitHubQueueSnapshotReader(transport, config, { retryPolicy: { maxAttempts: 1 }, clock: { now: () => now } }).read({ correlationId: "queue-read" });
  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") return;
  assert.deepEqual(result.snapshot.items.map((item) => item.issueNumber), [209, 210]);
  assert.equal(result.snapshot.items[0]?.blockers[0]?.issueNumber, 1);
  assert.equal(transport.queries.filter((query) => query.includes("PirxQueueSnapshot")).length, 2);
  assert.equal(transport.queries.some((query) => query.includes("comments")), false);
});

test("fails closed for truncated dependency data and rate limits", async () => {
  const truncated = new QueueTransport();
  truncated.pages = [{ node: { items: { nodes: [rawIssue(209, 10, { content: { blockedBy: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "more" } } } })], pageInfo: { hasNextPage: false } } } }];
  assert.equal((await new GitHubQueueSnapshotReader(truncated, config, { retryPolicy: { maxAttempts: 1 } }).read()).outcome, "schema_drift");
  const limited = new QueueTransport(); limited.fail = true;
  assert.equal((await new GitHubQueueSnapshotReader(limited, config, { retryPolicy: { maxAttempts: 1 } }).read()).outcome, "rate_limited");
});

function queueIssue(number: number, order: number, overrides: Partial<GitHubQueueIssue> = {}): GitHubQueueIssue {
  return { itemId: `item-${number}`, nodeId: `issue-${number}`, owner: "PiotrGry", repository: "ai-assistant", issueNumber: number, url: `https://github.com/PiotrGry/ai-assistant/issues/${number}`, title: `Task ${number}`, body: body(number), state: "OPEN", createdAt: now, updatedAt: now, status: "Todo", priority: "P0", worker: "Pirx", risk: "High", workType: "Task", queueOrder: order, blockers: [], ...overrides };
}
function snapshot(items: readonly GitHubQueueIssue[]): GitHubQueueSnapshot { return { schemaVersion: 1, projectId, synchronizedAt: now, items }; }

test("projects one runtime Task per Issue, skips an external blocker, replays, and unqueues stale work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-queue-sync-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    const sync = new GitHubQueueSynchronizer(store, { workerCapabilities: ["repository.read", "repository.write"], repositories: ["PiotrGry/ai-assistant"] });
    const blocker = { nodeId: "outside", owner: "PiotrGry", repository: "ai-assistant", issueNumber: 999, state: "OPEN" as const };
    const first = sync.synchronize(snapshot([queueIssue(1, 10, { blockers: [blocker] }), queueIssue(2, 20)]));
    assert.deepEqual(first, { outcome: "synchronized", created: 2, updated: 0, queued: 2, unqueued: 0 });
    const tasks = store.tasks.list(); assert.equal(tasks.outcome, "success"); if (tasks.outcome !== "success") return;
    assert.equal(tasks.value.length, 2);
    const selected = store.selection.select({ evaluatedAt: now as UtcTimestamp, worker: { workerId: "pirx", capabilities: ["repository.read", "repository.write"] } });
    assert.equal(selected.outcome, "selected"); if (selected.outcome === "selected") assert.equal(selected.candidate.task.githubReference?.issueNumber, 2);
    const blocked = selected.outcome === "selected" ? selected.explanations.find((value) => value.taskId !== selected.candidate.task.id) : undefined;
    assert.deepEqual(blocked?.externalBlockers, ["PiotrGry/ai-assistant#999"]);
    assert.deepEqual(sync.synchronize(snapshot([queueIssue(1, 10, { blockers: [blocker] }), queueIssue(2, 20)])), { outcome: "synchronized", created: 0, updated: 0, queued: 2, unqueued: 0 });
    const replayedTasks = store.tasks.list(); assert.equal(replayedTasks.outcome === "success" ? replayedTasks.value.length : 0, 2);
    assert.deepEqual(sync.synchronize(snapshot([])), { outcome: "synchronized", created: 0, updated: 0, queued: 0, unqueued: 2 });
    assert.equal(store.selection.select({ evaluatedAt: now as UtcTimestamp, worker: { workerId: "pirx", capabilities: ["repository.read", "repository.write"] } }).outcome, "no_runnable_task");
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("rejects duplicate order and malformed planning before any durable Task is created", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-queue-invalid-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  try {
    const sync = new GitHubQueueSynchronizer(store, { workerCapabilities: ["repository.read"], repositories: ["PiotrGry/ai-assistant"] });
    assert.equal(sync.synchronize(snapshot([queueIssue(1, 10), queueIssue(2, 10)])).outcome, "invalid_snapshot");
    assert.equal(sync.synchronize(snapshot([queueIssue(1, 10, { body: "missing contract" })])).outcome, "invalid_snapshot");
    const tasks = store.tasks.list(); assert.equal(tasks.outcome, "success"); if (tasks.outcome === "success") assert.equal(tasks.value.length, 0);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
