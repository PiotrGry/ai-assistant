import { McpServer } from "@modelcontextprotocol/server";
import {
  GitHubIssueMutator,
  GitHubIssueReader,
  GitHubActionsGateway,
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
import { registerGitHubIssueTools } from "./tools/github-issues.js";
import { registerGitHubActionsWatchTool } from "./tools/github-actions.js";

export type GitHubPocTransport = GitHubIssueReadTransport & GitHubIssueMutationTransport;

export interface McpServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly obsidianVault?: ObsidianVault;
  readonly calendar?: CalendarOperations;
  readonly githubPocTransport?: GitHubPocTransport;
  readonly githubPocConfig?: GitHubConfig;
  readonly githubAuthorizationSecret?: string;
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
  // Issue tools are always listed; without configuration they return a controlled
  // `configuration` error naming what is missing instead of silently disappearing.
  let githubConfig = options.githubPocConfig;
  let githubConfigurationError: string | undefined;
  if (githubConfig === undefined) {
    try {
      githubConfig = loadGitHubConfig(environment);
    } catch (error: unknown) {
      githubConfigurationError =
        error instanceof GitHubConfigurationError
          ? error.message
          : "GitHub Issue tools are unavailable because their required configuration is incomplete.";
    }
  }
  const transport =
    options.githubPocTransport ??
    (githubConfig === undefined ? undefined : new GitHubTransport(githubConfig));
  const githubQueue = githubConfig === undefined || transport === undefined
    ? undefined
    : new GitHubWriteQueue();
  const githubReader = githubConfig === undefined || transport === undefined
    ? undefined
    : new GitHubIssueReader(transport, githubConfig);
  const githubMutator = githubReader === undefined || githubQueue === undefined || githubConfig === undefined || transport === undefined
    ? undefined
    : new GitHubIssueMutator(transport, githubReader, githubQueue, githubConfig);
  const githubActionsGateway = githubConfig === undefined || transport === undefined
    ? undefined
    : new GitHubActionsGateway(transport, githubConfig);
  registerGitHubIssueTools(server, {
    configurationError: githubConfigurationError,
    authorizationSecret: options.githubAuthorizationSecret ?? environment.PIRX_MCP_AUTH_SECRET,
    reader: githubReader,
    mutator: githubMutator,
  });
  registerGitHubActionsWatchTool(server, {
    config: githubConfig,
    gateway: githubActionsGateway,
    configurationError: githubConfigurationError,
  });
  if ((environment.PIRX_GITHUB_POC_ISSUE?.trim().length ?? 0) > 0) {
    registerGitHubPocTool(server, {
      issue: config.githubPocIssue,
      config: githubConfig,
      transport,
      configurationError: config.githubPocConfigurationError ?? githubConfigurationError,
      authorizationSecret: options.githubAuthorizationSecret ?? environment.PIRX_MCP_AUTH_SECRET,
      reader: githubReader,
      mutator: githubMutator,
    });
  }
  if (githubQueue !== undefined) {
    const close = server.close.bind(server);
    let closed: Promise<void> | undefined;
    server.close = () => {
      closed ??= (async () => {
        await githubQueue.close({ drain: true });
        await close();
      })();
      return closed;
    };
  }
  return server;
}
