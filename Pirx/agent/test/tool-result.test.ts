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
