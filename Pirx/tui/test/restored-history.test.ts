import assert from "node:assert/strict";
import test from "node:test";

import type { StoredSessionTranscript } from "@pirx/agent";

import { restoreHistory } from "../src/restored-history.js";

function transcript(overrides: Partial<StoredSessionTranscript> = {}): StoredSessionTranscript {
  return {
    sessionId: "session-1",
    status: "completed",
    storageMode: "full_local",
    omittedTurnCount: 0,
    turns: [],
    ...overrides,
  };
}

test("empty and redacted transcripts are explicit and never invent content", () => {
  assert.deepEqual(restoreHistory(undefined), { items: [] });
  const disabled = restoreHistory(transcript(), "metrics_only");
  assert.deepEqual(disabled.items, []);
  assert.match(disabled.notice ?? "", /nie jest odtwarzana/u);
  const redacted = restoreHistory(transcript({ storageMode: "redacted" }));
  assert.deepEqual(redacted.items, []);
  assert.match(redacted.notice ?? "", /nie zawiera treści/u);
});

test("restored history preserves message and tool-result order once", () => {
  const restored = restoreHistory(transcript({
    turns: [{
      id: "turn-1",
      sequence: 0,
      status: "completed",
      userPrompt: "ignored fallback",
      payload: {},
      messages: [
        { sequence: 0, role: "user", content: "question", payload: {} },
        { sequence: 1, role: "assistant", content: "", payload: { tool_calls: [{}] } },
        { sequence: 2, role: "tool", content: "tool output", toolName: "read", payload: {} },
        { sequence: 3, role: "assistant", content: "answer", payload: {} },
      ],
    }],
  }));

  assert.deepEqual(restored.items, [
    { kind: "user", content: "question" },
    { kind: "tool", name: "read", status: "done", detail: "tool output" },
    { kind: "assistant", content: "answer" },
  ]);
});

test("interrupted turns are visible without replaying an incomplete tool call", () => {
  const restored = restoreHistory(transcript({
    status: "failed",
    omittedTurnCount: 2,
    turns: [{
      id: "turn-2",
      sequence: 1,
      status: "failed",
      userPrompt: "continue",
      payload: { error: "process_restart" },
      messages: [],
    }],
  }));

  assert.deepEqual(restored.items, [
    { kind: "user", content: "continue" },
    { kind: "error", content: "process_restart" },
  ]);
  assert.match(restored.notice ?? "", /2 starszych pominięto/u);
  assert.match(restored.notice ?? "", /Pirx jej nie pamięta/u);
});
