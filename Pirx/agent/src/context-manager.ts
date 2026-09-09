export const CONTEXT_POLICY_VERSION = "context-estimate-v1";
export const DEFAULT_CHARS_PER_TOKEN = 4;

export type ContextSectionName =
  | "instructions"
  | "tool_schemas"
  | "working_memory"
  | "history"
  | "sources"
  | "current_request";

export interface ContextSectionInput {
  readonly name: ContextSectionName;
  readonly text: string;
}

export interface ContextBudget {
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number;
  readonly safetyMarginTokens: number;
}

export interface ContextSectionEstimate {
  readonly name: ContextSectionName;
  readonly characters: number;
  readonly estimatedTokens: number;
}

export interface ContextEstimate {
  readonly policyVersion: string;
  readonly estimator: "characters_divided_by_4_ceiling";
  readonly budget: ContextBudget;
  readonly inputBudgetTokens: number;
  readonly sections: readonly ContextSectionEstimate[];
  readonly totalCharacters: number;
  readonly estimatedInputTokens: number;
  readonly fits: boolean;
  readonly overBudgetTokens: number;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer: ${value}`);
  }
  return value;
}

function validateBudget(budget: ContextBudget): ContextBudget {
  const contextWindowTokens = nonNegativeInteger(
    "contextWindowTokens",
    budget.contextWindowTokens,
  );
  const maxOutputTokens = nonNegativeInteger(
    "maxOutputTokens",
    budget.maxOutputTokens,
  );
  const safetyMarginTokens = nonNegativeInteger(
    "safetyMarginTokens",
    budget.safetyMarginTokens,
  );

  return { contextWindowTokens, maxOutputTokens, safetyMarginTokens };
}

export function estimateTextTokens(text: string): number {
  return Math.ceil(Array.from(text).length / DEFAULT_CHARS_PER_TOKEN);
}

export function estimateContext(
  sections: readonly ContextSectionInput[],
  rawBudget: ContextBudget,
): ContextEstimate {
  const budget = validateBudget(rawBudget);
  const inputBudgetTokens = Math.max(
    0,
    budget.contextWindowTokens -
      budget.maxOutputTokens -
      budget.safetyMarginTokens,
  );
  const sectionEstimates = sections.map((section) => ({
    name: section.name,
    characters: Array.from(section.text).length,
    estimatedTokens: estimateTextTokens(section.text),
  }));
  const totalCharacters = sectionEstimates.reduce(
    (total, section) => total + section.characters,
    0,
  );
  const estimatedInputTokens = sectionEstimates.reduce(
    (total, section) => total + section.estimatedTokens,
    0,
  );
  const overBudgetTokens = Math.max(
    0,
    estimatedInputTokens - inputBudgetTokens,
  );

  return {
    policyVersion: CONTEXT_POLICY_VERSION,
    estimator: "characters_divided_by_4_ceiling",
    budget,
    inputBudgetTokens,
    sections: sectionEstimates,
    totalCharacters,
    estimatedInputTokens,
    fits: overBudgetTokens === 0,
    overBudgetTokens,
  };
}

export function assertContextFits(estimate: ContextEstimate): void {
  if (!estimate.fits) {
    throw new Error(
      `Estimated context exceeds input budget by ${estimate.overBudgetTokens} tokens ` +
        `(policy ${estimate.policyVersion}).`,
    );
  }
}
