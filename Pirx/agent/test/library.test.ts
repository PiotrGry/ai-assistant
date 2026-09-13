import assert from "node:assert/strict";
import test from "node:test";

import { SessionLogger } from "../src/library.js";
import type { SessionTurn } from "../src/library.js";

test("library exposes the session logger for other Pirx front ends", () => {
  assert.equal(typeof SessionLogger.create, "function");
  const turn: SessionTurn = { id: "turn", turnId: "turn", sequence: 0 };
  assert.equal(turn.sequence, 0);
});
