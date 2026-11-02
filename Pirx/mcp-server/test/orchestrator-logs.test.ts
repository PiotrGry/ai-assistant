import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { SystemdOrchestratorLogsPort } from "../src/tools/orchestrator-logs.js";
const realExecute = promisify(execFile);
function entry(n: number, message = "Queue rejected") { return JSON.stringify({ __CURSOR: `s=test;i=${n}`, __REALTIME_TIMESTAMP: "1793631600000000", MESSAGE: message, PRIORITY: "3" }); }
test("journal is fixed-scope, redacted and paginated without duplicating boundary entries", async () => {
  const calls: unknown[][] = [];
  const execute = (async (...args: unknown[]) => { calls.push(args); return { stdout: (calls.length === 1 ? [entry(4, JSON.stringify({ token: "hidden-value", issues: [48, 189] })), entry(3), entry(2), entry(1)] : [entry(3), entry(2), entry(1)]).join("\n"), stderr: "" }; }) as unknown as typeof realExecute;
  const port = new SystemdOrchestratorLogsPort({ platform: "linux", environment: { HOME: "/home/test", SECRET: "not-forwarded" }, execute });
  const first = await port.read(2);
  assert.equal(first.outcome, "success"); if (first.outcome !== "success") return;
  assert.equal(first.nextBeforeCursor, "s=test;i=3");
  assert.equal(JSON.stringify(first).includes("hidden-value"), false);
  assert.deepEqual(JSON.parse(first.entries[0]!.message).issues, [48, 189]);
  const second = await port.read(2, first.nextBeforeCursor);
  assert.equal(second.outcome, "success"); if (second.outcome !== "success") return;
  assert.deepEqual(second.entries.map((item) => item.cursor), ["s=test;i=2", "s=test;i=1"]);
  assert.equal(second.nextBeforeCursor, undefined);
  assert.equal(calls[0]![0], "/usr/bin/journalctl");
  assert.deepEqual(calls[0]![1], ["--user", "--unit=pirx-orchestrator.service", "--output=json", "--no-pager", "--reverse", "--lines=4"]);
  assert.deepEqual(calls[0]![2], { shell: false, env: { HOME: "/home/test" }, timeout: 5_000, maxBuffer: 1_048_576, encoding: "utf8" });
  assert.equal((await port.read(0)).outcome, "invalid_request");
  assert.equal((await port.read(2, "cursor;$(command)")).outcome, "invalid_request");
  assert.equal(calls.length, 2);
});
test("journal reports unsupported, unavailable and malformed data explicitly", async () => {
  assert.equal((await new SystemdOrchestratorLogsPort({ platform: "darwin" }).read(10)).outcome, "unsupported_platform");
  const failing = (async () => { throw new Error("private stderr"); }) as unknown as typeof realExecute;
  const result = await new SystemdOrchestratorLogsPort({ platform: "linux", execute: failing }).read(10);
  assert.equal(result.outcome, "unavailable"); assert.equal(JSON.stringify(result).includes("private"), false);
  const malformed = (async () => ({ stdout: '{}', stderr: "" })) as unknown as typeof realExecute;
  assert.equal((await new SystemdOrchestratorLogsPort({ platform: "linux", execute: malformed }).read(10)).outcome, "invalid_data");
});
