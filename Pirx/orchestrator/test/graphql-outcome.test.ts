import assert from "node:assert/strict";
import test from "node:test";
import { GitHubTransport } from "../src/github/transport.js";

test("partial GraphQL mutation is uncertain while a read remains non-mutating", async () => {
  let calls = 0;
  const transport = new GitHubTransport({ token: "fixture", owner: "test", repository: "test", apiUrl: "https://github.test", timeoutMs: 1_000 }, {
    fetch: async () => { calls++; return new Response(JSON.stringify({ data: { first: { id: "created" }, second: null }, errors: [{ message: "second operation failed" }] }), { status: 200 }); },
  });
  const write = await transport.graphqlWrite({ query: "mutation { first: createThing { id } second: createThing { id } }" }, { correlationId: "partial-mutation" });
  assert.equal(write.remoteOutcome, "unknown");
  assert.equal(write.outcome, "permanent_error");
  assert.equal(calls, 1);
  const read = await transport.graphqlRead({ query: "query { viewer { login } }" }, { correlationId: "read" });
  assert.equal(read.remoteOutcome, "not_accepted");
});
