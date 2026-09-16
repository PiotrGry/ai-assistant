import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  RuntimeSqliteStore,
  createTask,
  type AttemptId,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
  type WorkspaceOwnershipInput,
} from "../src/index.js";

const now = "2026-09-15T10:00:00.000Z" as UtcTimestamp;
const later = "2026-09-15T10:01:00.000Z" as UtcTimestamp;
const base = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const next = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function fixture(): Promise<{ directory: string; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-workspace-ownership-test-"));
  return { directory, filename: join(directory, "runtime.sqlite") };
}

function task(id: string): TaskSnapshot {
  const created = createTask({ id: id as TaskId, goal: "Own a workspace", scope: "Runtime worker", acceptanceCriteria: ["durable ownership"], priority: 1, risk: "low", requiredCapabilities: ["git"], createdAt: now });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function start(store: RuntimeSqliteStore, id: string, attemptId: string, branch = "pirx/workspace/one") {
  const created = store.tasks.create(task(id));
  assert.equal(created.outcome, "success");
  const result = store.startAttempt(id, { id: attemptId as AttemptId, worker: "pirx", provider: "test", branch }, now);
  assert.equal(result.outcome, "success");
  return result.outcome === "success" ? result.value.attempt : undefined;
}

function input(taskId: string, attemptId: string, overrides: Partial<WorkspaceOwnershipInput> = {}): WorkspaceOwnershipInput {
  return { taskId: taskId as TaskId, attemptId: attemptId as AttemptId, repository: "PiotrGry/ai-assistant", repositoryRoot: "/srv/ai-assistant", assignedBranch: "pirx/workspace/one", worktreePath: `/srv/pirx/workspaces/${attemptId}`, expectedBaseRevision: base, acquiredAt: now, ...overrides };
}

test("persists ownership, both lookup directions, revision CAS, release, and restart recovery", async () => {
  const value = await fixture();
  let store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    const schema = store.database.prepare("SELECT MAX(version) AS version FROM runtime_schema_migrations").get() as { version: number };
    assert.equal(schema.version, 20);
    start(store, "workspace-task", "workspace-attempt");
    const claimed = store.workspaces.claim(input("workspace-task", "workspace-attempt"));
    assert.equal(claimed.outcome, "success");
    if (claimed.outcome !== "success") return;
    assert.equal(claimed.value.currentRevision, base);
    assert.equal(store.workspaces.getByTask("workspace-task").outcome, "success");
    assert.equal(store.workspaces.getByAttempt("workspace-attempt").outcome, "success");
    assert.equal(store.workspaces.getByTaskAttempt("workspace-task", "workspace-attempt").outcome, "success");
    assert.equal(store.workspaces.getByRepository("PiotrGry/ai-assistant", "pirx/workspace/one", "/srv/pirx/workspaces/workspace-attempt").outcome, "success");
    const replay = store.workspaces.claim(input("workspace-task", "workspace-attempt"));
    assert.equal(replay.outcome, "success");
    if (replay.outcome === "success") assert.deepEqual(replay.value, claimed.value);
    store.close();
    store = RuntimeSqliteStore.open({ filename: value.filename });
    const afterRestart = store.workspaces.getByTaskAttempt("workspace-task", "workspace-attempt");
    assert.deepEqual(afterRestart, { outcome: "success", value: claimed.value });
    const moved = store.workspaces.updateCurrentRevision("workspace-attempt", claimed.value.ownershipToken, claimed.value.version, next, later);
    assert.equal(moved.outcome, "success");
    if (moved.outcome !== "success") return;
    assert.equal(moved.value.currentRevision, next);
    assert.equal(moved.value.version, 2);
    assert.equal(store.workspaces.updateCurrentRevision("workspace-attempt", claimed.value.ownershipToken, claimed.value.version, base, later).outcome, "conflict");
    const released = store.workspaces.release("workspace-attempt", moved.value.ownershipToken, moved.value.version, later);
    assert.equal(released.outcome, "success");
    if (released.outcome === "success") assert.equal(released.value.state, "released");
    assert.equal(store.workspaces.getByTask("workspace-task").outcome, "not_found");
    const recoverableAfterRelease = store.workspaces.listRecoverable();
    assert.equal(recoverableAfterRelease.outcome, "success");
    if (recoverableAfterRelease.outcome === "success") assert.equal(recoverableAfterRelease.value.length, 0);
    assert.equal(store.workspaces.claim(input("workspace-task", "workspace-attempt")).outcome, "conflict");
  } finally {
    try { store.close(); } catch { /* already closed */ }
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("enforces active branch, worktree, task, and Attempt exclusivity with explicit conflicts", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    start(store, "workspace-task-a", "workspace-attempt-a", "pirx/workspace/a");
    start(store, "workspace-task-b", "workspace-attempt-b", "pirx/workspace/b");
    const first = store.workspaces.claim(input("workspace-task-a", "workspace-attempt-a", { assignedBranch: "pirx/workspace/a", worktreePath: "/srv/pirx/workspaces/a" }));
    assert.equal(first.outcome, "success");
    assert.equal(store.workspaces.claim(input("workspace-task-b", "workspace-attempt-b", { assignedBranch: "pirx/workspace/a", worktreePath: "/srv/pirx/workspaces/b" })).outcome, "conflict");
    assert.equal(store.workspaces.claim(input("workspace-task-b", "workspace-attempt-b", { assignedBranch: "pirx/workspace/b", worktreePath: "/srv/pirx/workspaces/a" })).outcome, "conflict");
    assert.equal(store.workspaces.claim(input("workspace-task-b", "workspace-attempt-b", { repository: "another/provider-repository", assignedBranch: "pirx/workspace/other", worktreePath: "/srv/pirx/workspaces/a" })).outcome, "conflict");
    assert.equal(store.workspaces.claim(input("workspace-task-a", "workspace-attempt-a", { assignedBranch: "pirx/workspace/other" })).outcome, "conflict");
    assert.equal(store.workspaces.claim(input("other-task", "workspace-attempt-a")).outcome, "conflict");
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("rolls back claims, survives competing stores, and maps foreign keys and malformed rows safely", async () => {
  const value = await fixture();
  const first = RuntimeSqliteStore.open({ filename: value.filename });
  const second = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    start(first, "workspace-task", "workspace-attempt");
    const rolledBack = first.transaction(({ workspaces }) => {
      const claimed = workspaces.claim(input("workspace-task", "workspace-attempt"));
      assert.equal(claimed.outcome, "success");
      return { outcome: "storage_error" as const, message: "controlled rollback" };
    });
    assert.equal(rolledBack.outcome, "storage_error");
    assert.equal(first.workspaces.getByAttempt("workspace-attempt").outcome, "not_found");
    const [a, b] = [first.workspaces.claim(input("workspace-task", "workspace-attempt")), second.workspaces.claim(input("workspace-task", "workspace-attempt"))];
    assert.deepEqual([a.outcome, b.outcome], ["success", "success"]);
    if (a.outcome === "success" && b.outcome === "success") assert.equal(a.value.ownershipToken, b.value.ownershipToken);
    assert.equal(first.workspaces.claim(input("missing-task", "missing-attempt")).outcome, "not_found");
    const raw = new DatabaseSync(value.filename);
    raw.prepare("UPDATE runtime_workspace_ownership SET current_revision = ? WHERE attempt_id = ?").run("not-a-revision", "workspace-attempt");
    raw.close();
    assert.equal(first.workspaces.getByAttempt("workspace-attempt").outcome, "invalid_record");
  } finally {
    first.close();
    second.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});

test("rejects malformed inputs before storage and reports recoverable active ownership", async () => {
  const value = await fixture();
  const store = RuntimeSqliteStore.open({ filename: value.filename });
  try {
    start(store, "workspace-task", "workspace-attempt");
    assert.equal(store.workspaces.claim(input("workspace-task", "workspace-attempt", { repositoryRoot: "relative" })).outcome, "invalid_record");
    assert.equal(store.workspaces.claim(input("workspace-task", "workspace-attempt", { expectedBaseRevision: "not-hex" })).outcome, "invalid_record");
    assert.equal(store.workspaces.claim(input("workspace-task", "workspace-attempt", { worktreePath: "/srv/pirx/workspaces/../unsafe" })).outcome, "invalid_record");
    assert.equal(store.workspaces.claim(input("workspace-task", "workspace-attempt")).outcome, "success");
    const recoverable = store.workspaces.listRecoverable();
    assert.equal(recoverable.outcome, "success");
    if (recoverable.outcome === "success") assert.equal(recoverable.value.length, 1);
  } finally {
    store.close();
    await rm(value.directory, { recursive: true, force: true });
  }
});
