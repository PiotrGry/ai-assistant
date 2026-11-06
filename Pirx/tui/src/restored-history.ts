import type { StoredSessionTranscript, StoredTranscriptTurn } from "@pirx/agent";

import type { ChatItem } from "./history.js";

export interface RestoredHistory {
  readonly items: readonly ChatItem[];
  readonly notice?: string;
}

function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function failedTurnItems(turn: StoredTranscriptTurn): ChatItem[] {
  const items: ChatItem[] = [];
  if (turn.userPrompt.length > 0) items.push({ kind: "user", content: turn.userPrompt });
  items.push({
    kind: "error",
    content: stringPayload(turn.payload, "error")
      ?? "Ta tura została przerwana przed zapisaniem kompletnej odpowiedzi. Narzędzia nie zostały uruchomione ponownie.",
  });
  return items;
}

function completedTurnItems(turn: StoredTranscriptTurn): ChatItem[] {
  if (turn.messages.length === 0) {
    const response = stringPayload(turn.payload, "response");
    return [
      ...(turn.userPrompt.length === 0 ? [] : [{ kind: "user" as const, content: turn.userPrompt }]),
      ...(response === undefined ? [] : [{ kind: "assistant" as const, content: response }]),
    ];
  }
  return turn.messages.flatMap((message): ChatItem[] => {
    if (message.role === "user" && message.content !== undefined) {
      return [{ kind: "user", content: message.content }];
    }
    if (message.role === "assistant" && message.content !== undefined && message.content.length > 0) {
      return [{ kind: "assistant", content: message.content }];
    }
    if (message.role === "tool") {
      return [{
        kind: "tool",
        name: message.toolName ?? "unknown",
        status: "done",
        ...(message.content === undefined || message.content.length === 0
          ? {}
          : { detail: (message.content.split("\n", 1)[0] ?? "").slice(0, 140) }),
      }];
    }
    return [];
  });
}

export function restoreHistory(
  transcript: StoredSessionTranscript | undefined,
  currentStorageMode: string = "full_local",
): RestoredHistory {
  if (currentStorageMode !== "full_local") {
    return {
      items: [],
      notice: `Historia rozmowy nie jest odtwarzana (tryb ${currentStorageMode}).`,
    };
  }
  if (transcript === undefined) return { items: [] };
  if (transcript.storageMode !== "full_local") {
    return {
      items: [],
      notice: `Poprzednia historia nie zawiera treści (tryb ${transcript.storageMode ?? "nieznany"}).`,
    };
  }
  const items = transcript.turns.flatMap((turn) => turn.status === "failed"
    ? failedTurnItems(turn)
    : completedTurnItems(turn));
  const notice = transcript.omittedTurnCount > 0
    ? `Przywrócono ostatnie ${transcript.turns.length} tur; ${transcript.omittedTurnCount} starszych pominięto.`
    : undefined;
  return { items, ...(notice === undefined ? {} : { notice }) };
}
