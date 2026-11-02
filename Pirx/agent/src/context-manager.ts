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
  readonly estimator: "characters_divided_by_4_ceiling" | "calibrated_characters";
  readonly calibrationFactor?: number;
  readonly budget: ContextBudget;
  readonly inputBudgetTokens: number;
  readonly sections: readonly ContextSectionEstimate[];
  readonly totalCharacters: number;
  readonly estimatedInputTokens: number;
  readonly fits: boolean;
  readonly overBudgetTokens: number;
}

export interface ContextBuild<T> {
  readonly messages: readonly T[];
  readonly estimate: ContextEstimate;
  readonly omittedMessageCount: number;
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

/** Conservative per-model correction; observations can increase, never silently reduce, the reserve. */
export class ModelContextEstimator {
  readonly #factors = new Map<string, number>();
  public estimate(model: string, sections: readonly ContextSectionInput[], budget: ContextBudget): ContextEstimate {
    const base = estimateContext(sections, budget);
    const factor = this.#factors.get(model) ?? 1.5;
    const estimates = base.sections.map((section) => ({ ...section, estimatedTokens: Math.ceil(section.estimatedTokens * factor) }));
    const total = estimates.reduce((sum, section) => sum + section.estimatedTokens, 0);
    return { ...base, policyVersion: "context-calibrated-v2", estimator: "calibrated_characters", calibrationFactor: factor, sections: estimates, estimatedInputTokens: total, fits: total <= base.inputBudgetTokens, overBudgetTokens: Math.max(0, total - base.inputBudgetTokens) };
  }
  public observe(model: string, sections: readonly ContextSectionInput[], actualTokens: number | undefined): void {
    if (actualTokens === undefined || !Number.isFinite(actualTokens) || actualTokens <= 0) return;
    const base = sections.reduce((sum, section) => sum + estimateTextTokens(section.text), 0);
    if (base <= 0) return;
    this.#factors.set(model, Math.max(this.#factors.get(model) ?? 1.5, actualTokens / base * 1.15));
  }
}

function contentOf(message: unknown): string {
  return typeof message === "object" && message !== null && "content" in message && typeof message.content === "string" ? message.content : "";
}
function isConfirmation(message: unknown): boolean {
  return /^(?:tak|yes|ok(?:ay)?|zgoda|zrob to|zrób to|dalej|kontynuuj|continue|do it|teraz)[.!\s]*$/iu.test(contentOf(message).trim());
}

function hasToolCalls(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { readonly tool_calls?: unknown }).tool_calls)
  );
}

function messageGroups<T extends { readonly role: string }>(
  messages: readonly T[],
): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message === undefined) {
      continue;
    }
    const group = [message];
    if (message.role === "assistant" && hasToolCalls(message)) {
      while (messages[index + 1]?.role === "tool") {
        index += 1;
        const toolMessage = messages[index];
        if (toolMessage !== undefined) {
          group.push(toolMessage);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

export function selectMessagesForContext<T extends { readonly role: string }>(
  messages: readonly T[],
  estimate: (messages: readonly T[]) => ContextEstimate,
): ContextBuild<T> {
  const systemMessages = messages.filter((message) => message.role === "system");
  const currentRequestIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const currentRequest =
    currentRequestIndex < 0 || messages[currentRequestIndex] === undefined
      ? []
      : [messages[currentRequestIndex]];
  const history = messages.filter(
    (message, index) =>
      message.role !== "system" && index !== currentRequestIndex,
  );
  const groups = messageGroups(history);
  const anchors: T[] = [];
  if (currentRequest.length > 0 && isConfirmation(currentRequest[0])) {
    const intentIndex = messages.findLastIndex((message, index) => index < currentRequestIndex && message.role === "user" && !isConfirmation(message));
    if (intentIndex < 0) throw new Error("Brakuje kontekstu potwierdzenia. Podaj numer Issue i działanie, którego dotyczy zgoda.");
    anchors.push(messages[intentIndex]!);
    const proposal = messages.findLastIndex((message, index) => index > intentIndex && index < currentRequestIndex && message.role === "assistant");
    if (proposal >= 0) {
      anchors.push(messages[proposal]!);
      if (hasToolCalls(messages[proposal])) for (let index = proposal + 1; index < currentRequestIndex && messages[index]?.role === "tool"; index++) anchors.push(messages[index]!);
    }
  }
  const protectedMessages = [...systemMessages, ...anchors, ...currentRequest];
  const protectedEstimate = estimate(protectedMessages);
  assertContextFits(protectedEstimate);

  let selectedHistory: T[][] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidateGroups = groups.slice(index);
    const candidate = [...new Set([
      ...systemMessages,
      ...anchors,
      ...candidateGroups.flat(),
      ...currentRequest,
    ])];
    const candidateEstimate = estimate(candidate);
    if (candidateEstimate.fits) {
      selectedHistory = candidateGroups;
      continue;
    }
    break;
  }

  const selectedMessages = [
    ...selectedHistory.flat(),
    ...currentRequest,
  ];
  const selectedMessageSet = new Set<T>([
    ...systemMessages,
    ...anchors,
    ...selectedMessages,
  ]);
  const finalMessages = messages.filter((message) =>
    selectedMessageSet.has(message),
  );
  return {
    messages: finalMessages,
    estimate: estimate(finalMessages),
    omittedMessageCount: messages.length - finalMessages.length,
  };
}
