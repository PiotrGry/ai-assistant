import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubCiGatewayAdapter,
  failure,
  success,
  type GitHubActionsReadGateway,
  type GitHubActionsRunJobs,
  type GitHubActionsWorkflowRun,
  type GitHubConfig,
  type GitHubOperationResult,
  type GitHubRequestContext,
} from "../src/index.js";

const config: GitHubConfig = { token: "", owner: "PiotrGry", repository: "ci-fixture", apiUrl: "https://api.github.test", timeoutMs: 100 };
const sha = "0123456789abcdef";
const url = "https://github.com/PiotrGry/ci-fixture/actions/runs/77";

function run(overrides: Partial<GitHubActionsWorkflowRun> = {}): GitHubActionsWorkflowRun {
  return { id: 77, workflowId: 12, name: "required gate", status: "completed", conclusion: "failure", headSha: sha, headBranch: "pirx/test", pullRequestNumbers: [131], url, createdAt: "2026-09-15T10:00:00.000Z", updatedAt: "2026-09-15T10:01:00.000Z", ...overrides };
}

class FakeGateway implements GitHubActionsReadGateway {
  readonly calls = { run: 0, list: 0, jobs: 0 };
  current: GitHubActionsWorkflowRun = run();
  prRuns: readonly GitHubActionsWorkflowRun[] = [this.current];
  jobs: GitHubActionsRunJobs = { failedJobs: [{ id: 88, name: "test", url: `${url}/job/88`, failedSteps: [{ name: "Run tests", number: 4 }, { name: "cleanup", number: 5 }] }] };
  runFailure: GitHubOperationResult<GitHubActionsWorkflowRun> | undefined;
  listFailure: GitHubOperationResult<readonly GitHubActionsWorkflowRun[]> | undefined;
  jobsFailure: GitHubOperationResult<GitHubActionsRunJobs> | undefined;

  async getWorkflowRun(_id: number, context: GitHubRequestContext) {
    this.calls.run += 1;
    return this.runFailure ?? success(this.current, context.correlationId);
  }
  async listWorkflowRunsForPullRequest(_number: number, context: GitHubRequestContext) {
    this.calls.list += 1;
    return this.listFailure ?? success(this.prRuns, context.correlationId);
  }
  async listWorkflowRunJobs(_id: number, context: GitHubRequestContext) {
    this.calls.jobs += 1;
    return this.jobsFailure ?? success(this.jobs, context.correlationId);
  }
}

test("adapter maps provider run identity, pipeline, timestamps and every known status", async () => {
  for (const status of ["requested", "queued", "waiting", "pending", "in_progress"] as const) {
    const gateway = new FakeGateway(); gateway.current = run({ status });
    const result = await new GitHubCiGatewayAdapter(gateway, config).getRun("77", { correlationId: "status" });
    assert.equal(result.outcome, "pending");
    assert.equal(result.run?.status, status);
    assert.equal(result.run?.pipeline?.providerPipelineId, "12");
    assert.equal(result.run?.startedAt, "2026-09-15T10:00:00.000Z");
  }
  const terminal = new FakeGateway(); terminal.current = run({ conclusion: "success" });
  const result = await new GitHubCiGatewayAdapter(terminal, config).getRun("77", { correlationId: "terminal" });
  assert.equal(result.outcome, "success");
  assert.equal(result.run?.completedAt, "2026-09-15T10:01:00.000Z");
});

test("adapter rejects unknown future provider status or conclusion explicitly", async () => {
  const unknownStatus = new FakeGateway(); unknownStatus.current = run({ status: "future_status" as never });
  assert.equal((await new GitHubCiGatewayAdapter(unknownStatus, config).getRun("77", { correlationId: "unknown-status" })).outcome, "unknown");
  const unknownConclusion = new FakeGateway(); unknownConclusion.current = run({ conclusion: "future_conclusion" as never });
  assert.equal((await new GitHubCiGatewayAdapter(unknownConclusion, config).getRun("77", { correlationId: "unknown-conclusion" })).outcome, "unknown");
});

test("adapter resolves only the exact PR, workflow and head revision and forwards bounds", async () => {
  const gateway = new FakeGateway();
  gateway.prRuns = [run({ id: 76, headSha: "old-revision" }), run({ id: 77, conclusion: "success" })];
  const result = await new GitHubCiGatewayAdapter(gateway, config).resolvePullRequest({ pullRequestNumber: 131, expectedHeadSha: sha, requiredWorkflowName: "required gate" }, { correlationId: "resolve", timeoutMs: 100, pollIntervalMs: 1, maxFailedJobs: 1, maxFailedSteps: 1 });
  assert.equal(result.outcome, "success");
  assert.equal(result.run?.providerRunId, "77");
  assert.equal(result.run?.testedRevision, sha);
  assert.equal(gateway.calls.list, 1);
});

test("adapter distinguishes stale, ambiguous, missing, cancellation and rate limit fail-closed outcomes", async () => {
  const stale = new FakeGateway(); stale.prRuns = [run({ headSha: "old-revision" })];
  assert.equal((await new GitHubCiGatewayAdapter(stale, config).resolvePullRequest({ pullRequestNumber: 131, expectedHeadSha: sha }, { correlationId: "stale", timeoutMs: 50, pollIntervalMs: 1 })).outcome, "stale");
  const ambiguous = new FakeGateway(); ambiguous.prRuns = [run(), run({ id: 78 })];
  assert.equal((await new GitHubCiGatewayAdapter(ambiguous, config).resolvePullRequest({ pullRequestNumber: 131, expectedHeadSha: sha }, { correlationId: "ambiguous", timeoutMs: 50, pollIntervalMs: 1 })).outcome, "ambiguous");
  const missing = new FakeGateway(); missing.prRuns = [];
  assert.equal((await new GitHubCiGatewayAdapter(missing, config).resolvePullRequest({ pullRequestNumber: 131, expectedHeadSha: sha, requiredWorkflowName: "required gate" }, { correlationId: "missing", timeoutMs: 2, pollIntervalMs: 1 })).outcome, "timed_out");
  const rate = new FakeGateway(); rate.runFailure = failure("rate_limited", "rate_limited", "limited", "rate", "not_accepted");
  assert.equal((await new GitHubCiGatewayAdapter(rate, config).getRun("77", { correlationId: "rate" })).outcome, "rate_limited");
  const controller = new AbortController(); controller.abort();
  const cancelled = new FakeGateway();
  assert.equal((await new GitHubCiGatewayAdapter(cancelled, config).resolvePullRequest({ pullRequestNumber: 131, expectedHeadSha: sha }, { correlationId: "cancelled", timeoutMs: 50, signal: controller.signal })).outcome, "cancelled");
});

test("adapter returns bounded failure evidence and never exposes provider payloads", async () => {
  const gateway = new FakeGateway();
  const adapter = new GitHubCiGatewayAdapter(gateway, config);
  const runResult = await adapter.getRun("77", { correlationId: "evidence-run" });
  assert.equal(runResult.outcome, "failed");
  assert.ok(runResult.run);
  const evidence = await adapter.getFailureEvidence(runResult.run!, { correlationId: "evidence", maxFailedJobs: 1, maxFailedSteps: 1 });
  assert.equal(evidence.outcome, "success");
  assert.equal(evidence.evidence?.failedJobs.length, 1);
  assert.deepEqual(evidence.evidence?.failedJobs[0]?.failedSteps, [{ name: "Run tests", number: 4 }]);
  assert.equal(JSON.stringify(evidence).includes("raw provider"), false);
  assert.equal(gateway.calls.jobs, 1);
});

test("adapter maps read errors to explicit retryable, unavailable and not-found outcomes", async () => {
  for (const [errorCode, expected] of [["retryable", "retryable"], ["forbidden", "unavailable"], ["not_found", "not_found"]] as const) {
    const gateway = new FakeGateway(); gateway.runFailure = failure(errorCode === "retryable" ? "retryable_error" : "permanent_error", errorCode, "read failed", "failure", "not_accepted");
    assert.equal((await new GitHubCiGatewayAdapter(gateway, config).getRun("77", { correlationId: errorCode })).outcome, expected);
  }
});
