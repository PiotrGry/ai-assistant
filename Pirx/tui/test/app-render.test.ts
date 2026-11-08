import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createElement } from "react";

// Ink disables its live renderer in CI; force the interactive path under test.
for (const key of Object.keys(process.env)) {
  if (key === "CI" || key === "CONTINUOUS_INTEGRATION" || key.startsWith("CI_")) delete process.env[key];
}

class FakeStdout extends EventEmitter {
  public readonly writes: string[] = [];
  public readonly isTTY = true;
  public constructor(public rows: number, public columns: number) { super(); }
  public write(chunk: string): boolean { this.writes.push(chunk); return true; }
}

class FakeStdin extends EventEmitter {
  public readonly isTTY = true;
  public setRawMode(): void {}
  public setEncoding(): void {}
  public read(): null { return null; }
  public ref(): void {}
  public unref(): void {}
  public resume(): void {}
  public pause(): void {}
}

test("chat history stays visible and Ink never clears the terminal", async () => {
  const { render } = await import("ink");
  const { App } = await import("../src/app.js");
  const { TuiEventBus } = await import("../src/events.js");
  const agent = {
    model: "test-model", mcpAvailable: true, lastContextTokens: undefined, contextSize: 1,
    listModels: async () => [], setModel: async () => undefined, chat: async () => ({ content: "", metrics: {} }),
  };
  const stdout = new FakeStdout(20, 80);
  const events = new TuiEventBus();
  const instance = render(createElement(App, {
    agent: agent as never,
    events,
    initialHistory: [{ kind: "user", content: "hello" }, { kind: "assistant", content: "hi" }],
  }), { stdout: stdout as never, stdin: new FakeStdin() as never, exitOnCtrlC: false, patchConsole: false });
  // A tool event re-renders the live viewport, like typing or a spinner tick.
  events.emit({ type: "tool-started", name: "probe" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  instance.unmount();

  const clearTerminal = "\u001B[2J";
  const output = stdout.writes.join("");
  assert.match(output, /hello/u);
  assert.match(output, /hi/u);
  // The live area is content-sized, so history is not pushed off-screen.
  assert.ok(stdout.writes.every((chunk) => chunk.split("\n").length < stdout.rows));
  assert.equal(stdout.writes.some((chunk) => chunk.includes(clearTerminal)), false);
});
