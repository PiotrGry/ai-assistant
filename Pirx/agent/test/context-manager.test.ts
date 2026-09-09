import assert from "node:assert/strict";
import test from "node:test";

import {
  assertContextFits,
  CONTEXT_POLICY_VERSION,
  estimateContext,
  estimateTextTokens,
  selectMessagesForContext,
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

test("context selection keeps system and current request messages", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "old request with enough text to omit" },
    { role: "assistant", content: "old answer with enough text to omit" },
    { role: "user", content: "current" },
  ] as const;
  const budget = {
    contextWindowTokens: 5,
    maxOutputTokens: 0,
    safetyMarginTokens: 0,
  };

  const build = selectMessagesForContext(messages, (selected) =>
    estimateContext(
      [{ name: "history", text: selected.map((message) => message.content).join("") }],
      budget,
    ),
  );

  assert.deepEqual(
    build.messages.map((message) => message.content),
    ["system", "current"],
  );
  assert.equal(build.omittedMessageCount, 2);
  assert.equal(build.estimate.fits, true);
});

test("context selection never separates an assistant tool call from its results", () => {
  const messages = [
    { role: "system", content: "system" },
    { role: "user", content: "old request" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "example", arguments: {} } }],
    },
    { role: "tool", content: "tool result" },
    { role: "user", content: "current" },
  ] as const;
  const budget = {
    contextWindowTokens: 10,
    maxOutputTokens: 0,
    safetyMarginTokens: 0,
  };

  const build = selectMessagesForContext(messages, (selected) =>
    estimateContext(
      [{ name: "history", text: selected.map((message) => message.content).join("") }],
      budget,
    ),
  );

  assert.deepEqual(
    build.messages.map((message) => message.role),
    ["system", "user", "assistant", "tool", "user"],
  );
  assert.equal(build.omittedMessageCount, 0);
});

test("context selection fails when protected messages exceed the budget", () => {
  const messages = [
    { role: "system", content: "system instructions" },
    { role: "user", content: "the current request is too large" },
  ] as const;

  assert.throws(
    () =>
      selectMessagesForContext(messages, (selected) =>
        estimateContext(
          [{ name: "history", text: JSON.stringify(selected) }],
          {
            contextWindowTokens: 1,
            maxOutputTokens: 0,
            safetyMarginTokens: 0,
          },
        ),
      ),
    /exceeds input budget/u,
  );
});

test("context selection stays bounded across a long synthetic session", () => {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: "system" },
  ];
  for (let index = 0; index < 60; index += 1) {
    messages.push(
      { role: "user", content: `request-${index}-${"x".repeat(40)}` },
      { role: "assistant", content: `answer-${index}-${"y".repeat(40)}` },
    );
  }
  messages.push({ role: "user", content: "current request" });

  const build = selectMessagesForContext(messages, (selected) =>
    estimateContext(
      [{ name: "history", text: selected.map((message) => message.content).join("") }],
      {
        contextWindowTokens: 128,
        maxOutputTokens: 0,
        safetyMarginTokens: 0,
      },
    ),
  );

  assert.equal(build.messages[0]?.role, "system");
  assert.equal(build.messages.at(-1)?.content, "current request");
  assert.ok(build.omittedMessageCount > 0);
  assert.ok(build.messages.length < messages.length);
  assert.equal(build.estimate.fits, true);
});
