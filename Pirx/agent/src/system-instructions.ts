import type { Message } from "ollama";

/** Add request-only instructions without changing the stored conversation. */
export function withSystemInstruction(messages: readonly Message[], instruction: string): Message[] {
  const [first, ...history] = messages;
  if (first?.role !== "system") return [{ role: "system", content: instruction }, ...messages];
  return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...history];
}
