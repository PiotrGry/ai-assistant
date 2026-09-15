import { McpServer } from "@modelcontextprotocol/server";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  GitHubIssueMutator,
  GitHubIssueReader,
  GitHubActionsGateway,
  GitHubTransport,
  GitHubWriteQueue,
  GitHubConfigurationError,
  FileGitHubShipmentPocStore,
  GitHubShipmentPocGateway,
  type GitHubShipmentPocStore,
  type GitHubShipmentPocTransport,
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
import { registerGitHubShipmentPocTool } from "./tools/github-shipment-poc.js";
import { registerGitHubFailureHandoffPocTool } from "./tools/github-failure-handoff-poc.js";
import { CodexCliRunner } from "@pirx/orchestrator";
import {
  FileGitHubFailureHandoffPocStore,
  type GitHubFailureHandoffPocGateway,
  type GitHubFailureHandoffPocStore,
} from "@pirx/orchestrator";

export type GitHubPocTransport = GitHubIssueReadTransport & GitHubIssueMutationTransport;

export interface McpServerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly obsidianVault?: ObsidianVault;
  readonly calendar?: CalendarOperations;
  readonly githubPocTransport?: GitHubPocTransport;
  readonly githubPocConfig?: GitHubConfig;
  readonly githubAuthorizationSecret?: string;
  readonly githubShipmentPocConfig?: GitHubConfig;
  readonly githubShipmentPocTransport?: GitHubShipmentPocTransport;
  readonly githubShipmentPocStore?: GitHubShipmentPocStore;
  readonly githubFailureHandoffPocConfig?: GitHubConfig;
  readonly githubFailureHandoffPocGateway?: GitHubFailureHandoffPocGateway;
  readonly githubFailureHandoffPocStore?: GitHubFailureHandoffPocStore;
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
  const shipmentEnabled = options.githubShipmentPocConfig !== undefined || ["1", "true"].includes(environment.PIRX_GITHUB_SHIPMENT_POC?.trim().toLowerCase() ?? "");
  let shipmentConfig = options.githubShipmentPocConfig;
  if (shipmentEnabled && shipmentConfig === undefined && githubConfig !== undefined) {
    shipmentConfig = { ...githubConfig, owner: "PiotrGry", repository: "zdrovena-reconciliation" };
  }
  const shipmentTransport = shipmentEnabled
    ? options.githubShipmentPocTransport ?? (shipmentConfig === undefined ? undefined : new GitHubTransport(shipmentConfig))
    : undefined;
  const shipmentQueue = shipmentTransport === undefined ? undefined : new GitHubWriteQueue();
  const shipmentGateway = shipmentTransport === undefined || shipmentConfig === undefined || shipmentQueue === undefined
    ? undefined
    : new GitHubShipmentPocGateway(shipmentTransport, shipmentConfig, shipmentQueue);
  if (shipmentEnabled) {
    const stateFile = environment.PIRX_GITHUB_SHIPMENT_POC_STATE_FILE?.trim() || join(environment.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "pirx", "github-shipment-poc.json");
    registerGitHubShipmentPocTool(server, {
      config: shipmentConfig,
      gateway: shipmentGateway,
      store: options.githubShipmentPocStore ?? new FileGitHubShipmentPocStore(stateFile),
      authorizationSecret: options.githubAuthorizationSecret ?? environment.PIRX_MCP_AUTH_SECRET,
      ...(githubConfigurationError === undefined ? {} : { configurationError: githubConfigurationError }),
    });
  }
  const failureHandoffEnabled = options.githubFailureHandoffPocConfig !== undefined || ["1", "true"].includes(environment.PIRX_GITHUB_FAILURE_HANDOFF_POC?.trim().toLowerCase() ?? "");
  let failureHandoffConfig = options.githubFailureHandoffPocConfig;
  if (failureHandoffEnabled && failureHandoffConfig === undefined && githubConfig !== undefined) {
    failureHandoffConfig = { ...githubConfig, owner: "PiotrGry", repository: "zdrovena-reconciliation" };
  }
  const failureHandoffTransport = failureHandoffEnabled
    ? options.githubFailureHandoffPocGateway ?? (failureHandoffConfig === undefined ? undefined : new GitHubShipmentPocGateway(new GitHubTransport(failureHandoffConfig), failureHandoffConfig))
    : undefined;
  const closeFailureHandoffTransport = failureHandoffTransport !== undefined && "close" in failureHandoffTransport && typeof failureHandoffTransport.close === "function"
    ? failureHandoffTransport.close.bind(failureHandoffTransport)
    : undefined;
  if (failureHandoffEnabled) {
    const stateFile = environment.PIRX_GITHUB_FAILURE_HANDOFF_POC_STATE_FILE?.trim() || join(environment.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "pirx", "github-failure-handoff-poc.json");
    registerGitHubFailureHandoffPocTool(server, {
      config: failureHandoffConfig,
      gateway: failureHandoffTransport,
      store: options.githubFailureHandoffPocStore ?? new FileGitHubFailureHandoffPocStore(stateFile),
      codex: new CodexCliRunner(environment.PIRX_CODEX_EXECUTABLE === undefined ? {} : { executable: environment.PIRX_CODEX_EXECUTABLE }),
      authorizationSecret: options.githubAuthorizationSecret ?? environment.PIRX_MCP_AUTH_SECRET,
      ...(githubConfigurationError === undefined ? {} : { configurationError: githubConfigurationError }),
    });
  }
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
  if (githubQueue !== undefined || shipmentQueue !== undefined || failureHandoffTransport !== undefined) {
    const close = server.close.bind(server);
    let closed: Promise<void> | undefined;
    server.close = () => {
      closed ??= (async () => {
        await githubQueue?.close({ drain: true });
        await shipmentQueue?.close({ drain: true });
        await closeFailureHandoffTransport?.();
        await close();
      })();
      return closed;
    };
  }
  return server;
}
