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

test("keeps list items and shortens long text fields when a structured result is too large", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    number: 180 + index,
    title: `Zadanie ${index}`,
    body: "x".repeat(2_400),
  }));
  const text = toolResultToText(
    { structuredContent: { outcome: "success", page: { items, complete: true } } },
    12_000,
  );

  assert.ok(text.length <= 12_000);
  const parsed = JSON.parse(text) as {
    truncated?: unknown;
    outcome?: unknown;
    page?: { items?: Array<{ number: number; title: string; body: string }> };
  };
  const kept = parsed.page?.items ?? [];
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.outcome, "success");
  assert.deepEqual(kept.map((item) => item.number), [180, 181, 182, 183, 184]);
  assert.equal(kept[4]?.title, "Zadanie 4");
  assert.ok(kept.every((item) => item.body.length < 2_400 && item.body.includes("skrócono")));
});

test("drops trailing list items with a count when shortening text is not enough", () => {
  const items = Array.from({ length: 200 }, (_, index) => ({ number: index + 1, title: `Zadanie ${index + 1}` }));
  const text = toolResultToText({ structuredContent: { page: { items, complete: false } } }, 2_000);

  assert.ok(text.length <= 2_000);
  const parsed = JSON.parse(text) as { page?: { items?: Array<{ number: number }>; items_omitted?: number } };
  const kept = parsed.page?.items ?? [];
  assert.ok(kept.length > 0);
  assert.deepEqual(kept.map((item) => item.number), Array.from({ length: kept.length }, (_, index) => index + 1));
  assert.equal(parsed.page?.items_omitted, 200 - kept.length);
});

test("rejects an unsafe result budget", () => {
  assert.throws(
    () => toolResultToText({ content: [] }, 255),
    /maxCharacters must be an integer/u,
  );
});
