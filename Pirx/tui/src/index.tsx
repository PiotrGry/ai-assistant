import { render } from "ink";

import { PirxAgent, SessionLogger, loadConfig } from "@pirx/agent";

import { App } from "./app.js";
import { TuiEventBus } from "./events.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const events = new TuiEventBus();
  const agent = await PirxAgent.create(config, {
    onToolCall: (name) => events.emit({ type: "tool-started", name }),
    onToolResult: (name, result, durationMs) => events.emit({
      type: "tool-finished",
      name,
      isError: result.isError,
      text: result.text,
      durationMs,
    }),
    onMcpUnavailable: (reason) => events.emit({ type: "mcp-unavailable", reason }),
  });

  let logger: SessionLogger | undefined;
  let recordingNotice: string | undefined;
  try {
    logger = await SessionLogger.create(config, agent.systemPrompt);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    recordingNotice = `Sesja nie będzie zapisana: ${detail}`;
  }

  let instance: ReturnType<typeof render> | undefined;

  try {
    // Deliberately use the normal terminal buffer. An alternate screen would
    // hide chat history from native scrolling, selection, and clipboard UX.
    instance = render(
      <App agent={agent} events={events} recorder={logger} initialNotice={recordingNotice} />,
      {
        exitOnCtrlC: false,
      },
    );
    const onSigwinch = (): void => {
      // Ink 5 listens for stdout's resize event, while tmux may only deliver
      // SIGWINCH to the process. Forward the signal so Ink recalculates Yoga
      // layout and the App receives the new terminal dimensions.
      if (process.stdout.isTTY === true) {
        try {
          const [columns, rows] = process.stdout.getWindowSize();
          if (columns > 0 && rows > 0) {
            process.stdout.columns = columns;
            process.stdout.rows = rows;
          }
        } catch {
          // The terminal can disappear during shutdown or an SSH reconnect.
        }
      }
      process.stdout.emit("resize");
    };
    process.on("SIGWINCH", onSigwinch);
    try {
      await instance.waitUntilExit();
    } finally {
      process.off("SIGWINCH", onSigwinch);
    }
  } finally {
    await logger?.close().catch(() => undefined);
    await agent.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Nie można uruchomić Pirx TUI: ${detail}\n`);
  process.exitCode = 1;
});
