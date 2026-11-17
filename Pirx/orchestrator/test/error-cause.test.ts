import assert from "node:assert/strict";
import test from "node:test";

import { errorCause } from "../src/index.js";

test("a system error names its code and message without a stack trace", () => {
  const error = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  assert.equal(errorCause(error), "Error[ENOENT]: spawn claude ENOENT");
});

test("an unexpected error keeps a bounded stack trace", () => {
  const cause = errorCause(new TypeError("Cannot read properties of undefined (reading 'id')"));
  assert.match(cause, /^TypeError: Cannot read properties of undefined \(reading 'id'\)\n {2}at /u);
  assert.ok(cause.split("\n").length <= 9, cause);
});

test("a thrown non-Error value is still described", () => {
  assert.equal(errorCause("disk full"), "Non-Error thrown: disk full");
  assert.equal(errorCause({ reason: "busy" }), 'Non-Error thrown: {"reason":"busy"}');
  assert.equal(errorCause(undefined), "Non-Error thrown: undefined");
});

test("secrets in the cause are redacted and the cause is bounded", () => {
  const cause = errorCause(Object.assign(new Error(`request failed token=ghp_abcdefghijklmnop Bearer xyz ${"x".repeat(5_000)}`), { code: "EIO" }));
  assert.doesNotMatch(cause, /ghp_abcdefghijklmnop|Bearer xyz/u);
  assert.ok(cause.length <= 2_048, String(cause.length));
});
