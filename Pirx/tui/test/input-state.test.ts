import assert from "node:assert/strict";
import test from "node:test";

import { applyComposerKey, type ComposerState } from "../src/input-state.js";

const empty: ComposerState = { value: "", cursor: 0 };

test("composer submits on Enter and inserts a newline on Shift+Enter", () => {
  const typed = applyComposerKey(empty, "hello", {});
  const newline = applyComposerKey(typed.state, "[13;2u", {});
  const more = applyComposerKey(newline.state, "world", {});
  const submitted = applyComposerKey(more.state, "", { return: true });
  const lineFeedSubmitted = applyComposerKey(more.state, "\n", {});

  assert.deepEqual(newline.state, { value: "hello\n", cursor: 6 });
  assert.equal(submitted.submitted, "hello\nworld");
  assert.equal(lineFeedSubmitted.submitted, "hello\nworld");
  assert.equal(
    applyComposerKey(more.state, "\r", { return: true, shift: true }).submitted,
    "hello\nworld",
  );
});

test("composer backspace and cursor movement edit in place", () => {
  const typed = applyComposerKey(empty, "abc", {});
  const moved = applyComposerKey(typed.state, "", { left: true });
  const deleted = applyComposerKey(moved.state, "", { backspace: true });
  const terminalBackspace = applyComposerKey(typed.state, "", { delete: true });

  assert.deepEqual(deleted.state, { value: "ac", cursor: 1 });
  assert.deepEqual(terminalBackspace.state, { value: "ab", cursor: 2 });
});

test("composer does not insert control shortcuts into the message", () => {
  const result = applyComposerKey(empty, "m", { ctrl: true });
  assert.deepEqual(result.state, empty);
});
