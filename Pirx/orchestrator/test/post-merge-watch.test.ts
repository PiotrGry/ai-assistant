import assert from "node:assert/strict";
import test from "node:test";

import type { GitHubActionsWorkflowRun } from "../src/github/ci-watch.js";
import type { GitHubOperationResult } from "../src/github/outcome.js";
import { watchPostMerge, type PostMergeGateway, type PostMergePolicy } from "../src/runtime/post-merge-watch.js";
import type { UtcTimestamp } from "../src/index.js";

const merge = "a".repeat(40); const before = "0".repeat(40); const later = "b".repeat(40);
const mergedAt = "2026-11-17T20:55:00.000Z" as UtcTimestamp;
const at = (minutes: number): UtcTimestamp => new Date(Date.parse(mergedAt) + minutes * 60_000).toISOString() as UtcTimestamp;
const ok = <T>(value: T): GitHubOperationResult<T> => ({ outcome: "success", value, correlationId: "test" } as GitHubOperationResult<T>);
const policy: PostMergePolicy = { checks: [{ workflow: "release-validation.yml", branch: "develop" }, { workflow: "prod-deploy.yml", branch: "main", optional: true }], mustReach: ["main"], optionalGraceMinutes: 15, timeoutMinutes: 180 };

function run(id: number, headSha: string, status: GitHubActionsWorkflowRun["status"], conclusion?: GitHubActionsWorkflowRun["conclusion"], updatedMinutes = 2): GitHubActionsWorkflowRun {
  return { id, status, headSha, pullRequestNumbers: [], url: `https://github.com/o/r/actions/runs/${id}`, updatedAt: at(updatedMinutes), ...(conclusion === undefined ? {} : { conclusion }) };
}

/** develop and main histories as ordered SHA lists; a SHA contains every SHA before it. */
class FakeGateway implements PostMergeGateway {
  runs = new Map<string, GitHubActionsWorkflowRun[]>();
  heads = new Map<string, string>([["main", merge]]);
  order = [before, merge, later];
  async listWorkflowRuns(workflow: string) { return ok(this.runs.get(workflow) ?? []); }
  async contains(ancestor: string, head: string) { return ok(this.order.indexOf(head) >= this.order.indexOf(ancestor)); }
  async branchHead(branch: string) { return ok(this.heads.get(branch) ?? before); }
}

test("passes once validation passed, main holds the merge and a skipped deploy's grace ran out", async () => {
  const gateway = new FakeGateway();
  gateway.runs.set("release-validation.yml", [run(2, merge, "completed", "success"), run(1, before, "completed", "failure")]);
  const early = await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(10), gateway });
  assert.equal(early.outcome, "waiting", early.message);
  assert.match(early.message, /prod-deploy\.yml on main \(optional\)/u);
  const done = await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(20), gateway });
  assert.equal(done.outcome, "passed", done.message);
  assert.deepEqual(done.passedRunIds, [2]);
});

test("an older failing run that does not contain the merge is not this change's failure", async () => {
  const gateway = new FakeGateway();
  gateway.runs.set("release-validation.yml", [run(1, before, "completed", "failure")]);
  const result = await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(5), gateway });
  assert.equal(result.outcome, "waiting", result.message);
});

test("the earliest run that contains the merge decides, even when a later one passed", async () => {
  const gateway = new FakeGateway();
  gateway.runs.set("release-validation.yml", [run(3, later, "completed", "success"), run(2, merge, "completed", "failure")]);
  const result = await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(5), gateway });
  assert.equal(result.outcome, "failed", result.message);
  assert.equal(result.failedRun?.id, 2);
});

test("a deploy that does run for the change must pass", async () => {
  const gateway = new FakeGateway();
  gateway.runs.set("release-validation.yml", [run(2, merge, "completed", "success")]);
  gateway.runs.set("prod-deploy.yml", [run(5, merge, "in_progress")]);
  assert.equal((await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(60), gateway })).outcome, "waiting");
  gateway.runs.set("prod-deploy.yml", [run(5, merge, "completed", "failure")]);
  const failed = await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(61), gateway });
  assert.equal(failed.outcome, "failed", failed.message);
  assert.match(failed.message, /prod-deploy\.yml on main failed for aaaaaaa: run 5 ended failure/u);
});

test("a merge that never reaches main times out instead of passing", async () => {
  const gateway = new FakeGateway(); gateway.heads.set("main", before);
  gateway.runs.set("release-validation.yml", [run(2, merge, "completed", "success")]);
  assert.equal((await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(60), gateway })).outcome, "waiting");
  const late = await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(181), gateway });
  assert.equal(late.outcome, "timed_out", late.message);
  assert.match(late.message, /aaaaaaa to reach main/u);
});

test("a GitHub read failure is unavailable, never a pass", async () => {
  const gateway = new FakeGateway();
  gateway.branchHead = async () => ({ outcome: "retryable_error", error: { code: "retryable", message: "GitHub is temporarily unavailable." }, correlationId: "x", remoteOutcome: "not_accepted" } as GitHubOperationResult<string>);
  const result = await watchPostMerge({ policy, mergeSha: merge, mergedAt, now: at(5), gateway });
  assert.equal(result.outcome, "unavailable");
  assert.match(result.message, /Reading main failed: GitHub is temporarily unavailable/u);
});
