import assert from "node:assert/strict";
import test from "node:test";

import { buildHistoryLines, type ChatItem } from "../src/history.js";

test("history keeps question and answer lines independently scrollable", () => {
  const items: ChatItem[] = [
    { kind: "user", content: "What is the plan?" },
    { kind: "assistant", content: "First line\nSecond line" },
  ];

  assert.deepEqual(
    buildHistoryLines(items, 80).map((line) => line.text),
    [
      "You:",
      "  What is the plan?",
      "",
      "Pirx:",
      "  First line",
      "  Second line",
      "",
    ],
  );
});

test("history wraps long answers to the chat viewport width", () => {
  const lines = buildHistoryLines(
    [{ kind: "assistant", content: "1234567890" }],
    7,
  );

  assert.deepEqual(lines.map((line) => line.text), [
    "Pirx:",
    "  12345",
    "  67890",
    "",
  ]);
});
