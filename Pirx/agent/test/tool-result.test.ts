import assert from "node:assert/strict";
import test from "node:test";

import { toolResultToText } from "../src/tool-result.js";

test("preferuje structuredContent", () => {
  assert.equal(
    toolResultToText({
      content: [{ type: "text", text: "tekst" }],
      structuredContent: { available: true },
    }),
    '{"available":true}',
  );
});

test("łączy tekstową zawartość i oznacza błąd", () => {
  assert.equal(
    toolResultToText({
      content: [
        { type: "text", text: "pierwsza linia" },
        { type: "image" },
        { type: "text", text: "druga linia" },
      ],
      isError: true,
    }),
    "Błąd narzędzia: pierwsza linia\ndruga linia",
  );
});

test("reduces oversized structured results without producing invalid JSON", () => {
  const text = toolResultToText(
    {
      structuredContent: {
        id: "event-123",
        status: "ok",
        items: Array.from({ length: 100 }, (_, index) => ({ index, value: "x".repeat(20) })),
      },
    },
    256,
  );

  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.id, "event-123");
  assert.ok(text.length > 0);
});

test("reduces oversized plain text at line boundaries and marks omission", () => {
  const text = toolResultToText(
    { content: [{ type: "text", text: `${"line\n".repeat(100)}tail` }] },
    256,
  );

  assert.match(text, /wynik skrócony/u);
  assert.ok(text.length <= 256);
});

test("rejects an unsafe result budget", () => {
  assert.throws(
    () => toolResultToText({ content: [] }, 255),
    /maxCharacters must be an integer/u,
  );
});
