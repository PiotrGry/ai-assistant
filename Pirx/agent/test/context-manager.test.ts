import assert from "node:assert/strict";
import test from "node:test";

import {
  assertContextFits,
  CONTEXT_POLICY_VERSION,
  estimateContext,
  estimateTextTokens,
} from "../src/context-manager.js";

test("context estimate reports section sizes and reserves output plus margin", () => {
  const estimate = estimateContext(
    [
      { name: "instructions", text: "abcd" },
      { name: "tool_schemas", text: "ééé" },
      { name: "current_request", text: "abcdefgh" },
    ],
    {
      contextWindowTokens: 16,
      maxOutputTokens: 4,
      safetyMarginTokens: 2,
    },
  );

  assert.equal(estimate.policyVersion, CONTEXT_POLICY_VERSION);
  assert.equal(estimate.estimator, "characters_divided_by_4_ceiling");
  assert.equal(estimate.inputBudgetTokens, 10);
  assert.equal(estimate.totalCharacters, 15);
  assert.equal(estimate.estimatedInputTokens, 4);
  assert.equal(estimate.fits, true);
  assert.deepEqual(estimate.sections, [
    { name: "instructions", characters: 4, estimatedTokens: 1 },
    { name: "tool_schemas", characters: 3, estimatedTokens: 1 },
    { name: "current_request", characters: 8, estimatedTokens: 2 },
  ]);
});

test("context estimate never hides an over-budget prompt", () => {
  const estimate = estimateContext(
    [{ name: "history", text: "123456789" }],
    {
      contextWindowTokens: 8,
      maxOutputTokens: 2,
      safetyMarginTokens: 1,
    },
  );

  assert.equal(estimate.estimatedInputTokens, 3);
  assert.equal(estimate.inputBudgetTokens, 5);
  assert.equal(estimate.fits, true);

  const overBudget = estimateContext(
    [{ name: "history", text: "123456789012345678901" }],
    {
      contextWindowTokens: 8,
      maxOutputTokens: 2,
      safetyMarginTokens: 1,
    },
  );
  assert.equal(overBudget.estimatedInputTokens, 6);
  assert.equal(overBudget.overBudgetTokens, 1);
  assert.equal(overBudget.fits, false);
  assert.throws(() => assertContextFits(overBudget), /exceeds input budget by 1/u);
});

test("text estimator validates budgets and counts Unicode code points", () => {
  assert.equal(estimateTextTokens("😀😀😀😀"), 1);
  assert.throws(
    () =>
      estimateContext([], {
        contextWindowTokens: -1,
        maxOutputTokens: 1,
        safetyMarginTokens: 1,
      }),
    /contextWindowTokens must be a non-negative safe integer/u,
  );
});
