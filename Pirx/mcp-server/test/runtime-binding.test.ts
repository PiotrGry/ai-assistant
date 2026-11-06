import assert from "node:assert/strict";
import { mkdtempSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { assertProcessDatabase, assertServiceProfile, managedRuntimeBinding } from "../src/runtime-binding.js";

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

test("stopped managed service must resolve the same persistent orchestrator profile", () => {
  const root = mkdtempSync(join(tmpdir(), "pirx-stopped-binding-"));
  const expected = join(root, "expected.json");
  const other = join(root, "other.json");
  const environmentFile = join(root, "orchestrator.env");
  writeFileSync(expected, "{}");
  writeFileSync(other, "{}");
  writeFileSync(environmentFile, `PIRX_ORCHESTRATOR_CONFIG=${expected}\nPATH=/usr/bin:/bin\n`);
  const calls: string[][] = [];
  const executeSync = (_file: string, arguments_: readonly string[]) => {
    calls.push([...arguments_]);
    return arguments_.includes("--property=EnvironmentFiles")
      ? `${environmentFile} (ignore_errors=no)\n`
      : "0\n";
  };
  try {
    assert.doesNotThrow(() => assertServiceProfile(expected, readFileSync(environmentFile, "utf8")));
    const check = managedRuntimeBinding(join(root, "runtime.sqlite"), {
      PIRX_ORCHESTRATOR_SERVICE_ENABLED: "true",
    }, expected, { platform: "linux", executeSync, readFile: (filename) => readFileSync(filename, "utf8") });
    assert.doesNotThrow(check);
    assert.equal(calls.length, 2);

    writeFileSync(environmentFile, `PIRX_ORCHESTRATOR_CONFIG=${other}\n`);
    assert.throws(check, /runtime_profile_mismatch/u);
    writeFileSync(environmentFile, `PIRX_ORCHESTRATOR_CONFIG=${expected}\nPIRX_ORCHESTRATOR_CONFIG=${expected}\n`);
    assert.throws(check, /runtime_profile_unverifiable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
