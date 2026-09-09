import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SessionLogger } from "../src/logger.js";
import type { AgentConfig } from "../src/config.js";
import type { TurnMetrics } from "../src/agent.js";
import { SqliteStore } from "../src/storage/sqlite.js";

function metrics(timestamp: string): TurnMetrics {
  return {
    timestamp,
    model: "test-model",
    time_zone: "Europe/Warsaw",
    context: 8192,
    temperature: 0,
    system_prompt_file: "/tmp/system.md",
    system_prompt_sha256: "prompt-hash",
    prompt: "test",
    response: "ok",
    input_tokens: 3,
    output_tokens: 2,
    total_seconds: 0.2,
    load_seconds: 0,
    prompt_tokens_per_second: 15,
    generation_tokens_per_second: 10,
    done_reason: "stop",
    model_calls: 1,
    tool_calls: 0,
    context_estimates: [],
    gpu_before: null,
    gpu_after: null,
  };
}

test("SessionLogger persists the environment, session and completed turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pirx-logger-test-"));
  const promptFile = join(directory, "system.md");
  const storageFile = join(directory, "data", "pirx.sqlite");
  await writeFile(promptFile, "Jesteś testem.", "utf8");

  const config: AgentConfig = {
    model: "test-model",
    numCtx: 8192,
    keepAlive: "1m",
    baseUrl: "http://127.0.0.1:11434",
    temperature: 0,
    maxOutputTokens: 1536,
    contextSafetyMarginTokens: 512,
    timeZone: "Europe/Warsaw",
    promptFile,
    logDir: join(directory, "logs"),
    storagePath: storageFile,
    mcpServerEntry: join(directory, "mcp.js"),
    maxToolIterations: 8,
    maxRepeatedToolCalls: 3,
    llmTimeoutMs: 1000,
    toolTimeoutMs: 1000,
  };

  const logger = await SessionLogger.create(config, {
    content: "Jesteś testem.",
    sha256: "prompt-hash",
  });
  await logger.saveTurn(
    "Sprawdź stan.",
    "Stan jest poprawny.",
    metrics("2026-09-09T10:00:00.000Z"),
  );
  await logger.close();

  const store = SqliteStore.open({ filename: storageFile });
  try {
    assert.equal(store.count("run_environments"), 1);
    assert.equal(store.count("sessions"), 1);
    assert.equal(store.count("turns"), 1);
  } finally {
    store.close();
  }

  assert.match(
    await readFile(logger.transcriptFile, "utf8"),
    /Stan jest poprawny\./u,
  );
  await rm(directory, { recursive: true, force: true });
});
