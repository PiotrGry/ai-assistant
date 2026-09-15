import assert from "node:assert/strict";
import test from "node:test";

import {
  failure,
  GitHubActionsGateway,
  GitHubActionsWatcher,
  type GitHubActionsReadGateway,
  type GitHubActionsWorkflowRun,
  type GitHubConfig,
  type GitHubOperationResult,
  type GitHubRequestContext,
} from "../src/index.js";

const config: GitHubConfig = {
  token: "secret-token",
  owner: "PiotrGry",
  repository: "ai-assistant",
  apiUrl: "https://api.github.test",
  timeoutMs: 1_000,
};

function run(overrides: Partial<GitHubActionsWorkflowRun> = {}): GitHubActionsWorkflowRun {
  return {
    id: 901,
    name: "check",
    status: "in_progress",
    headSha: "sha-current",
    pullRequestNumbers: [189],
    url: "https://github.com/PiotrGry/ai-assistant/actions/runs/901",
    ...overrides,
  };
}

function success<T>(value: T, correlationId = "ci-test"): GitHubOperationResult<T> {
  return { outcome: "success", value, correlationId, remoteOutcome: "accepted" };
}

class FakeClock {
  time = 0;
  readonly sleeps: number[] = [];

  now = () => this.time;

  sleep = async (delayMs: number) => {
    this.sleeps.push(delayMs);
    this.time += delayMs;
  };
}

class FakeGateway implements GitHubActionsReadGateway {
  readonly runs: GitHubActionsWorkflowRun[];
  readonly prRuns: readonly GitHubActionsWorkflowRun[];
  readonly failedJobs: readonly { id: number; name: string; failedSteps: readonly { name: string }[] }[];
  getRunCalls = 0;
  listRunCalls = 0;
  listJobCalls = 0;
  runFailure: GitHubOperationResult<GitHubActionsWorkflowRun> | undefined;
  listFailure: GitHubOperationResult<readonly GitHubActionsWorkflowRun[]> | undefined;
  jobFailure: GitHubOperationResult<{ failedJobs: readonly { id: number; name: string; failedSteps: readonly { name: string }[] }[] }> | undefined;

  constructor(runs: GitHubActionsWorkflowRun[] = [run()], prRuns = runs) {
    this.runs = runs;
    this.prRuns = prRuns;
    this.failedJobs = [{ id: 33, name: "test", failedSteps: [{ name: "assertions" }] }];
  }

  async getWorkflowRun(_runId: number, context: GitHubRequestContext) {
    this.getRunCalls += 1;
    if (this.runFailure !== undefined) return this.runFailure;
    const next = this.runs.shift() ?? run({ status: "completed", conclusion: "success" });
    return success(next, context.correlationId);
  }

  async listWorkflowRunsForPullRequest(_pullRequestNumber: number, context: GitHubRequestContext) {
    this.listRunCalls += 1;
    if (this.listFailure !== undefined) return this.listFailure;
    return success(this.prRuns, context.correlationId);
  }

  async listWorkflowRunJobs(_runId: number, context: GitHubRequestContext) {
    this.listJobCalls += 1;
    if (this.jobFailure !== undefined) return this.jobFailure;
    return success({ failedJobs: this.failedJobs }, context.correlationId);
  }
}

test("watcher polls internally from pending to success for an exact run", async () => {
  const clock = new FakeClock();
  const gateway = new FakeGateway([
    run({ status: "requested" }),
    run({ status: "waiting" }),
    run({ status: "pending" }),
    run({ status: "queued" }),
    run(),
    run({ status: "completed", conclusion: "success" }),
  ]);
  const result = await new GitHubActionsWatcher(gateway, config, { clock }).watch({
    workflowRunId: 901,
    timeoutMs: 20,
    pollIntervalMs: 2,
  });

  assert.equal(result.outcome, "success");
  assert.equal(result.workflowRunId, 901);
  assert.equal(result.testedRevision, "sha-current");
  assert.equal(result.polls, 6);
  assert.deepEqual(clock.sleeps, [2, 2, 2, 2, 2]);
  assert.equal(gateway.getRunCalls, 6);
});

test("Actions gateway keeps every non-terminal GitHub run status observable", async () => {
  for (const status of ["requested", "waiting", "pending", "queued", "in_progress"]) {
    const transport = {
      async restRead<T>(_request: unknown, context: GitHubRequestContext) {
        return success({ id: 901, status, conclusion: null, head_sha: "sha-current", html_url: "https://github.com/PiotrGry/ai-assistant/actions/runs/901" }, context.correlationId) as GitHubOperationResult<T>;
      },
    };
    const result = await new GitHubActionsGateway(transport, config, { retryPolicy: { maxAttempts: 1 } }).getWorkflowRun(901, { correlationId: "status" });
    assert.equal(result.outcome === "success" ? result.value.status : result.outcome, status);
  }
});

test("watcher marks failed-run evidence incomplete when job lookup fails", async () => {
  const clock = new FakeClock();
  const gateway = new FakeGateway([run({ status: "completed", conclusion: "failure" })]);
  gateway.jobFailure = failure("rate_limited", "rate_limited", "rate limited", "ci-test", "not_accepted");
  const result = await new GitHubActionsWatcher(gateway, config, { clock }).watch({ workflowRunId: 901, timeoutMs: 10 });

  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") return;
  assert.equal(result.failedJobs, undefined);
  assert.equal(result.failedJobsErrorCode, "rate_limited");
});

test("watcher returns bounded failed job and step references", async () => {
  const clock = new FakeClock();
  const gateway = new FakeGateway([run({ status: "completed", conclusion: "failure" })]);
  const result = await new GitHubActionsWatcher(gateway, config, { clock }).watch({
    pullRequestNumber: 189,
    expectedHeadSha: "sha-current",
    timeoutMs: 10,
    maxFailedJobs: 1,
    maxFailedSteps: 1,
  });

  assert.equal(result.outcome, "failed");
  if (result.outcome !== "failed") return;
  assert.deepEqual(result.failedJobs, [{ id: 33, name: "test", failedSteps: [{ name: "assertions" }] }]);
  assert.equal(gateway.listJobCalls, 1);
});

test("watcher distinguishes stale and ambiguous PR head matches", async () => {
  const clock = new FakeClock();
  const stale = new FakeGateway([], [run({ headSha: "sha-old" })]);
  const staleResult = await new GitHubActionsWatcher(stale, config, { clock }).watch({ pullRequestNumber: 189, expectedHeadSha: "sha-current", timeoutMs: 10 });
  assert.equal(staleResult.outcome, "stale");

  const ambiguous = new FakeGateway([], [run(), run({ id: 902 })]);
  const ambiguousResult = await new GitHubActionsWatcher(ambiguous, config, { clock }).watch({ pullRequestNumber: 189, expectedHeadSha: "sha-current", timeoutMs: 10 });
  assert.equal(ambiguousResult.outcome, "ambiguous");
});

test("watcher selects only the explicitly required workflow and fails closed on missing or duplicate gates", async () => {
  const clock = new FakeClock();
  const named = new FakeGateway([], [run({ name: "Develop — Fast Gate", status: "completed", conclusion: "success" }), run({ id: 902, name: "Other workflow", status: "completed", conclusion: "success" })]);
  const selected = await new GitHubActionsWatcher(named, config, { clock }).watch({ pullRequestNumber: 189, expectedHeadSha: "sha-current", requiredWorkflowName: "Develop — Fast Gate", timeoutMs: 10 });
  assert.equal(selected.outcome, "success");
  assert.equal(selected.workflowName, "Develop — Fast Gate");

  const missing = new FakeGateway([], [run({ name: "Other workflow", status: "completed", conclusion: "success" })]);
  const missingResult = await new GitHubActionsWatcher(missing, config, { clock }).watch({ pullRequestNumber: 189, expectedHeadSha: "sha-current", requiredWorkflowName: "Develop — Fast Gate", timeoutMs: 10 });
  assert.equal(missingResult.outcome, "timeout");

  const duplicate = new FakeGateway([], [run({ name: "Develop — Fast Gate" }), run({ id: 902, name: "Develop — Fast Gate" })]);
  const duplicateResult = await new GitHubActionsWatcher(duplicate, config, { clock }).watch({ pullRequestNumber: 189, expectedHeadSha: "sha-current", requiredWorkflowName: "Develop — Fast Gate", timeoutMs: 10 });
  assert.equal(duplicateResult.outcome, "ambiguous");
});

test("watcher exposes cancellation and timeout without another model/tool call", async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await new GitHubActionsWatcher(new FakeGateway(), config, { clock }).watch({ workflowRunId: 901, signal: controller.signal, timeoutMs: 10 });
  assert.equal(cancelled.outcome, "cancelled");

  const timeoutClock = new FakeClock();
  const timeoutGateway = new FakeGateway([run(), run(), run(), run()]);
  const timedOut = await new GitHubActionsWatcher(timeoutGateway, config, { clock: timeoutClock }).watch({ workflowRunId: 901, timeoutMs: 3, pollIntervalMs: 1 });
  assert.equal(timedOut.outcome, "timeout");
  assert.equal(timeoutClock.time, 3);
});

test("watcher maps rate limits and provider errors explicitly", async () => {
  const clock = new FakeClock();
  const rateLimited = new FakeGateway();
  rateLimited.runFailure = failure("rate_limited", "rate_limited", "rate limited", "ci-test", "not_accepted");
  const rateResult = await new GitHubActionsWatcher(rateLimited, config, { clock }).watch({ workflowRunId: 901, timeoutMs: 10 });
  assert.equal(rateResult.outcome, "rate_limited");

  const provider = new FakeGateway();
  provider.runFailure = failure("permanent_error", "forbidden", "provider failed", "ci-test", "not_accepted");
  const providerResult = await new GitHubActionsWatcher(provider, config, { clock }).watch({ workflowRunId: 901, timeoutMs: 10 });
  assert.equal(providerResult.outcome, "provider_error");

  const unknown = new FakeGateway([run({ status: "completed", conclusion: "unknown" })]);
  const unknownResult = await new GitHubActionsWatcher(unknown, config, { clock }).watch({ workflowRunId: 901, timeoutMs: 10 });
  assert.equal(unknownResult.outcome, "unknown");
});

test("watcher validates identity and all polling bounds", async () => {
  const clock = new FakeClock();
  const watcher = new GitHubActionsWatcher(new FakeGateway(), config, { clock, maxTimeoutMs: 20, maxPollIntervalMs: 5 });
  assert.equal((await watcher.watch({ workflowRunId: 901, pullRequestNumber: 189, timeoutMs: 10 })).outcome, "invalid_request");
  assert.equal((await watcher.watch({ pullRequestNumber: 189, expectedHeadSha: "x", timeoutMs: 10 })).outcome, "invalid_request");
  assert.equal((await watcher.watch({ workflowRunId: 901, timeoutMs: 21 })).outcome, "invalid_request");
  assert.equal((await watcher.watch({ workflowRunId: 901, timeoutMs: 10, pollIntervalMs: 6 })).outcome, "invalid_request");
});

test("Actions gateway uses the centralized read transport and sanitizes response shape", async () => {
  const calls: Array<{ path: string; query?: Readonly<Record<string, string | number | boolean | undefined>> }> = [];
  const transport = {
    async restRead<T>(request: { path: string; query?: Readonly<Record<string, string | number | boolean | undefined>> }, context: GitHubRequestContext) {
      calls.push(request);
      const value = request.path.endsWith("/jobs")
        ? { jobs: [{ id: 77, name: "unit", html_url: "https://github.com/PiotrGry/ai-assistant/actions/runs/901/job/77", conclusion: "failure", steps: [{ name: "Run tests", number: 1, conclusion: "failure" }] }] }
        : request.path.endsWith("/actions/runs")
          ? { workflow_runs: [{ id: 901, name: "CI", status: "completed", conclusion: "failure", head_sha: "sha-current", html_url: "https://github.com/PiotrGry/ai-assistant/actions/runs/901", pull_requests: [{ number: 189 }] }] }
          : { id: 901, name: "CI", status: "completed", conclusion: "success", head_sha: "sha-current", html_url: "https://github.com/PiotrGry/ai-assistant/actions/runs/901", pull_requests: [{ number: 189 }] };
      return success(value, context.correlationId) as GitHubOperationResult<T>;
    },
  };
  const gateway = new GitHubActionsGateway(transport, config, { retryPolicy: { maxAttempts: 1 } });
  const runResult = await gateway.getWorkflowRun(901, { correlationId: "gateway" });
  assert.equal(runResult.outcome, "success");
  assert.equal((runResult as { value: GitHubActionsWorkflowRun }).value.id, 901);
  const jobsResult = await gateway.listWorkflowRunJobs(901, { correlationId: "gateway-jobs" });
  assert.equal(jobsResult.outcome, "success");
  assert.deepEqual((jobsResult as { value: { failedJobs: readonly unknown[] } }).value.failedJobs, [{ id: 77, name: "unit", url: "https://github.com/PiotrGry/ai-assistant/actions/runs/901/job/77", failedSteps: [{ name: "Run tests", number: 1 }] }]);
  assert.equal(calls.length, 2);
});
