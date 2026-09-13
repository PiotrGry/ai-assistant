import type { ChatTurn, ChatTurnContext, SessionTurn } from "@pirx/agent";

export interface TurnRecorder {
  beginTurn(prompt: string): SessionTurn;
  saveTurn(
    prompt: string,
    response: string,
    metrics: ChatTurn["metrics"],
    turn: SessionTurn,
    messages: ChatTurn["messages"],
  ): Promise<void>;
  failTurn(turn: SessionTurn, error: unknown): Promise<void>;
}

export interface TurnRunner {
  chat(prompt: string, context: ChatTurnContext): Promise<ChatTurn>;
}

export interface RecordedTurn {
  readonly turn: ChatTurn;
  readonly recordingError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Recording is best effort: a storage failure is reported next to the answer but never loses the turn.
export async function runRecordedTurn(
  agent: TurnRunner,
  recorder: TurnRecorder,
  prompt: string,
): Promise<RecordedTurn> {
  let sessionTurn: SessionTurn | undefined;
  let recordingError: string | undefined;
  try {
    sessionTurn = recorder.beginTurn(prompt);
  } catch (error: unknown) {
    recordingError = errorMessage(error);
  }

  let turn: ChatTurn;
  try {
    turn = await agent.chat(prompt, sessionTurn ?? {});
  } catch (error: unknown) {
    if (sessionTurn !== undefined) {
      await recorder.failTurn(sessionTurn, error).catch(() => undefined);
    }
    throw error;
  }

  if (sessionTurn === undefined) {
    return recordingError === undefined ? { turn } : { turn, recordingError };
  }
  try {
    await recorder.saveTurn(prompt, turn.content, turn.metrics, sessionTurn, turn.messages);
    return { turn };
  } catch (error: unknown) {
    return { turn, recordingError: errorMessage(error) };
  }
}
