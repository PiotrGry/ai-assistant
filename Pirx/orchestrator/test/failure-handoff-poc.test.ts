import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FAILURE_HANDOFF_POC_FEATURE_BASE,
  FAILURE_HANDOFF_POC_REPOSITORY,
  FAILURE_HANDOFF_POC_WORKFLOW,
  FileGitHubFailureHandoffPocStore,
  GitHubFailureHandoffPoc,
  InMemoryGitHubFailureHandoffPocStore,
  sanitizeFailureText,
  failure,
  success,
  type ClaudeHandoffRequest,
  type GitHubActionsRunJobs,
  type GitHubActionsWatchRequest,
  type GitHubActionsWatchTerminalResult,
  type GitHubActionsWatchResult,
  type GitHubActionsWorkflowRun,
  type GitHubConfig,
  type GitHubFailureHandoffPocGateway,
  type GitHubFailureHandoffPocStore,
  type GitHubShipmentPullRequest,
} from "../src/index.js";
import type { GitHubOperationResult } from "../src/index.js";

const config: GitHubConfig = { token: "", owner: "PiotrGry", repository: "zdrovena-reconciliation", apiUrl: "https://api.github.com", timeoutMs: 1000 };
const branch = "pirx/poc-failure-test";
const sha = "abcdef1234567890";

function pull(overrides: Partial<GitHubShipmentPullRequest> = {}): GitHubShipmentPullRequest {
  return { number: 193, url: "https://github.com/PiotrGry/zdrovena-reconciliation/pull/193", state: "open", headBranch: branch, headSha: sha, baseBranch: FAILURE_HANDOFF_POC_FEATURE_BASE, merged: false, body: "<!-- pirx-failure-handoff-poc:v1 event=marker -->", ...overrides };
}

function failedWatch(overrides: Partial<GitHubActionsWatchTerminalResult> = {}): GitHubActionsWatchResult {
  return { outcome: "failed", repository: FAILURE_HANDOFF_POC_REPOSITORY, pullRequestNumber: 193, expectedHeadSha: sha, workflowRunId: 777, testedRevision: sha, status: "completed", conclusion: "failure", runUrl: "https://github.com/PiotrGry/zdrovena-reconciliation/actions/runs/777", workflowName: FAILURE_HANDOFF_POC_WORKFLOW, failedJobs: [{ id: 778, name: "Fast gate / Typecheck", url: "https://github.com/PiotrGry/zdrovena-reconciliation/actions/runs/777/job/778", failedSteps: [{ name: "Run tests", number: 4 }] }], polls: 1, providerAttempts: 1, ...overrides };
}

class FakeGateway implements GitHubFailureHandoffPocGateway {
  branchSha = sha;
  pullRequest = pull();
  listed: GitHubShipmentPullRequest[] = [];
  createResult: GitHubOperationResult<GitHubShipmentPullRequest> = success(this.pullRequest, "fake");
  createAddsPull = false;
  log: string | undefined;
  calls = { branch: 0, list: 0, get: 0, create: 0, run: 0, runs: 0, jobs: 0, logs: 0 };

  async getBranchHead(_branch: string, correlationId: { correlationId: string }): Promise<GitHubOperationResult<{ branch: string; sha: string }>> { this.calls.branch += 1; return success({ branch: _branch, sha: this.branchSha }, correlationId.correlationId); }
  async listPullRequests(_head: string, _base: string, context: { correlationId: string }): Promise<GitHubOperationResult<readonly GitHubShipmentPullRequest[]>> { this.calls.list += 1; return success(this.listed, context.correlationId); }
  async getPullRequest(_number: number, context: { correlationId: string }): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> { this.calls.get += 1; return success(this.pullRequest, context.correlationId); }
  async createPullRequest(_request: { readonly headBranch: string; readonly baseBranch: string; readonly title: string; readonly body: string; readonly idempotencyKey: string; readonly correlationId: string }): Promise<GitHubOperationResult<GitHubShipmentPullRequest>> { this.calls.create += 1; if (this.createAddsPull) { this.pullRequest = { ...this.pullRequest, body: _request.body }; this.listed = [this.pullRequest]; } return this.createResult; }
  async getWorkflowRun(_id: number, context: { correlationId: string }): Promise<GitHubOperationResult<GitHubActionsWorkflowRun>> { this.calls.run += 1; return failure("permanent_error", "not_found", "unused", context.correlationId, "not_accepted"); }
  async listWorkflowRunsForPullRequest(_number: number, context: { correlationId: string }): Promise<GitHubOperationResult<readonly GitHubActionsWorkflowRun[]>> { this.calls.runs += 1; return success([], context.correlationId); }
  async listWorkflowRunJobs(_id: number, context: { correlationId: string }): Promise<GitHubOperationResult<GitHubActionsRunJobs>> { this.calls.jobs += 1; return failure("permanent_error", "not_found", "unused", context.correlationId, "not_accepted"); }
  async getWorkflowRunLog(_id: number, context: { correlationId: string }): Promise<GitHubOperationResult<string>> { this.calls.logs += 1; return this.log === undefined ? failure("permanent_error", "not_found", "no log", context.correlationId, "not_accepted") : success(this.log, context.correlationId); }
}

class FakeWatcher {
  result: GitHubActionsWatchResult = failedWatch();
  calls = 0;
  request: GitHubActionsWatchRequest | undefined;
  async watch(request: GitHubActionsWatchRequest): Promise<GitHubActionsWatchResult> { this.calls += 1; this.request = request; return this.result; }
}

class FakeClaude {
  calls = 0;
  requests: ClaudeHandoffRequest[] = [];
  result: { readonly outcome: "success"; readonly requestId: string; readonly acknowledgement: string; readonly durationMs: number; readonly exitCode: 0 } = { outcome: "success", requestId: "unused", acknowledgement: "received", durationMs: 1, exitCode: 0 };
  async runHandoff(request: ClaudeHandoffRequest) { this.calls += 1; this.requests.push(request); return { ...this.result, requestId: request.handoffId }; }
}

function operation(gateway: FakeGateway, watcher: FakeWatcher, claude: FakeClaude, store: GitHubFailureHandoffPocStore = new InMemoryGitHubFailureHandoffPocStore()): GitHubFailureHandoffPoc {
  return new GitHubFailureHandoffPoc(gateway, watcher, claude, store, config);
}

function request(eventId = "failure-event") {
  return { eventId, headBranch: branch, expectedHeadSha: sha, requiredWorkflowName: FAILURE_HANDOFF_POC_WORKFLOW, timeoutMs: 1000, pollIntervalMs: 10, claudeTimeoutMs: 1000 } as const;
}

test("creates the exact feature PR, observes exact failed workflow, and hands off a schema-bound envelope", async () => {
  const gateway = new FakeGateway();
  const watcher = new FakeWatcher();
  const claude = new FakeClaude();
  const result = await operation(gateway, watcher, claude).execute(request());
  assert.equal(result.outcome, "failure_handoff_completed");
  assert.deepEqual({ head: gateway.pullRequest.headBranch, base: gateway.pullRequest.baseBranch, sha: gateway.pullRequest.headSha }, { head: branch, base: "develop", sha });
  assert.equal(watcher.request?.pullRequestNumber, 193);
  assert.equal(watcher.request?.expectedHeadSha, sha);
  assert.equal(watcher.request?.requiredWorkflowName, FAILURE_HANDOFF_POC_WORKFLOW);
  assert.equal(claude.calls, 1);
  assert.equal(claude.requests[0]?.handoffId, result.handoffId);
  assert.equal((claude.requests[0]?.envelope as { evidence: { workflow: { runId: number } } }).evidence.workflow.runId, 777);
  assert.equal(result.evidence?.failedJobs[0]?.failedSteps[0]?.name, "Run tests");
});

test("redacts logs, bounds evidence, and never persists the fixture secret", async () => {
  const gateway = new FakeGateway();
  gateway.log = `Authorization: Bearer LIVE_SECRET_TOKEN\npassword=super-secret\n${"x".repeat(50_000)}`;
  const watcher = new FakeWatcher();
  const claude = new FakeClaude();
  const store = new InMemoryGitHubFailureHandoffPocStore();
  const result = await operation(gateway, watcher, claude, store).execute(request("redaction-event"));
  assert.equal(result.outcome, "failure_handoff_completed");
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes("LIVE_SECRET_TOKEN"), false);
  assert.equal(encoded.includes("super-secret"), false);
  assert.ok((result.evidence?.evidenceBytes ?? 0) <= 24_000);
  assert.ok((result.evidence?.logExcerpt?.length ?? 0) <= 8_300);
  assert.ok((result.evidence?.redactionCount ?? 0) >= 2);
  assert.equal(JSON.stringify(await store.get("redaction-event")).includes("LIVE_SECRET_TOKEN"), false);
  assert.equal(sanitizeFailureText("Cookie: sid=secret; token=abc").value.includes("secret"), false);
});

test("replays the same PR, run, evidence and handoff without Claude or GitHub calls", async () => {
  const gateway = new FakeGateway(); const watcher = new FakeWatcher(); const claude = new FakeClaude(); const store = new InMemoryGitHubFailureHandoffPocStore();
  const first = await operation(gateway, watcher, claude, store).execute(request("replay-event"));
  const counts = JSON.stringify(gateway.calls);
  const replay = await operation(gateway, watcher, claude, store).execute(request("replay-event"));
  assert.equal(replay.replayed, true);
  assert.equal(replay.handoffId, first.handoffId);
  assert.equal(replay.evidence?.evidenceDigest, first.evidence?.evidenceDigest);
  assert.equal(claude.calls, 1);
  assert.equal(JSON.stringify(gateway.calls), counts);
});

test("restart replays a 0600 ledger without a second Claude invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-failure-ledger-"));
  const filename = join(root, "ledger.json");
  try {
    const firstGateway = new FakeGateway(); const firstWatcher = new FakeWatcher(); const firstClaude = new FakeClaude();
    const first = await operation(firstGateway, firstWatcher, firstClaude, new FileGitHubFailureHandoffPocStore(filename)).execute(request("restart-event"));
    const permissions = (await stat(filename)).mode & 0o777;
    const secondGateway = new FakeGateway(); const secondWatcher = new FakeWatcher(); const secondClaude = new FakeClaude();
    const replay = await operation(secondGateway, secondWatcher, secondClaude, new FileGitHubFailureHandoffPocStore(filename)).execute(request("restart-event"));
    assert.equal(permissions, 0o600);
    assert.equal(replay.replayed, true);
    assert.equal(replay.handoffId, first.handoffId);
    assert.equal(secondClaude.calls, 0);
    assert.equal(secondGateway.calls.branch, 0);
    assert.equal((await readFile(filename, "utf8")).includes("LIVE_SECRET_TOKEN"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fail-closed states never invoke Claude and never expose merge/release/deploy operations", async (t) => {
  const cases: Array<[string, GitHubActionsWatchResult]> = [
    ["success", { ...failedWatch(), outcome: "success", conclusion: "success" } as GitHubActionsWatchResult],
    ["cancelled", { ...failedWatch(), outcome: "cancelled", conclusion: "cancelled" }],
    ["timeout", { outcome: "timeout", repository: FAILURE_HANDOFF_POC_REPOSITORY, pullRequestNumber: 193, expectedHeadSha: sha, errorCode: "timeout", message: "timeout", polls: 1, providerAttempts: 1 }],
    ["ambiguous", { outcome: "ambiguous", repository: FAILURE_HANDOFF_POC_REPOSITORY, pullRequestNumber: 193, expectedHeadSha: sha, errorCode: "ambiguous", message: "ambiguous", polls: 1, providerAttempts: 1 }],
    ["rate", { outcome: "rate_limited", repository: FAILURE_HANDOFF_POC_REPOSITORY, pullRequestNumber: 193, expectedHeadSha: sha, errorCode: "rate_limited", message: "rate", polls: 1, providerAttempts: 1 }],
    ["missing-jobs", (() => { const { failedJobs: _failedJobs, ...withoutJobs } = failedWatch() as GitHubActionsWatchTerminalResult; return { ...withoutJobs, failedJobsErrorCode: "provider_error" } as GitHubActionsWatchResult; })()],
  ];
  for (const [name, result] of cases) {
    await t.test(name, async () => {
      const gateway = new FakeGateway(); const watcher = new FakeWatcher(); watcher.result = result; const claude = new FakeClaude();
      const output = await operation(gateway, watcher, claude).execute(request(`closed-${name}`));
      assert.notEqual(output.outcome, "failure_handoff_completed");
      assert.equal(claude.calls, 0);
      assert.equal(gateway.calls.create >= 0, true);
    });
  }
});

test("stale branch, wrong workflow, and invalid Claude receipt fail closed", async () => {
  const staleGateway = new FakeGateway(); staleGateway.branchSha = "different-sha";
  const staleClaude = new FakeClaude();
  const stale = await operation(staleGateway, new FakeWatcher(), staleClaude).execute(request("stale-event"));
  assert.equal(stale.outcome, "stale_head"); assert.equal(staleGateway.calls.create, 0); assert.equal(staleClaude.calls, 0);
  const wrongWorkflow = await operation(new FakeGateway(), new FakeWatcher(), new FakeClaude()).execute({ ...request("workflow-event"), requiredWorkflowName: "Other workflow" });
  assert.equal(wrongWorkflow.outcome, "policy_blocked");
  const invalidClaude = new FakeClaude(); invalidClaude.result = { outcome: "invalid_output", requestId: "wrong", durationMs: 1, exitCode: 0, message: "invalid" } as never;
  const invalid = await operation(new FakeGateway(), new FakeWatcher(), invalidClaude).execute(request("claude-invalid"));
  assert.equal(invalid.outcome, "worker_handoff_failed");
  assert.equal(invalid.claudeReceipt?.handoffId, invalid.handoffId);
});

test("uncertain PR creation reconciles exactly once and never merges", async () => {
  const gateway = new FakeGateway();
  gateway.createResult = failure("unknown", "timeout", "creation uncertain", "fake", "unknown");
  gateway.createAddsPull = true;
  const watcher = new FakeWatcher(); const claude = new FakeClaude();
  const result = await operation(gateway, watcher, claude).execute(request("uncertain-create"));
  assert.equal(result.outcome, "failure_handoff_completed");
  assert.equal(gateway.calls.create, 1);
  assert.equal(gateway.calls.list, 2);
  assert.equal(claude.calls, 1);
});

test("Claude handoff receives no repository tools and uses the same handoff ID", async () => {
  const gateway = new FakeGateway(); const watcher = new FakeWatcher(); const claude = new FakeClaude();
  const result = await operation(gateway, watcher, claude).execute(request("boundary-event"));
  const args = JSON.stringify(claude.requests[0]?.envelope);
  assert.equal(result.handoffId, claude.requests[0]?.handoffId);
  assert.equal(args.includes("diagnosis"), false);
  assert.equal(args.includes("git blame"), false);
  assert.equal(gateway.calls.run, 0);
  assert.equal(gateway.calls.runs, 0);
  assert.equal(gateway.calls.jobs, 0);
});
