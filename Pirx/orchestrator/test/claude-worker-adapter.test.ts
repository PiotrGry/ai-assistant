import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ClaudeCodeCliRunner,
  ClaudeCodeProcessAdapter,
  type ClaudeCodeInput,
  type ClaudeStructuredResult,
  type ClaudeStructuredRunner,
  type ClaudeSpawn,
  type WorkerPort,
} from "../src/index.js";
import { registerWorkerAdapterContractSuite, validResult, type WorkerAdapterContractFactory, type WorkerAdapterContractScenario } from "./worker-adapter-contract.js";

const fakeClaude = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
const requestId = schema.properties?.requestId?.const;
fs.writeFileSync(process.env.PIRX_CAPTURE, JSON.stringify({ cwd: process.cwd(), args }));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { accepted: true, requestId } }));
`;

function envelope(request: { readonly taskId: string; readonly attemptId: string; readonly correlationId: string; readonly workspace: { readonly branch: string; readonly worktree: string } }): ClaudeCodeInput {
  return {
    kind: "claude_code_input", schemaVersion: 1, mode: "new", taskId: request.taskId as never, attemptId: request.attemptId as never, workerId: "contract-worker", provider: "contract-provider", correlationId: request.correlationId,
    task: { goal: "contract", scope: "contract", acceptanceCriteria: ["contract"] }, repository: { owner: "PiotrGry", repository: "ai-assistant" }, workspace: request.workspace,
    capabilities: { required: ["repository.read", "tests.run"], granted: ["repository.read", "tests.run"] }, limits: { timeoutMs: 30_000, maxOutputBytes: 10_000, maxErrorBytes: 10_000 }, responseContract: { schemaVersion: 1, requiredFields: ["kind", "schemaVersion", "taskId", "attemptId", "correlationId", "outcome"], outcomes: ["CODE_PUSHED", "BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN"] },
  };
}

class AdapterFactory implements WorkerAdapterContractFactory {
  #calls = 0;
  create(scenario: WorkerAdapterContractScenario): WorkerPort {
    const runner: ClaudeStructuredRunner = {
      runStructured: async (request) => {
        this.#calls += 1;
        const input = JSON.parse(request.prompt) as ClaudeCodeInput;
        if (scenario === "throw") throw new Error("provider token=hidden");
        const value = validResult({ taskId: input.taskId, attemptId: input.attemptId, correlationId: input.correlationId, workspace: input.workspace } as never, scenario);
        return { outcome: "success", requestId: request.requestId, structuredOutput: value, durationMs: 0, exitCode: 0 } satisfies ClaudeStructuredResult;
      },
    };
    return new ClaudeCodeProcessAdapter({ runner, inputSource: { create: (request) => ({ ok: true, value: envelope(request) }) }, promptRenderer: { render: (input) => JSON.stringify(input) } });
  }
  invocationCount(): number { return this.#calls; }
}

registerWorkerAdapterContractSuite({ name: "Claude Code process adapter", factory: () => new AdapterFactory() });

test("runs the same process boundary in the exact assigned worktree with shell disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-claude-adapter-process-test-"));
  const worktree = join(root, "assigned-worktree");
  const executable = join(root, "fake-claude.cjs");
  const capture = join(root, "capture.json");
  await mkdir(worktree);
  await writeFile(executable, fakeClaude, { mode: 0o700 });
  await chmod(executable, 0o700);
  try {
    let observed: { cwd: string; shell: false; env: NodeJS.ProcessEnv } | undefined;
    const spawnProcess: ClaudeSpawn = (file, args, options): ChildProcess => { observed = { cwd: options.cwd, shell: options.shell, env: options.env }; return spawn(file, [...args], options); };
    const runner = new ClaudeCodeCliRunner({ executable, environment: { PATH: process.env.PATH, HOME: process.env.HOME, PIRX_SECRET: "not-forwarded" }, additionalEnvironment: { PIRX_CAPTURE: capture }, spawnProcess });
    const result = await runner.runStructured({ requestId: "claude-process-request", cwd: worktree, prompt: "external prompt", responseSchema: { type: "object", properties: { requestId: { const: "claude-process-request" } } } });
    assert.equal(result.outcome, "success", JSON.stringify(result));
    if (result.outcome === "success") assert.deepEqual(result.structuredOutput, { accepted: true, requestId: "claude-process-request" });
    assert.deepEqual(observed, { cwd: worktree, shell: false, env: observed?.env });
    assert.equal(observed?.env.PIRX_SECRET, undefined);
    const captured = JSON.parse(await readFile(capture, "utf8")) as { cwd: string; args: string[] };
    assert.equal(captured.cwd, worktree);
    assert.equal(captured.args.includes("external prompt"), true);
    assert.equal(captured.args.includes("--no-session-persistence"), true);
    assert.equal(captured.args.includes("mcp__*"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
