import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PirxAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("agent wykonuje pełną pętlę Ollama → MCP → Ollama", async (context) => {
  const requests: Record<string, unknown>[] = [];
  const ollama = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      sendJson(response, { models: [] });
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/chat") {
      response.writeHead(404).end();
      return;
    }

    const body = await requestJson(request);
    requests.push(body);
    const common = {
      model: "pirx-test-model",
      created_at: new Date().toISOString(),
      done: true,
      done_reason: "stop",
      total_duration: 2_000_000,
      load_duration: 100_000,
      prompt_eval_count: 10,
      prompt_eval_duration: 1_000_000,
      eval_count: 5,
      eval_duration: 1_000_000,
    };

    if (requests.length === 1) {
      sendJson(response, {
        ...common,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "hello",
                arguments: { name: "Piotr" },
              },
            },
          ],
        },
      });
      return;
    }

    sendJson(response, {
      ...common,
      message: {
        role: "assistant",
        content: "Narzędzie odpowiedziało: Hello, Piotr!",
      },
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    ollama.once("error", reject);
    ollama.listen(0, "127.0.0.1", resolveListen);
  });

  const address = ollama.address();
  assert.ok(address !== null && typeof address === "object");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pirx-agent-test-"));
  const promptFile = join(temporaryDirectory, "system.md");
  await writeFile(promptFile, "Jesteś testową asystentką.", "utf8");
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const pirxDirectory = resolve(testDirectory, "..", "..", "..");
  const config: AgentConfig = {
    model: "pirx-test-model",
    numCtx: 8_192,
    keepAlive: "1m",
    baseUrl: `http://127.0.0.1:${address.port}`,
    temperature: 0,
    promptFile,
    logDir: join(temporaryDirectory, "logs"),
    mcpServerEntry: resolve(pirxDirectory, "mcp-server", "dist", "index.js"),
    maxToolIterations: 8,
    maxRepeatedToolCalls: 3,
    llmTimeoutMs: 120_000,
    toolTimeoutMs: 30_000,
  };

  const agent = await PirxAgent.create(config);
  context.after(async () => {
    await agent.close();
    await new Promise<void>((resolveClose, reject) => {
      ollama.close((error) => (error === undefined ? resolveClose() : reject(error)));
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  assert.deepEqual(agent.toolNames, ["hello", "system_info"]);
  const turn = await agent.chat("Przywitaj Piotra.");

  assert.equal(turn.content, "Narzędzie odpowiedziało: Hello, Piotr!");
  assert.equal(turn.metrics.model_calls, 2);
  assert.equal(turn.metrics.tool_calls, 1);
  assert.equal(turn.metrics.input_tokens, 20);
  assert.equal(requests.length, 2);

  const secondMessages = requests[1]?.["messages"];
  assert.ok(Array.isArray(secondMessages));
  assert.deepEqual(secondMessages.at(-1), {
    role: "tool",
    tool_name: "hello",
    content: '{"greeting":"Hello, Piotr!"}',
  });
});

test("po limicie agent finalizuje bez wykonania kolejnej akcji", async (context) => {
  let chatRequests = 0;
  const ollama = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      sendJson(response, { models: [] });
      return;
    }

    if (request.method !== "POST" || request.url !== "/api/chat") {
      response.writeHead(404).end();
      return;
    }

    await requestJson(request);
    chatRequests += 1;
    sendJson(response, {
      model: "pirx-test-model",
      created_at: new Date().toISOString(),
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "hello",
              arguments: { name: `wywołanie-${chatRequests}` },
            },
          },
        ],
      },
      done: true,
      done_reason: "stop",
      total_duration: 1_000_000,
      load_duration: 0,
      prompt_eval_count: 1,
      prompt_eval_duration: 1_000_000,
      eval_count: 1,
      eval_duration: 1_000_000,
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    ollama.once("error", reject);
    ollama.listen(0, "127.0.0.1", resolveListen);
  });

  const address = ollama.address();
  assert.ok(address !== null && typeof address === "object");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pirx-limit-test-"));
  const promptFile = join(temporaryDirectory, "system.md");
  await writeFile(promptFile, "Jesteś testową asystentką.", "utf8");
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const pirxDirectory = resolve(testDirectory, "..", "..", "..");
  const config: AgentConfig = {
    model: "pirx-test-model",
    numCtx: 8_192,
    keepAlive: "1m",
    baseUrl: `http://127.0.0.1:${address.port}`,
    temperature: 0,
    promptFile,
    logDir: join(temporaryDirectory, "logs"),
    mcpServerEntry: resolve(pirxDirectory, "mcp-server", "dist", "index.js"),
    maxToolIterations: 1,
    maxRepeatedToolCalls: 3,
    llmTimeoutMs: 120_000,
    toolTimeoutMs: 30_000,
  };

  const agent = await PirxAgent.create(config);
  context.after(async () => {
    await agent.close();
    await new Promise<void>((resolveClose, reject) => {
      ollama.close((error) => (error === undefined ? resolveClose() : reject(error)));
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  const turn = await agent.chat("Zapętl wywołania.");

  assert.equal(chatRequests, 2);
  assert.equal(turn.metrics.model_calls, 2);
  assert.equal(turn.metrics.tool_calls, 1);
  assert.equal(turn.metrics.done_reason, "tool_iteration_limit");
  assert.match(turn.content, /Ostatnia żądana akcja nie została wykonana/u);
});
