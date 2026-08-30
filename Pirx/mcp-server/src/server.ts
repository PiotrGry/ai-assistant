import { McpServer } from "@modelcontextprotocol/server";

import { loadMcpServerConfig } from "./config.js";
import { GoogleOAuthTokenProvider } from "./google-calendar/auth.js";
import { GoogleCalendarClient } from "./google-calendar/client.js";
import type { CalendarOperations } from "./google-calendar/types.js";
import { ObsidianVault } from "./obsidian/vaults.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerHelloTool } from "./tools/hello.js";
import { registerSystemTools } from "./tools/system.js";
import { registerObsidianTools } from "./tools/obsidian.js";

export interface McpServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly obsidianVault?: ObsidianVault;
  readonly calendar?: CalendarOperations;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const config = loadMcpServerConfig(options.environment);
  const obsidianVault =
    options.obsidianVault ??
    (config.obsidianVaultPath === undefined
      ? undefined
      : new ObsidianVault(config.obsidianVaultPath));
  const calendar =
    options.calendar ??
    new GoogleCalendarClient(
      new GoogleOAuthTokenProvider(config.googleCalendar),
      config.googleCalendar,
    );
  const server = new McpServer({
    name: "pirx-mcp-server",
    version: "0.1.0",
  });

  registerHelloTool(server);
  registerSystemTools(server);
  registerObsidianTools(server, obsidianVault);
  registerCalendarTools(server, calendar);
  return server;
}
