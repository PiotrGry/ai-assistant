import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexCliRunner,
  buildCodexHandoffArguments,
  type CodexSpawn,
} from "../src/index.js";

const SUCCESS = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const schema = JSON.parse(fs.readFileSync(args[args.indexOf("--output-schema") + 1], "utf8"));
const output = args[args.indexOf("--output-last-message") + 1];
const requestId = schema.properties.requestId.const;
process.stdin.resume();
process.stdin.on("end", () => { fs.writeFileSync(output, JSON.stringify({ requestId, acknowledgement: "acknowledged" })); process.exit(0); });
`;

const INVALID = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => { fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], JSON.stringify({ requestId: "wrong", acknowledgement: "bad", extra: true })); process.exit(0); });
`;

const HANG = `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`;

async function executable(root: string, name: string, source: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
  return path;
}

test("builds an ephemeral read-only Codex invocation with an external schema and receipt", () => {
  const args = buildCodexHandoffArguments("/tmp/schema.json", "/tmp/receipt.json");
  assert.deepEqual(args, ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--output-schema", "/tmp/schema.json", "--output-last-message", "/tmp/receipt.json", "--json", "-"]);
  assert.equal(args.includes("--continue"), false);
  assert.equal(args.includes("--resume"), false);
});

test("runs one fresh schema-valid Codex handoff in an empty cwd with an allowlisted environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-codex-test-"));
  try {
    const path = await executable(root, "fake-codex.js", SUCCESS);
    let observed: Parameters<CodexSpawn>[2] | undefined;
    const spawnProcess: CodexSpawn = (file, args, options) => {
      observed = options;
      return spawn(file, [...args], options);
    };
    const result = await new CodexCliRunner({
      executable: path,
      tempParentDirectory: root,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME, PIRX_SECRET: "must-not-cross" },
      spawnProcess,
    }).runHandoff({ handoffId: "handoff-codex-193", envelope: { schemaVersion: 1, evidence: { conclusion: "failure" } } });
    assert.equal(result.outcome, "success");
    if (result.outcome === "success") assert.equal(result.acknowledgement, "acknowledged");
    assert.equal(observed?.shell, false);
    assert.equal(observed?.env.PIRX_SECRET, undefined);
    assert.notEqual(observed?.cwd, root);
    assert.equal(buildCodexHandoffArguments("schema", "output").includes("--sandbox"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a mismatched structured receipt and bounds timeout/cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-codex-test-"));
  try {
    const invalid = await new CodexCliRunner({ executable: await executable(root, "invalid.js", INVALID), tempParentDirectory: root }).runHandoff({ handoffId: "invalid", envelope: {} });
    assert.equal(invalid.outcome, "invalid_output");
    const timeout = await new CodexCliRunner({ executable: await executable(root, "hang.js", HANG), tempParentDirectory: root }).runHandoff({ handoffId: "timeout", envelope: {}, timeoutMs: 40 });
    assert.equal(timeout.outcome, "timeout");
    const controller = new AbortController();
    const pending = new CodexCliRunner({ executable: await executable(root, "hang-2.js", HANG), tempParentDirectory: root }).runHandoff({ handoffId: "cancel", envelope: {}, timeoutMs: 2_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    assert.equal((await pending).outcome, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid bounds before spawning", async () => {
  let spawned = 0;
  const spawnProcess: CodexSpawn = () => { spawned += 1; throw new Error("must not spawn"); };
  const result = await new CodexCliRunner({ spawnProcess }).runHandoff({ handoffId: "bounds", envelope: {}, timeoutMs: 0 });
  assert.equal(result.outcome, "process_error");
  assert.equal(spawned, 0);
});
