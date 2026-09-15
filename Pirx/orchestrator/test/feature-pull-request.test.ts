import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  GitHubFeaturePullRequestService,
  RuntimeSqliteStore,
  createTask,
  failure,
  startInitialAttempt,
  success,
  transitionAttempt,
  type GitHubPullRequest,
  type GitHubPullRequestCreateInput,
  type GitHubPullRequestGatewayPort,
  type GitHubRequestContext,
  type GitHubOperationResult,
  type AttemptId,
  type TaskId,
  type TaskSnapshot,
  type UtcTimestamp,
} from "../src/index.js";

const t0 = "2026-09-15T17:00:00.000Z" as UtcTimestamp;
const t1 = "2026-09-15T17:01:00.000Z" as UtcTimestamp;
const repository = { owner: "PiotrGry", repository: "ai-assistant" } as const;
const issue = { owner: "PiotrGry", repository: "ai-assistant", issueNumber: 190, nodeId: "issue-190", url: "https://github.com/PiotrGry/ai-assistant/issues/190" } as const;
const taskId = "pr-provenance-task" as TaskId;
const attemptId = "pr-provenance-attempt" as AttemptId;
const branch = "pirx/feature-provenance";
const base = "develop";
const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

class FakePullGateway implements GitHubPullRequestGatewayPort {
  branchSha = sha;
  pulls: GitHubPullRequest[] = [];
  createMode: "success" | "unknown" | "rate" | "auth" = "success";
  calls = { branch: 0, list: 0, get: 0, create: 0 };
  async getBranchHead(requested: string, context: GitHubRequestContext): Promise<GitHubOperationResult<{ branch: string; sha: string }>> { this.calls.branch += 1; return success({ branch: requested, sha: this.branchSha }, context.correlationId); }
  async listPullRequests(head: string, requestedBase: string, context: GitHubRequestContext): Promise<GitHubOperationResult<readonly GitHubPullRequest[]>> { this.calls.list += 1; return success(this.pulls.filter((pull) => pull.headBranch === head && pull.baseBranch === requestedBase && pull.state === "open"), context.correlationId); }
  async getPullRequest(number: number, context: GitHubRequestContext): Promise<GitHubOperationResult<GitHubPullRequest>> { this.calls.get += 1; const pull = this.pulls.find((item) => item.number === number); return pull === undefined ? failure("permanent_error", "not_found", "missing", context.correlationId, "not_accepted") : success(pull, context.correlationId); }
  async createPullRequest(input: GitHubPullRequestCreateInput): Promise<GitHubOperationResult<GitHubPullRequest>> {
    this.calls.create += 1;
    if (this.createMode === "rate") return failure("rate_limited", "rate_limited", "rate", input.correlationId, "not_accepted");
    if (this.createMode === "auth") return failure("permanent_error", "authentication", "auth", input.correlationId, "not_accepted");
    const pull = { number: 42, url: "https://github.com/PiotrGry/ai-assistant/pull/42", state: "open" as const, body: input.body, headBranch: input.headBranch, headSha: this.branchSha, baseBranch: input.baseBranch, merged: false };
    if (this.createMode === "unknown") { this.pulls = [pull]; return failure("unknown", "unknown", "uncertain", input.correlationId, "unknown"); }
    this.pulls = [pull];
    return success(pull, input.correlationId);
  }
}

async function fixture(): Promise<{ readonly directory: string; readonly store: RuntimeSqliteStore; readonly task: TaskSnapshot }> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-feature-pr-test-"));
  const store = RuntimeSqliteStore.open({ filename: join(directory, "runtime.sqlite") });
  const created = createTask({ id: taskId, githubReference: issue, goal: "Create a feature PR", scope: "PR provenance", acceptanceCriteria: ["durable correlation"], priority: 1, risk: "low", requiredCapabilities: ["repository.write"], createdAt: t0 });
  if (!created.ok) throw new Error(created.error.message);
  if (store.tasks.create(created.value).outcome !== "success") throw new Error("task fixture failed");
  const started = store.startAttempt(taskId, { id: attemptId, worker: "pirx-worker", provider: "test", branch }, t0);
  if (started.outcome !== "success") throw new Error(started.message);
  const running = store.attempts.get(attemptId);
  if (running.outcome !== "success") throw new Error("attempt fixture failed");
  const terminal = transitionAttempt(running.value, "running", { type: "finish", result: "CODE_PUSHED", branch, finalCommit: sha }, t1);
  if (!terminal.ok || store.attempts.update(terminal.value, "running").outcome !== "success") throw new Error("terminal fixture failed");
  return { directory, store, task: created.value };
}
function request(overrides: Partial<{ baseBranch: string; expectedHeadSha: string }> = {}) {
  return { taskId, attemptId, repository, baseBranch: overrides.baseBranch ?? base, expectedHeadSha: overrides.expectedHeadSha ?? sha, correlationId: "feature-pr-correlation" };
}

test("creates, correlates, replays, and recovers one feature PR using SQLite", async () => {
  const value = await fixture(); const gateway = new FakePullGateway();
  try {
    const service = new GitHubFeaturePullRequestService(value.store, gateway, { now: () => t1 });
    const created = await service.createOrReuse(request());
    assert.equal(created.outcome, "created");
    assert.equal(created.pullRequest?.headBranch, branch);
    assert.equal(created.pullRequest?.baseBranch, base);
    assert.equal(created.pullRequest?.headSha, sha);
    assert.equal(created.pullRequest?.body?.includes(issue.url), true);
    assert.equal(value.store.pullRequests.getByTaskAttempt(taskId, attemptId).outcome, "success");
    assert.equal(value.store.pullRequests.getByPullRequest("PiotrGry/ai-assistant", 42).outcome, "success");
    const replay = await service.createOrReuse(request());
    assert.equal(replay.outcome, "replayed");
    assert.equal(gateway.calls.create, 1);
    value.store.close();
    const reopened = RuntimeSqliteStore.open({ filename: join(value.directory, "runtime.sqlite") });
    try {
      const afterRestart = await new GitHubFeaturePullRequestService(reopened, gateway, { now: () => t1 }).createOrReuse(request());
      assert.equal(afterRestart.outcome, "replayed");
      assert.equal(afterRestart.pullRequest?.number, 42);
      assert.equal(gateway.calls.create, 1);
    } finally { reopened.close(); }
  } finally { try { value.store.close(); } catch { /* closed for restart branch */ } await rm(value.directory, { recursive: true, force: true }); }
});

test("reuses an exact existing PR and rejects incompatible or ambiguous candidates", async () => {
  const value = await fixture(); const gateway = new FakePullGateway();
  try {
    const service = new GitHubFeaturePullRequestService(value.store, gateway, { now: () => t1 });
    const first = await service.createOrReuse(request());
    assert.equal(first.outcome, "created");
    value.store.database.prepare("DELETE FROM runtime_pull_request_provenance").run();
    const reused = await service.createOrReuse(request());
    assert.equal(reused.outcome, "reused");
    value.store.database.prepare("DELETE FROM runtime_pull_request_provenance").run();
    gateway.pulls = [{ ...gateway.pulls[0]!, number: 43, body: "unrelated PR" }];
    assert.equal((await service.createOrReuse(request())).outcome, "conflict");
    const provenanceBody = first.pullRequest?.body;
    gateway.pulls = [{ ...gateway.pulls[0]!, number: 43, ...(provenanceBody === undefined ? {} : { body: provenanceBody }) }, { ...gateway.pulls[0]!, number: 44, ...(provenanceBody === undefined ? {} : { body: provenanceBody }) }];
    assert.equal((await service.createOrReuse(request())).outcome, "ambiguous");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("fails closed for stale SHA, wrong base, missing identity, authorization, and rate limits", async () => {
  const value = await fixture();
  try {
    const gateway = new FakePullGateway(); const service = new GitHubFeaturePullRequestService(value.store, gateway, { now: () => t1 });
    gateway.branchSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert.equal((await service.createOrReuse(request())).outcome, "stale_head");
    gateway.branchSha = sha;
    assert.equal((await service.createOrReuse(request({ baseBranch: "main" }))).outcome, "conflict");
    const rateGateway = new FakePullGateway(); rateGateway.createMode = "rate";
    assert.equal((await new GitHubFeaturePullRequestService(value.store, rateGateway, { now: () => t1 }).createOrReuse(request())).outcome, "rate_limited");
    const authGateway = new FakePullGateway(); authGateway.createMode = "auth";
    assert.equal((await new GitHubFeaturePullRequestService(value.store, authGateway, { now: () => t1 }).createOrReuse(request())).outcome, "authorization_required");
    assert.equal((await new GitHubFeaturePullRequestService(value.store, gateway, { now: () => t1 }).createOrReuse({ ...request(), expectedHeadSha: "bad" })).outcome, "invalid_request");
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});

test("reconciles uncertain PR creation without creating a duplicate", async () => {
  const value = await fixture(); const gateway = new FakePullGateway(); gateway.createMode = "unknown";
  try {
    const result = await new GitHubFeaturePullRequestService(value.store, gateway, { now: () => t1 }).createOrReuse(request());
    assert.equal(result.outcome, "reconciled");
    assert.equal(result.pullRequest?.number, 42);
    assert.equal(gateway.calls.create, 1);
    assert.equal(gateway.calls.list, 2);
  } finally { value.store.close(); await rm(value.directory, { recursive: true, force: true }); }
});
