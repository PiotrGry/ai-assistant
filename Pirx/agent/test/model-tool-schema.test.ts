import assert from "node:assert/strict";
import test from "node:test";
import { modelToolSchema } from "../src/model-tool-schema.js";

test("model projection omits unsupported regexes without deleting properties or literal data", () => {
  const source = { type: "object", properties: { pattern: { type: "string", pattern: "^(?!bad)" }, value: { type: "object", const: { pattern: "literal data" } } }, required: ["pattern"] };
  const projected = modelToolSchema(source);
  assert.deepEqual(projected, { type: "object", properties: { pattern: { type: "string" }, value: { type: "object", const: { pattern: "literal data" } } }, required: ["pattern"] });
  assert.equal(source.properties.pattern.pattern, "^(?!bad)");
});
