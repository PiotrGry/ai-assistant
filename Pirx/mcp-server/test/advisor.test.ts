import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { RuntimeSqliteStore, createTask } from "@pirx/orchestrator";
import { askAdvisor, createAdvisorServer, registerConversationLog } from "../src/advisor.js";

test("Claude asks scoped Pirx MCP, receives an answer and chat reads the durable conversation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-advisor-"));
  const filename = join(root, "runtime.sqlite");
  const store = RuntimeSqliteStore.open({ filename });
  const now = new Date().toISOString() as never;
  const task = createTask({ id: "task" as never, goal: "Repair labels", scope: "labels", acceptanceCriteria: ["keep packing information"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: now });
  assert.ok(task.ok);
  assert.equal(store.tasks.create(task.value).outcome, "success");
  assert.equal(store.startAttempt(task.value.id, { id: "attempt" as never, worker: "claude", provider: "claude-code" }, now).outcome, "success");
  let calls = 0;
  const server = createAdvisorServer(store, "task", "attempt", async (prompt) => {
    calls++;
    assert.match(prompt, /Repair labels/);
    assert.doesNotMatch(prompt, /private-secret/);
    return "Keep packing information. token=answer-secret";
  });
  const client = new Client({ name: "worker", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const chat = new McpServer({ name: "chat", version: "1" });
  registerConversationLog(chat, filename);
  const reader = new Client({ name: "reader", version: "1" });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await Promise.all([chat.connect(c), reader.connect(d)]);
  try {
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["ask_pirx"]);
    const input = { requestId: "q1", question: "What to preserve? token=private-secret" };
    const result = await client.callTool({ name: "ask_pirx", arguments: input });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.match(JSON.stringify(result), /Keep packing information/);
    assert.doesNotMatch(JSON.stringify(result), /answer-secret|private-secret/);
    await client.callTool({ name: "ask_pirx", arguments: input });
    assert.equal(calls, 1);
    await assert.rejects(askAdvisor(store, "other-task", "attempt", "x", "test"), /binding/);
    await assert.rejects(askAdvisor(store, "task", "attempt", "q1", "different"), /different/);
    const failed = await askAdvisor(store, "task", "attempt", "q2", "next", async () => { throw Error("Model unavailable"); });
    assert.equal(failed.state, "failed");
    await askAdvisor(store, "task", "attempt", "q3", "last", async () => "Answer");
    await assert.rejects(askAdvisor(store, "task", "attempt", "q4", "too many"), /limit/);
    const history = await reader.callTool({ name: "pirx_agent_conversation", arguments: { taskId: "task" } });
    assert.match(JSON.stringify(history), /Keep packing information/);
    const failedHistory = await reader.callTool({ name: "pirx_agent_conversation", arguments: { taskId: "task", afterRow: 1 } });
    assert.match(JSON.stringify(failedHistory), /Model unavailable/);
    const reopened = RuntimeSqliteStore.open({ filename });
    assert.equal((reopened.database.prepare("SELECT count(*) AS n FROM runtime_agent_questions").get() as { n: number }).n, 3);
    reopened.close();
  } finally { await client.close(); await server.close(); await reader.close(); await chat.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("daemon-launched advisor stdio exposes only ask_pirx and rejects mismatched bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-advisor-stdio-"));
  const client = new Client({ name: "worker", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../../dist/advisor-cli.js", import.meta.url)), join(root, "runtime.sqlite"), "absent-task", "absent-attempt"], stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport).catch((error: unknown) => { throw new Error(`${String(error)}: ${stderr}`); });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["ask_pirx"]);
    const result = await client.callTool({ name: "ask_pirx", arguments: { requestId: "q1", question: "Can I run?" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /binding mismatch/);
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
