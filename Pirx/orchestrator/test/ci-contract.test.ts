import assert from "node:assert/strict";
import test from "node:test";

import {
  CI_RUN_SCHEMA_VERSION,
  type CiRun,
  type CiRunByPullRequestQuery,
  type CiRunQueryContext,
  type ProviderIndependentCiGateway,
} from "../src/index.js";

const run: CiRun = {
  schemaVersion: CI_RUN_SCHEMA_VERSION,
  provider: "test-ci",
  providerRunId: "run-7",
  pipeline: { provider: "test-ci", providerPipelineId: "pipeline-2", name: "required gate", url: "https://ci.test/pipelines/2" },
  name: "required gate",
  status: "completed",
  conclusion: "failure",
  testedRevision: "0123456789abcdef",
  headBranch: "pirx/test",
  pullRequestNumbers: [131],
  url: "https://ci.test/runs/7",
  startedAt: "2026-09-15T10:00:00.000Z",
  completedAt: "2026-09-15T10:01:00.000Z",
  checks: [{ provider: "test-ci", providerCheckId: "check-8", name: "typecheck", status: "completed", conclusion: "failure", testedRevision: "0123456789abcdef" }],
};

test("provider-independent CI models round-trip identities, exact revision and bounded evidence", () => {
  const encoded = JSON.stringify({
    run,
    evidence: {
      schemaVersion: CI_RUN_SCHEMA_VERSION,
      provider: run.provider,
      providerRunId: run.providerRunId,
      run,
      failedJobs: [{ providerJobId: "job-9", name: "gate", conclusion: "failure", failedSteps: [{ name: "test", number: 4 }] }],
    },
  });
  const decoded = JSON.parse(encoded) as { run: CiRun };
  assert.equal(decoded.run.providerRunId, "run-7");
  assert.equal(decoded.run.testedRevision, "0123456789abcdef");
  assert.equal(decoded.run.pipeline?.providerPipelineId, "pipeline-2");
  assert.equal(decoded.run.checks?.[0]?.providerCheckId, "check-8");
});

test("a consumer can handle every normalized terminal, pending and unavailable outcome without provider types", async () => {
  const seen: CiRunByPullRequestQuery[] = [];
  const outcomes = ["success", "pending", "failed", "cancelled", "timed_out", "not_found", "ambiguous", "stale", "rate_limited", "retryable", "permanent", "unknown", "unavailable"] as const;
  let index = 0;
  const gateway: ProviderIndependentCiGateway = {
    async getRun(_providerRunId: string, _context: CiRunQueryContext) {
      return { outcome: outcomes[index++ % outcomes.length]!, message: "normalized", polls: 0 };
    },
    async resolvePullRequest(query: CiRunByPullRequestQuery, _context: CiRunQueryContext) {
      seen.push(query);
      return { outcome: "stale", message: "exact revision was not observed", polls: 1 };
    },
    async getFailureEvidence(_run: CiRun, _context: CiRunQueryContext) {
      return { outcome: "success", message: "bounded", evidence: { schemaVersion: 1, provider: "test-ci", providerRunId: "run-7", run, failedJobs: [] } };
    },
  };
  for (const expected of outcomes) assert.equal((await gateway.getRun("run-7", { correlationId: "contract" })).outcome, expected);
  const query: CiRunByPullRequestQuery = { pullRequestNumber: 131, expectedHeadSha: run.testedRevision, ...(run.name === undefined ? {} : { requiredWorkflowName: run.name }) };
  assert.equal((await gateway.resolvePullRequest(query, { correlationId: "exact" })).outcome, "stale");
  assert.deepEqual(seen, [query]);
});
