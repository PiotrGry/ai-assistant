import assert from "node:assert/strict";
import test from "node:test";

import { calculateTuiLayout } from "../src/layout.js";

test("layout follows terminal size and switches to compact footer", () => {
  const wide = calculateTuiLayout(30, 120);
  const narrow = calculateTuiLayout(12, 70);

  assert.equal(wide.compact, false);
  assert.equal(wide.contentWidth, 118);
  assert.equal(wide.historyItems, 21);
  assert.equal(narrow.compact, true);
  assert.equal(narrow.contentWidth, 68);
  assert.equal(narrow.rows, 12);
  assert.equal(narrow.historyItems, 4);
});

test("layout clamps invalid or tiny terminal dimensions", () => {
  const layout = calculateTuiLayout(0, 0);

  assert.equal(layout.rows, 10);
  assert.equal(layout.columns, 1);
  assert.equal(layout.contentWidth, 1);
  assert.equal(layout.modelItems, 1);
});
