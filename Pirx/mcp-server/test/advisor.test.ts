import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { RuntimeSqliteStore, createTask } from "@pirx/orchestrator";
import { askAdvisor, createAdvisorServer, registerConversationLog } from "../src/advisor.js";

function textResult(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const block = result.content.find((item) => item.type === "text");
  assert.ok(block?.type === "text");
  return JSON.parse(block.text) as Record<string, unknown>;
}

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
    const history = textResult(await reader.callTool({ name: "pirx_agent_conversation", arguments: { taskId: "task" } }));
    assert.equal(history.complete, false);
    assert.match(JSON.stringify(history.items), /Keep packing information/);
    const firstCursor = history.nextAfterRow as number;
    assert.ok(Number.isSafeInteger(firstCursor) && firstCursor > 0);
    const failedHistory = textResult(await reader.callTool({ name: "pirx_agent_conversation", arguments: { taskId: "task", afterRow: firstCursor } }));
    assert.match(JSON.stringify(failedHistory.items), /Model unavailable/);
    assert.notEqual(failedHistory.nextAfterRow, firstCursor);
    const reopened = RuntimeSqliteStore.open({ filename });
    assert.equal((reopened.database.prepare("SELECT count(*) AS n FROM runtime_agent_questions").get() as { n: number }).n, 3);
    reopened.close();
  } finally { await client.close(); await server.close(); await reader.close(); await chat.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("pending Advisor replay distinguishes a live owner and idempotently recovers an orphan without a second model call", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-advisor-recovery-"));
  const store = RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") });
  const now = new Date().toISOString() as never;
  const task = createTask({ id: "recovery-task" as never, goal: "Recover advice", scope: "advisor", acceptanceCriteria: ["no duplicate model call"], priority: 1, risk: "low", requiredCapabilities: ["repository.read"], createdAt: now });
  assert.ok(task.ok);
  assert.equal(store.tasks.create(task.value).outcome, "success");
  assert.equal(store.startAttempt(task.value.id, { id: "recovery-attempt" as never, worker: "claude", provider: "claude-code" }, now).outcome, "success");
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  let calls = 0;
  let inFlight: ReturnType<typeof askAdvisor> | undefined;
  let client: Client | undefined;
  let server: McpServer | undefined;
  try {
    inFlight = askAdvisor(store, "recovery-task", "recovery-attempt", "live", "Still running?", async () => { calls += 1; await gate; return "live answer"; });
    while (store.database.prepare("SELECT id FROM runtime_agent_questions WHERE id = ?").get("recovery-attempt:live") === undefined) await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    const liveReplay = await askAdvisor(store, "recovery-task", "recovery-attempt", "live", "Still running?", async () => { calls += 1; return "must not run"; });
    assert.equal(liveReplay.state, "pending");
    assert.equal(liveReplay.pending_status, "active");
    assert.equal(calls, 1);
    release?.();
    assert.equal((await inFlight).state, "answered");

    store.database.prepare("INSERT INTO runtime_agent_questions (id, task_id, attempt_id, question, state, created_at, owner_host, owner_pid) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)")
      .run("recovery-attempt:orphan", "recovery-task", "recovery-attempt", "Interrupted?", now, hostname(), 2_147_483_647);
    server = createAdvisorServer(store, "recovery-task", "recovery-attempt", async () => { calls += 1; return "must not run"; });
    client = new Client({ name: "recovery-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const recoveredResult = await client.callTool({ name: "ask_pirx", arguments: { requestId: "orphan", question: "Interrupted?" } });
    assert.equal(recoveredResult.isError, true);
    const orphan = textResult(recoveredResult);
    assert.equal(orphan.state, "failed");
    assert.equal(orphan.failure_code, "process_interrupted");
    assert.doesNotMatch(JSON.stringify(orphan), /owner_host|owner_pid/u);
    assert.equal(calls, 1);
    const replay = textResult(await client.callTool({ name: "ask_pirx", arguments: { requestId: "orphan", question: "Interrupted?" } }));
    assert.deepEqual(replay, orphan);
    assert.equal(calls, 1);
  } finally {
    release?.();
    await inFlight?.catch(() => undefined);
    await client?.close();
    await server?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon-launched advisor stdio exposes only ask_pirx and rejects mismatched bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-advisor-stdio-"));
  RuntimeSqliteStore.open({ filename: join(root, "runtime.sqlite") }).close();
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

test("Advisor history reports a missing runtime database without creating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pirx-advisor-missing-"));
  const filename = join(root, "runtime.sqlite");
  const server = new McpServer({ name: "advisor-history", version: "1" });
  registerConversationLog(server, filename);
  const client = new Client({ name: "reader", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "pirx_agent_conversation", arguments: { taskId: "missing" } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /database does not exist/u);
    await assert.rejects(access(filename), { code: "ENOENT" });
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
