import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PirxAgent } from "../src/agent.js";
import type { AgentConfig } from "../src/config.js";
import type {
  ContextBuildInput,
  OperationFinishInput,
  OperationHandle,
  OperationRecorder,
  OperationStartInput,
} from "../src/operation-recorder.js";

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
      eval_count: undefined,
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
    timeZone: "Europe/Warsaw",
    promptFile,
    logDir: join(temporaryDirectory, "logs"),
    mcpServerEntry: resolve(pirxDirectory, "mcp-server", "dist", "index.js"),
    maxToolIterations: 8,
    maxRepeatedToolCalls: 3,
    llmTimeoutMs: 120_000,
    toolTimeoutMs: 30_000,
  };

  const clockValues = [
    "2026-08-30T21:58:00.000Z",
    "2026-08-30T21:59:00.000Z",
    "2026-08-30T22:01:00.000Z",
  ];
  let clockIndex = 0;
  const agent = await PirxAgent.create(config, {}, {
    now: () => new Date(clockValues[clockIndex++] ?? "2026-08-30T22:01:00.000Z"),
  });
  const operationEvents: Array<
    | { readonly type: "start"; readonly input: OperationStartInput; readonly id: string }
    | { readonly type: "finish"; readonly handle: OperationHandle; readonly input: OperationFinishInput }
  > = [];
  const contextBuilds: Array<{
    readonly handle: OperationHandle;
    readonly input: ContextBuildInput;
  }> = [];
  const operationRecorder: OperationRecorder = {
    start: (input) => {
      const id = `operation-${operationEvents.length}`;
      operationEvents.push({ type: "start", input, id });
      return { id };
    },
    finish: (handle, input) => {
      operationEvents.push({ type: "finish", handle, input });
    },
    recordContextBuild: (handle, input) => {
      contextBuilds.push({ handle, input });
    },
  };
  context.after(async () => {
    await agent.close();
    await new Promise<void>((resolveClose, reject) => {
      ollama.close((error) => (error === undefined ? resolveClose() : reject(error)));
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  assert.ok(agent.toolNames.includes("hello"));
  assert.ok(agent.toolNames.includes("system_info"));
  assert.ok(agent.toolNames.includes("obsidian_read"));
  assert.ok(agent.toolNames.includes("calendar_list_events"));
  const turn = await agent.chat("Przywitaj Piotra.", {
    sessionId: "session-test",
    turnId: "turn-test",
    operationRecorder,
  });

  assert.equal(turn.content, "Narzędzie odpowiedziało: Hello, Piotr!");
  assert.equal(turn.metrics.model_calls, 2);
  assert.equal(turn.metrics.tool_calls, 1);
  assert.equal(turn.metrics.input_tokens, 20);
  assert.equal(turn.metrics.output_tokens, null);
  assert.equal(turn.metrics.generation_tokens_per_second, null);
  assert.equal(turn.metrics.time_zone, "Europe/Warsaw");
  assert.ok(turn.metrics.turn_duration_ms >= 0);
  assert.equal(requests.length, 2);
  assert.equal(contextBuilds.length, 2);
  assert.equal(contextBuilds[0]?.input.policyVersion, "context-estimate-v1");
  assert.equal(contextBuilds[1]?.input.omitted["message_count"], 0);
  assert.deepEqual(
    operationEvents.map((event) =>
      event.type === "start"
        ? `start:${event.input.kind}:${event.input.sequence}`
        : `finish:${event.input.status}`,
    ),
    [
      "start:llm:0",
      "finish:succeeded",
      "start:mcp:1",
      "finish:succeeded",
      "start:llm:2",
      "finish:succeeded",
    ],
  );
  const firstLlmFinish = operationEvents.find(
    (event): event is Extract<typeof operationEvents[number], { readonly type: "finish" }> =>
      event.type === "finish" && event.handle.id === "operation-0",
  );
  assert.ok(firstLlmFinish !== undefined);
  assert.equal(firstLlmFinish.input.payload["prompt_eval_cached_count"], null);

  const firstMessages = requests[0]?.["messages"];
  assert.ok(Array.isArray(firstMessages));
  assert.match(String(firstMessages[0]?.content), /2026-08-30T23:59:00\+02:00/u);

  const secondMessages = requests[1]?.["messages"];
  assert.ok(Array.isArray(secondMessages));
  assert.match(String(secondMessages[0]?.content), /2026-08-31T00:01:00\+02:00/u);
  assert.equal(
    secondMessages.filter((message) => message.role === "system").length,
    1,
  );
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
    timeZone: "Europe/Warsaw",
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

test("agent blocks repeated identical tool calls without removing loop guards", async (context) => {
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

    requests.push(await requestJson(request));
    const common = {
      model: "pirx-test-model",
      created_at: new Date().toISOString(),
      done: true,
      done_reason: "stop",
      total_duration: 1_000_000,
      load_duration: 0,
      prompt_eval_count: 1,
      prompt_eval_duration: 1_000_000,
      eval_count: 1,
      eval_duration: 1_000_000,
    };
    if (requests.length <= 2) {
      sendJson(response, {
        ...common,
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "hello",
                arguments: { name: "same-call" },
              },
            },
          ],
        },
      });
      return;
    }
    sendJson(response, {
      ...common,
      message: { role: "assistant", content: "Stopped the repeated call." },
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    ollama.once("error", reject);
    ollama.listen(0, "127.0.0.1", resolveListen);
  });
  const address = ollama.address();
  assert.ok(address !== null && typeof address === "object");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pirx-repeat-test-"));
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
    timeZone: "Europe/Warsaw",
    promptFile,
    logDir: join(temporaryDirectory, "logs"),
    mcpServerEntry: resolve(pirxDirectory, "mcp-server", "dist", "index.js"),
    maxToolIterations: 4,
    maxRepeatedToolCalls: 1,
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

  const turn = await agent.chat("Repeat the same tool call.");
  assert.equal(turn.content, "Stopped the repeated call.");
  assert.equal(turn.metrics.model_calls, 3);
  assert.equal(turn.metrics.tool_calls, 1);

  const thirdMessages = requests[2]?.["messages"];
  assert.ok(Array.isArray(thirdMessages));
  assert.match(
    String(thirdMessages.at(-1)?.content),
    /wykrycia pętli powtarzających się wywołań/u,
  );
});

test("LLM timeout aborts a stalled Ollama request and rolls back the turn", async (context) => {
  const ollama = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/tags") {
      sendJson(response, { models: [] });
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/chat") {
      response.writeHead(404).end();
    }
    // Intentionally leave /api/chat open. The agent must abort it.
  });
  await new Promise<void>((resolveListen, reject) => {
    ollama.once("error", reject);
    ollama.listen(0, "127.0.0.1", resolveListen);
  });
  const address = ollama.address();
  assert.ok(address !== null && typeof address === "object");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pirx-llm-timeout-test-"));
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
    timeZone: "Europe/Warsaw",
    promptFile,
    logDir: join(temporaryDirectory, "logs"),
    mcpServerEntry: resolve(pirxDirectory, "mcp-server", "dist", "index.js"),
    maxToolIterations: 4,
    maxRepeatedToolCalls: 2,
    llmTimeoutMs: 20,
    toolTimeoutMs: 30_000,
  };

  const agent = await PirxAgent.create(config);
  context.after(async () => {
    await agent.close();
    ollama.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => {
      ollama.close((error) => (error === undefined ? resolveClose() : reject(error)));
    });
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await assert.rejects(() => agent.chat("This request should time out."), /timeout|aborted/iu);
});
