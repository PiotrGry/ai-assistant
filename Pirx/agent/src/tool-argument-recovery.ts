import type { Message } from "ollama";

export interface ToolArgumentRecoveryBudget { remaining: number; }
export class ToolArgumentGenerationError extends Error {
  public constructor() { super("Model returned invalid tool arguments after bounded recovery."); this.name = "ToolArgumentGenerationError"; }
}
export const TOOL_ARGUMENT_FAILURE_RESPONSE = "Model nie wygenerował poprawnych argumentów narzędzia mimo jednej próby naprawy. Wadliwe wywołanie nie zostało wykonane. Wyniki wcześniejszych operacji pozostają w historii. Nie ponawiam ich automatycznie. Możesz kontynuować od tego miejsca albo rozpocząć nową rozmowę z krótkim podsumowaniem.";

/** Retry generation only: a backend parse error has not produced an executable tool call. */
export async function withToolArgumentRecovery<T>(
  messages: Message[],
  toolNames: readonly string[],
  budget: ToolArgumentRecoveryBudget,
  execute: (messages: Message[]) => Promise<T>,
  onRecovery: () => void,
): Promise<T> {
  try {
    return await execute(messages);
  } catch (error) {
    const match = error instanceof Error
      ? /^llama-server returned invalid tool call arguments for "([A-Za-z0-9_-]+)":/u.exec(error.message)
      : null;
    if (match === null || !toolNames.includes(match[1]!)) throw error;
    if (budget.remaining <= 0) throw new ToolArgumentGenerationError();
    budget.remaining -= 1;
    onRecovery();
    return withToolArgumentRecovery([...messages, {
      role: "user",
      content: `[Pirx: naprawa formatu] Backend odrzucił niepoprawny JSON argumentów narzędzia ${match[1]}. To wywołanie nie zostało wykonane. Wygeneruj poprawne, kompletne argumenty zgodne ze schematem. Użyj wyłącznie potrzebnych pól i krótkiego wywołania. Nie kopiuj treści logów do argumentów, nie wymyślaj kursora i nie powtarzaj wcześniejszych zakończonych operacji. Jeżeli masz już potrzebne informacje, odpowiedz bez narzędzia.`,
    }], toolNames, budget, execute, onRecovery);
  }
}
