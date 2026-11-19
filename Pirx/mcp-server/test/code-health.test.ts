import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { registerCodeHealthTool } from "../src/tools/code-health.js";

async function call(reportPath: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerCodeHealthTool(server, reportPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "zdrovena_code_health", arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
  } finally { await client.close(); await server.close(); }
}

test("returns the snapshot with the least-covered files first, limited on request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pirx-code-health-"));
  try {
    const path = join(dir, "zdrovena.json");
    await writeFile(path, JSON.stringify({ generatedAt: "2026-11-19T07:00:00+00:00", commit: "a".repeat(40), totalCoverage: 86.4, weakestFiles: [{ file: "a.py", percent: 0 }, { file: "b.py", percent: 53.3 }, { file: "c.py", percent: 57.6 }], markers: [] }));
    const full = await call(path);
    assert.equal(full.outcome, "success");
    assert.equal(full.totalCoverage, 86.4);
    assert.equal((full.weakestFiles as unknown[]).length, 3);
    const limited = await call(path, { limit: 1 });
    assert.deepEqual(limited.weakestFiles, [{ file: "a.py", percent: 0 }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a missing snapshot is reported as unavailable, not as a clean repository", async () => {
  const result = await call("/nonexistent/pirx/health/zdrovena.json");
  assert.equal(result.outcome, "unavailable");
  assert.match(String(result.message), /code-health\.sh/u);
});
