import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  GitHubShipmentPoc,
  FileGitHubShipmentPocStore,
  InMemoryGitHubShipmentPocStore,
  type GitHubShipmentPocGatewayPort,
  type GitHubShipmentPullRequest,
  type GitHubOperationResult,
  type GitHubRequestContext,
  success,
} from "../src/index.js";
import type { GitHubActionsWatchResult, GitHubShipmentPocWatcher } from "../src/index.js";

const config = { token: "test", owner: "PiotrGry", repository: "zdrovena-reconciliation", apiUrl: "https://api.github.com", timeoutMs: 100 } as const;
const request = { eventId: "code-pushed-1", headBranch: "pirx/poc-docs", expectedHeadSha: "feature-sha", timeoutMs: 10, pollIntervalMs: 1 } as const;

function pull(number: number, baseBranch: "develop" | "main", headSha: string, overrides: Partial<GitHubShipmentPullRequest> = {}): GitHubShipmentPullRequest {
  return { number, url: `https://github.com/PiotrGry/zdrovena-reconciliation/pull/${number}`, state: "open", headBranch: request.headBranch, headSha, baseBranch, merged: false, body: `<!-- pirx-shipment-poc:v1 event=${"a".repeat(64)} -->`, ...overrides };
}

class FakeGateway implements GitHubShipmentPocGatewayPort {
  readonly pulls = new Map<number, GitHubShipmentPullRequest>();
  readonly merges: Array<{ number: number; sha: string }> = [];
  readonly creates: Array<{ base: string; idempotencyKey: string }> = [];
  developSha = "develop-sha";
  featureRuns: GitHubActionsWatchResult[] = [{ outcome: "success", pullRequestNumber: 1, expectedHeadSha: request.expectedHeadSha, workflowRunId: 11, repository: "PiotrGry/zdrovena-reconciliation", testedRevision: request.expectedHeadSha, status: "completed", conclusion: "success", runUrl: "https://github.com/runs/11", polls: 1, providerAttempts: 1 }];
  releaseRuns: GitHubActionsWatchResult[] = [{ outcome: "success", pullRequestNumber: 2, expectedHeadSha: "develop-sha", workflowRunId: 22, repository: "PiotrGry/zdrovena-reconciliation", testedRevision: "develop-sha", status: "completed", conclusion: "success", runUrl: "https://github.com/runs/22", polls: 1, providerAttempts: 1 }];

  async getBranchHead(branch: string): Promise<GitHubOperationResult<{ branch: string; sha: string }>> {
    return success({ branch, sha: branch === "develop" ? this.developSha : request.expectedHeadSha }, "test");
  }
  async listPullRequests(_head: string, base: string): Promise<GitHubOperationResult<readonly GitHubShipmentPullRequest[]>> {
    return success([...this.pulls.values()].filter((pull) => pull.baseBranch === base && pull.state === "open"), "test");
  }
  async getPullRequest(number: number): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> {
    const value = this.pulls.get(number);
    return value === undefined ? { outcome: "permanent_error", error: { code: "not_found", message: "missing" }, correlationId: "test", remoteOutcome: "not_accepted" } : success(value, "test");
  }
  async createPullRequest(input: { baseBranch: string; idempotencyKey: string }): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> {
    const number = input.baseBranch === "develop" ? 1 : 2;
    const value = input.baseBranch === "develop" ? pull(number, "develop", request.expectedHeadSha) : pull(number, "main", this.developSha);
    this.pulls.set(number, value);
    this.creates.push({ base: input.baseBranch, idempotencyKey: input.idempotencyKey });
    return success(value, "test");
  }
  async mergePullRequest(number: number, sha: string): Promise<GitHubOperationResult<{ merged: true; sha: string }>> {
    this.merges.push({ number, sha });
    const value = this.pulls.get(number);
    if (value !== undefined) this.pulls.set(number, { ...value, state: "closed", merged: true, mergeCommitSha: "merge-sha" });
    return success({ merged: true, sha: "merge-sha" }, "test");
  }
  async getWorkflowRun(): Promise<never> { throw new Error("not used"); }
  async listWorkflowRunsForPullRequest(): Promise<never> { throw new Error("not used"); }
  async listWorkflowRunJobs(): Promise<never> { throw new Error("not used"); }
}

function fakeWatcher(gateway: FakeGateway): GitHubShipmentPocWatcher {
  let featureIndex = 0;
  let releaseIndex = 0;
  return { watch: async (input: { pullRequestNumber?: number }) => input.pullRequestNumber === 1 ? gateway.featureRuns[featureIndex++]! : gateway.releaseRuns[releaseIndex++]! };
}

test("shipment POC performs feature merge and stops at green release approval", async () => {
  const gateway = new FakeGateway();
  const result = await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), new InMemoryGitHubShipmentPocStore(), config).execute(request);
  assert.equal(result.outcome, "production_approval_required");
  assert.deepEqual(gateway.merges, [{ number: 1, sha: "feature-sha" }]);
  assert.deepEqual(gateway.creates.map((item) => item.base), ["develop", "main"]);
  assert.equal(result.evidence.featurePullRequest?.runId, 11);
  assert.equal(result.evidence.releasePullRequest?.runId, 22);
});

test("shipment POC fails closed on branch mismatch and does not create or merge", async () => {
  const gateway = new FakeGateway();
  gateway.getBranchHead = async (branch: string) => success({ branch, sha: "other-sha" }, "test");
  const result = await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), new InMemoryGitHubShipmentPocStore(), config).execute(request);
  assert.equal(result.outcome, "stale_head");
  assert.equal(gateway.creates.length, 0);
  assert.equal(gateway.merges.length, 0);
});

test("shipment POC never merges when feature CI is not exact green", async () => {
  const gateway = new FakeGateway();
  gateway.featureRuns = [{ outcome: "failed", pullRequestNumber: 1, expectedHeadSha: request.expectedHeadSha, workflowRunId: 11, repository: "PiotrGry/zdrovena-reconciliation", testedRevision: request.expectedHeadSha, status: "completed", conclusion: "failure", runUrl: "https://github.com/runs/11", failedJobs: [], polls: 1, providerAttempts: 1 }];
  const result = await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), new InMemoryGitHubShipmentPocStore(), config).execute(request);
  assert.equal(result.outcome, "feature_ci_failed");
  assert.equal(gateway.merges.length, 0);
});

test("shipment POC rechecks the feature head immediately before merge", async () => {
  const gateway = new FakeGateway();
  gateway.getPullRequest = async (number: number) => {
    const value = gateway.pulls.get(number) ?? pull(number, number === 1 ? "develop" : "main", "changed-after-ci");
    return success({ ...value, ...(number === 1 ? { headSha: "changed-after-ci" } : {}) }, "test");
  };
  const result = await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), new InMemoryGitHubShipmentPocStore(), config).execute(request);
  assert.equal(result.outcome, "stale_head");
  assert.equal(gateway.merges.length, 0);
});

test("shipment POC replay reuses persisted PRs and merge state", async () => {
  const gateway = new FakeGateway();
  const store = new InMemoryGitHubShipmentPocStore();
  const first = await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), store, config).execute(request);
  assert.equal(first.outcome, "production_approval_required");
  const creates = gateway.creates.length;
  const merges = gateway.merges.length;
  const second = await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), store, config).execute(request);
  assert.equal(second.outcome, "production_approval_required");
  assert.equal(second.replayed, true);
  assert.equal(gateway.creates.length, creates);
  assert.equal(gateway.merges.length, merges);
});

test("shipment POC rejects an event replay with a different revision", async () => {
  const gateway = new FakeGateway();
  const store = new InMemoryGitHubShipmentPocStore();
  await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), store, config).execute(request);
  const result = await new GitHubShipmentPoc(gateway, fakeWatcher(gateway), store, config).execute({ ...request, expectedHeadSha: "different-sha" });
  assert.equal(result.outcome, "policy_blocked");
  assert.equal(result.errorCode, "event_conflict");
});

test("shipment POC file ledger survives a new store instance without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-shipment-ledger-"));
  try {
    const filename = join(root, "state.json");
    const record = { schemaVersion: 1 as const, eventId: "event", owner: "PiotrGry", repository: "zdrovena-reconciliation", featureBase: "develop" as const, releaseBase: "main" as const, headBranch: "pirx/poc-docs", expectedHeadSha: "feature-sha", correlationId: "correlation", createdAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:00:00.000Z" };
    await new FileGitHubShipmentPocStore(filename).save(record);
    const restored = await new FileGitHubShipmentPocStore(filename).get("event");
    assert.deepEqual(restored, record);
    assert.doesNotMatch(await readFile(filename, "utf8"), /token|secret|password/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
