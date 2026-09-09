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

  try {
    const { waitUntilExit } = render(<App agent={agent} events={events} />, {
      exitOnCtrlC: false,
    });
    await waitUntilExit();
  } finally {
    await agent.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Nie można uruchomić Pirx TUI: ${detail}\n`);
  process.exitCode = 1;
});
