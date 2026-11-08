import assert from "node:assert/strict";
import test from "node:test";

import { GitHubTransport } from "../src/github/transport.js";

const config = {
  token: "fixture",
  owner: "test",
  repository: "test",
  apiUrl: "https://github.test",
  timeoutMs: 1_000,
} as const;

function transport(body: unknown): GitHubTransport {
  return new GitHubTransport(config, {
    fetch: async () => new Response(JSON.stringify(body), { status: 200 }),
  });
}

test("GraphQL mutation data plus errors is an uncertain write", async () => {
  const result = await transport({
    data: { first: { id: "created" }, second: null },
    errors: [{ message: "second operation failed", path: ["second"] }],
  }).graphqlWrite(
    { query: "mutation { first: createThing { id } second: createThing { id } }" },
    { correlationId: "partial-mutation" },
  );

  assert.equal(result.outcome, "unknown");
  assert.equal(result.remoteOutcome, "unknown");
});

test("GraphQL mutation errors without data remain uncertain unless pre-execution rejection is proven", async () => {
  const ambiguous = await transport({
    errors: [{ message: "resolver failed", extensions: { code: "INTERNAL" } }],
  }).graphqlWrite(
    { query: "mutation { createThing { id } }" },
    { correlationId: "ambiguous-mutation" },
  );
  assert.equal(ambiguous.outcome, "unknown");
  assert.equal(ambiguous.remoteOutcome, "unknown");

  const validation = await transport({
    errors: [{ message: "unknown field", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
  }).graphqlWrite(
    { query: "mutation { unknownField }" },
    { correlationId: "invalid-mutation" },
  );
  assert.equal(validation.outcome, "permanent_error");
  assert.equal(validation.remoteOutcome, "not_accepted");
});

test("GraphQL reads never report a remote mutation effect", async () => {
  const result = await transport({
    errors: [{ message: "read failed", path: ["viewer"] }],
  }).graphqlRead(
    { query: "query { viewer { login } }" },
    { correlationId: "read" },
  );

  assert.equal(result.outcome, "permanent_error");
  assert.equal(result.remoteOutcome, "not_accepted");
});

test("malformed successful GraphQL mutation responses remain uncertain", async () => {
  const result = await transport({ unexpected: true }).graphqlWrite(
    { query: "mutation { createThing { id } }" },
    { correlationId: "malformed-mutation" },
  );

  assert.equal(result.outcome, "unknown");
  assert.equal(result.remoteOutcome, "unknown");
});
