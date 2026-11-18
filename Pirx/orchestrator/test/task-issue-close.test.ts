import assert from "node:assert/strict";
import test from "node:test";

import { GitHubTaskIssueCloser } from "../src/github/task-issue-close.js";

const request = { issueNumber: 505, taskId: "gh-505", attemptId: "attempt-5", commit: "a".repeat(40), summary: "Task completed: merged into develop.", timestamp: "2026-11-18T10:00:00.000Z" };
const ok = { outcome: "success" as const, value: {} as never, correlationId: "c", remoteOutcome: "accepted" as const };
const failed = { outcome: "permanent_error" as const, error: { code: "forbidden" as const, message: "GitHub rejected the operation with HTTP 403." }, correlationId: "c", remoteOutcome: "not_accepted" as const };

test("a completed Task's Issue gets one evidence comment, then is closed", async () => {
  const calls: string[] = [];
  const closer = new GitHubTaskIssueCloser({
    publishLifecycleComment: async (input) => { calls.push(`comment ${input.issue} ${input.envelope.eventType} ${input.envelope.eventId} ${input.envelope.commit}`); return ok; },
    closeIssue: async (input) => { calls.push(`close ${input.issue}`); return ok; },
  });
  assert.deepEqual(await closer.close(request), { closed: true, message: "Closed Issue #505." });
  assert.deepEqual(calls, [`comment 505 task_completed task_completed:gh-505 ${"a".repeat(40)}`, "close 505"]);
});

test("an Issue whose completion comment failed stays open, so the evidence is never lost", async () => {
  let closes = 0;
  const closer = new GitHubTaskIssueCloser({ publishLifecycleComment: async () => failed as never, closeIssue: async () => { closes += 1; return ok; } });
  const result = await closer.close(request);
  assert.equal(result.closed, false);
  assert.match(result.message, /HTTP 403/u);
  assert.equal(closes, 0);
});
