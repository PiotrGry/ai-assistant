import { render } from "ink";

import { PirxAgent, loadConfig } from "@pirx/agent";

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

  let instance: ReturnType<typeof render> | undefined;
  const alternateScreen = process.stdout.isTTY === true;
  if (alternateScreen) {
    process.stdout.write("\u001B[?1049h\u001B[H");
  }

  try {
    instance = render(<App agent={agent} events={events} />, {
      exitOnCtrlC: false,
    });
    const onStdoutResize = (): void => {
      // tmux can resize before Ink has rendered the new React layout. Clear
      // the old frame so log-update never combines two different dimensions.
      instance?.clear();
    };
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
    process.stdout.on("resize", onStdoutResize);
    process.on("SIGWINCH", onSigwinch);
    try {
      await instance.waitUntilExit();
    } finally {
      process.stdout.off("resize", onStdoutResize);
      process.off("SIGWINCH", onSigwinch);
      instance.clear();
    }
  } finally {
    if (alternateScreen) {
      process.stdout.write("\u001B[?1049l");
    }
    await agent.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Nie można uruchomić Pirx TUI: ${detail}\n`);
  process.exitCode = 1;
});
