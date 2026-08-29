import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createMcpServer } from "../src/server.js";

test("serwer udostępnia hello i system_info", async (context) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "pirx-test", version: "0.1.0" });

  context.after(async () => {
    await client.close();
    await server.close();
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    ["hello", "system_info"],
  );

  const hello = await client.callTool({
    name: "hello",
    arguments: { name: "Piotr" },
  });

  assert.notEqual(hello.isError, true);
  assert.deepEqual(hello.structuredContent, { greeting: "Hello, Piotr!" });

  const systemInfo = await client.callTool({
    name: "system_info",
    arguments: {},
  });

  assert.notEqual(systemInfo.isError, true);
  assert.ok(
    typeof systemInfo.structuredContent === "object" &&
      systemInfo.structuredContent !== null,
  );
  const structuredContent = systemInfo.structuredContent as Record<string, unknown>;
  assert.equal(typeof structuredContent["hostname"], "string");
  assert.match(String(structuredContent["node"]), /^v\d+/u);
});
