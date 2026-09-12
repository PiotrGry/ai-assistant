import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PirxAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import { parseOllamaModelNames } from "../src/ollama-models.js";

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

test("parses unique installed Ollama model names", () => {
  assert.deepEqual(
    parseOllamaModelNames({
      models: [{ name: "alpha" }, { name: "beta" }, { name: "alpha" }, { size: 1 }, null],
    }),
    ["alpha", "beta"],
  );
  assert.deepEqual(parseOllamaModelNames({ models: "invalid" }), []);
});

test("switches runtime model only after Ollama validates it", async (context) => {
  const requests: Record<string, unknown>[] = [];
  const unloadRequests: Record<string, unknown>[] = [];
  const ollama = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      sendJson(response, { models: [{ name: "alpha" }, { name: "beta" }] });
      return;
    }
    if (request.method === "POST" && request.url === "/api/chat") {
      requests.push(await requestBody(request));
      sendJson(response, {
        model: "beta",
        message: { role: "assistant", content: "ready" },
        done: true,
        done_reason: "stop",
        total_duration: 1_000_000,
        load_duration: 0,
        prompt_eval_count: 1,
        prompt_eval_duration: 1_000_000,
        eval_count: 1,
        eval_duration: 1_000_000,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/api/generate") {
      unloadRequests.push(await requestBody(request));
      sendJson(response, { model: "beta", response: "", done: true });
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolveListen, reject) => {
    ollama.once("error", reject);
    ollama.listen(0, "127.0.0.1", resolveListen);
  });
  const address = ollama.address();
  assert.ok(address !== null && typeof address === "object");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pirx-model-test-"));
  const promptFile = join(temporaryDirectory, "system.md");
  await writeFile(promptFile, "Jesteś testową asystentką.", "utf8");
  const config: AgentConfig = {
    model: "alpha",
    numCtx: 8_192,
    keepAlive: "1m",
    baseUrl: `http://127.0.0.1:${address.port}`,
    temperature: 0,
    timeZone: "Europe/Warsaw",
    promptFile,
    logDir: join(temporaryDirectory, "logs"),
    mcpServerEntry: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "mcp-server",
      "dist",
      "index.js",
    ),
    maxToolIterations: 8,
    maxRepeatedToolCalls: 3,
    llmTimeoutMs: 120_000,
    toolTimeoutMs: 30_000,
  };

  let agent: PirxAgent | undefined;
  context.after(async () => {
    await agent?.close();
    await new Promise<void>((resolveClose, reject) => {
      ollama.close((error) => (error === undefined ? resolveClose() : reject(error)));
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const activeAgent = agent = await PirxAgent.create(config);
  assert.equal(activeAgent.model, "alpha");
  await activeAgent.setModel("beta");
  assert.equal(activeAgent.model, "beta");
  await assert.rejects(() => activeAgent.setModel("not-installed"), /nie jest zainstalowany/u);
  assert.equal(activeAgent.model, "beta");

  const turn = await activeAgent.chat("Use the selected model.");
  assert.equal(turn.content, "ready");
  assert.equal(turn.metrics.model, "beta");
  assert.equal(requests.at(-1)?.model, "beta");
  assert.equal(requests.at(-1)?.think, false);

  await activeAgent.close();
  agent = undefined;
  assert.deepEqual(unloadRequests, [{
    model: "beta",
    prompt: "",
    stream: false,
    keep_alive: 0,
  }]);
});
