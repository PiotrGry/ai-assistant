import assert from "node:assert/strict";
import test from "node:test";

import type { ChatTurn, ChatTurnContext, SessionTurn } from "@pirx/agent";

import { runRecordedTurn, type TurnRecorder, type TurnRunner } from "../src/recorded-turn.js";

const sessionTurn: SessionTurn = { id: "turn-1", turnId: "turn-1", sequence: 0, sessionId: "session-1" };
const chatTurn = { content: "Cześć!", messages: [], metrics: {} } as unknown as ChatTurn;

class FakeRecorder implements TurnRecorder {
  readonly calls: string[] = [];
  beginError: Error | undefined;
  saveError: Error | undefined;

  beginTurn(prompt: string): SessionTurn {
    this.calls.push(`begin:${prompt}`);
    if (this.beginError !== undefined) throw this.beginError;
    return sessionTurn;
  }

  async saveTurn(prompt: string, response: string, _metrics: ChatTurn["metrics"], turn: SessionTurn): Promise<void> {
    this.calls.push(`save:${prompt}:${response}:${turn.id}`);
    if (this.saveError !== undefined) throw this.saveError;
  }

  async failTurn(turn: SessionTurn, error: unknown): Promise<void> {
    this.calls.push(`fail:${turn.id}:${error instanceof Error ? error.message : String(error)}`);
  }
}

function runner(result: ChatTurn | Error, contexts: ChatTurnContext[]): TurnRunner {
  return {
    chat: async (_prompt, context) => {
      contexts.push(context);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test("records a successful turn with the session turn as chat context", async () => {
  const recorder = new FakeRecorder();
  const contexts: ChatTurnContext[] = [];

  const result = await runRecordedTurn(runner(chatTurn, contexts), recorder, "Cześć");

  assert.equal(result.turn, chatTurn);
  assert.equal(result.recordingError, undefined);
  assert.deepEqual(contexts, [sessionTurn]);
  assert.deepEqual(recorder.calls, ["begin:Cześć", "save:Cześć:Cześć!:turn-1"]);
});

test("marks the turn as failed and rethrows when chat fails", async () => {
  const recorder = new FakeRecorder();

  await assert.rejects(
    runRecordedTurn(runner(new Error("Ollama timeout"), []), recorder, "Cześć"),
    /Ollama timeout/u,
  );
  assert.deepEqual(recorder.calls, ["begin:Cześć", "fail:turn-1:Ollama timeout"]);
});

test("returns the answer with a recording error when saving fails", async () => {
  const recorder = new FakeRecorder();
  recorder.saveError = new Error("database is locked");

  const result = await runRecordedTurn(runner(chatTurn, []), recorder, "Cześć");

  assert.equal(result.turn, chatTurn);
  assert.equal(result.recordingError, "database is locked");
});

test("still runs the turn without context when the recording cannot start", async () => {
  const recorder = new FakeRecorder();
  recorder.beginError = new Error("Session logger is closed.");
  const contexts: ChatTurnContext[] = [];

  const result = await runRecordedTurn(runner(chatTurn, contexts), recorder, "Cześć");

  assert.equal(result.turn, chatTurn);
  assert.equal(result.recordingError, "Session logger is closed.");
  assert.deepEqual(contexts, [{}]);
  assert.deepEqual(recorder.calls, ["begin:Cześć"]);
});
