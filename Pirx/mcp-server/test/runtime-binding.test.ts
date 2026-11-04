import assert from "node:assert/strict";
import { mkdtempSync, openSync, closeSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertProcessDatabase } from "../src/runtime-binding.js";

test("two valid database paths cannot impersonate the live daemon runtime", { skip: process.platform !== "linux" }, () => {
  const root = mkdtempSync(join(tmpdir(), "pirx-binding-"));
  const active = join(root, "active.sqlite");
  const other = join(root, "other.sqlite");
  writeFileSync(active, "active"); writeFileSync(other, "other");
  const fd = openSync(active, "r");
  try {
    assert.doesNotThrow(() => assertProcessDatabase(active, process.pid));
    assert.throws(() => assertProcessDatabase(other, process.pid), /Runtime mismatch/);
    assert.throws(() => assertProcessDatabase(active, 2147483647), /Cannot verify/);
  } finally { closeSync(fd); rmSync(root, { recursive: true, force: true }); }
});
