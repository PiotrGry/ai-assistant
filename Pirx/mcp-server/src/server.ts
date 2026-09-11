import { McpServer } from "@modelcontextprotocol/server";
import {
  GitHubIssueLifecycleRoundTrip,
  GitHubIssueMutator,
  GitHubIssueReader,
  GitHubTransport,
  GitHubWriteQueue,
  GitHubConfigurationError,
  loadGitHubConfig,
  type GitHubConfig,
  type GitHubIssueMutationTransport,
  type GitHubIssueReadTransport,
} from "@pirx/orchestrator";

import { loadMcpServerConfig } from "./config.js";
import { GoogleOAuthTokenProvider } from "./google-calendar/auth.js";
import { GoogleCalendarClient } from "./google-calendar/client.js";
import type { CalendarOperations } from "./google-calendar/types.js";
import { ObsidianVault } from "./obsidian/vaults.js";
import { registerCalendarTools } from "./tools/calendar.js";
import { registerHelloTool } from "./tools/hello.js";
import { registerSystemTools } from "./tools/system.js";
import { registerObsidianTools } from "./tools/obsidian.js";
import { registerGitHubPocTool } from "./tools/github.js";

export type GitHubPocTransport = GitHubIssueReadTransport & GitHubIssueMutationTransport;

export interface McpServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly obsidianVault?: ObsidianVault;
  readonly calendar?: CalendarOperations;
  readonly githubPocTransport?: GitHubPocTransport;
  readonly githubPocConfig?: GitHubConfig;
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const environment = options.environment ?? process.env;
  const config = loadMcpServerConfig(environment);
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
  if (environment.PIRX_GITHUB_POC_ISSUE?.trim() !== undefined) {
    let githubConfig = options.githubPocConfig;
    let configurationError = config.githubPocConfigurationError;
    if (githubConfig === undefined && configurationError === undefined) {
      try {
        githubConfig = loadGitHubConfig(environment);
      } catch (error: unknown) {
        configurationError =
          error instanceof GitHubConfigurationError
            ? error.message
            : "GitHub POC is unavailable because its required configuration is incomplete.";
      }
    }
    const transport =
      options.githubPocTransport ??
      (githubConfig === undefined ? undefined : new GitHubTransport(githubConfig));
    registerGitHubPocTool(server, {
      issue: config.githubPocIssue,
      config: githubConfig,
      transport,
      configurationError,
    });
  }
  return server;
}
