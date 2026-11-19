import assert from "node:assert/strict";
import test from "node:test";

import { AzureCliProductionErrorsPort, parseGroups, productionErrorsQuery } from "../src/tools/production-errors.js";

const table = JSON.stringify({ tables: [{ columns: ["source", "role", "message", "count", "firstSeen", "lastSeen", "operation"].map((name) => ({ name })), rows: [["exception", "zdrovena-api", "KeyError: 'tracking'", 3, "2026-11-18T10:00:00Z", "2026-11-18T11:00:00Z", "POST /api/webhooks/shopify"]] }] });

test("the query is fixed and only the window changes", () => {
  const query = productionErrorsQuery(24);
  assert.match(query, /ago\(24h\)/u);
  for (const source of ["exceptions", "severityLevel >= 3", "success == false"]) assert.ok(query.includes(source), source);
});

test("rows become error groups with counts and first/last seen", () => {
  assert.deepEqual(parseGroups(table), [{ kind: "exception", role: "zdrovena-api", message: "KeyError: 'tracking'", count: 3, firstSeen: "2026-11-18T10:00:00Z", lastSeen: "2026-11-18T11:00:00Z", operation: "POST /api/webhooks/shopify" }]);
});

test("the port runs az without a shell, refuses bad windows and says when it is not configured", async () => {
  let call: { file: string; args: readonly string[]; shell: unknown } | undefined;
  const execute = (async (file: string, args: readonly string[], options: { shell?: unknown }) => { call = { file, args, shell: options.shell }; return { stdout: table, stderr: "" }; }) as never;
  const port = new AzureCliProductionErrorsPort({ app: "zdrovena-ai", resourceGroup: "zdrovena-rg", environment: { PATH: "/usr/bin" }, execute });
  const result = await port.read(6);
  assert.equal(result.outcome, "success");
  assert.equal(call?.file, "az"); assert.equal(call?.shell, false);
  assert.ok(call?.args.includes("zdrovena-ai") && call.args.includes("zdrovena-rg"));
  assert.equal((await port.read(0)).outcome, "invalid_request");
  assert.equal((await port.read(169)).outcome, "invalid_request");
  assert.equal((await new AzureCliProductionErrorsPort({}).read(24)).outcome, "unconfigured");
  const failing = new AzureCliProductionErrorsPort({ app: "a", resourceGroup: "b", execute: (async () => { throw new Error("Command failed: az monitor app-insights query --analytics-query \"... error_trace ...\"\nERROR: Please run 'az login'"); }) as never });
  const failed = await failing.read(24);
  assert.equal(failed.outcome, "unavailable");
  assert.match(failed.outcome === "unavailable" ? failed.message : "", /az login/u);
});
