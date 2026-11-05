import { managedRuntimeBinding } from "./runtime-binding.js";
import { McpServer } from "@modelcontextprotocol/server";
import { resolveToolProfile, toolProfileAllows } from "@pirx/config";
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
import { registerTaskHistory } from "./tools/task-history.js";
import { registerConversationLog } from "./advisor.js";
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
import { registerGitHubShipmentCycleTool } from "./tools/github-shipment-cycle.js";
import { registerGitHubFailureHandoffPocTool } from "./tools/github-failure-handoff-poc.js";
import { registerOrchestratorTools, SqliteExecutionObservabilityToolPort, SqliteOrchestratorControlToolPort, type ExecutionObservabilityToolPort, type OrchestratorControlToolPort } from "./tools/orchestrator.js";
import { registerResourceTools, SqliteResourceReportPort, type ResourceReportPort } from "./tools/resources.js";
import { registerOrchestratorServiceTool, SystemdOrchestratorServicePort, type OrchestratorServicePort } from "./tools/orchestrator-service.js";
import { registerOrchestratorLogTool, SystemdOrchestratorLogsPort, type OrchestratorLogsPort } from "./tools/orchestrator-logs.js";
import { SingleUseHostAuthorization } from "./authorization.js";
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
  readonly authorizationSecret?: string;
  /** @deprecated Use authorizationSecret. Kept for existing embedded callers. */
  readonly githubAuthorizationSecret?: string;
  readonly githubShipmentPocConfig?: GitHubConfig;
  readonly githubShipmentPocTransport?: GitHubShipmentPocTransport;
  readonly githubShipmentPocStore?: GitHubShipmentPocStore;
  readonly githubFailureHandoffPocConfig?: GitHubConfig;
  readonly githubFailureHandoffPocGateway?: GitHubFailureHandoffPocGateway;
  readonly githubFailureHandoffPocStore?: GitHubFailureHandoffPocStore;
  readonly orchestratorControlPort?: OrchestratorControlToolPort;
  readonly executionObservabilityPort?: ExecutionObservabilityToolPort;
  readonly resourceReportPort?: ResourceReportPort;
  readonly orchestratorServicePort?: OrchestratorServicePort;
  readonly orchestratorLogsPort?: OrchestratorLogsPort;
}

function unavailableCalendar(message: string): CalendarOperations {
  const unavailable = async (): Promise<never> => { throw new Error(`Google Calendar unavailable: ${message}`); };
  return { listCalendars: unavailable, listEvents: unavailable, getEvent: unavailable, createEvent: unavailable, updateEvent: unavailable, deleteEvent: unavailable };
}

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const environment = options.environment ?? process.env;
  const toolProfile = resolveToolProfile(environment);
  const personalTools = toolProfileAllows(toolProfile, "personal");
  const developmentTools = toolProfileAllows(toolProfile, "development");
  const operationsTools = toolProfileAllows(toolProfile, "operations");
  const authorizationSecret = options.authorizationSecret ?? options.githubAuthorizationSecret ?? environment.PIRX_MCP_AUTH_SECRET;
  const singleUseAuthorization = new SingleUseHostAuthorization(authorizationSecret);
  const config = loadMcpServerConfig(environment);
  const checkBinding = managedRuntimeBinding(config.orchestratorDatabasePath, environment);
  const obsidianVault =
    options.obsidianVault ??
    (config.obsidianVaultPath === undefined
      ? undefined
      : new ObsidianVault(config.obsidianVaultPath));
  const calendar =
    options.calendar ??
    (config.googleCalendar === undefined ? unavailableCalendar(config.googleCalendarConfigurationError ?? "Calendar configuration is invalid.") : new GoogleCalendarClient(
      new GoogleOAuthTokenProvider(config.googleCalendar),
      config.googleCalendar,
    ));
  const server = new McpServer({
    name: "pirx-mcp-server",
    version: "0.1.0",
  });

  registerHelloTool(server);
  registerSystemTools(server);
  if (personalTools) {
    registerObsidianTools(server, obsidianVault, singleUseAuthorization);
    registerCalendarTools(server, calendar, singleUseAuthorization);
  }
  if (developmentTools) {
    registerConversationLog(server, config.orchestratorDatabasePath, config.orchestratorConfigurationError, checkBinding);
    registerTaskHistory(server, config.orchestratorDatabasePath, config.orchestratorConfigurationError, checkBinding);
  }
  if (operationsTools) {
    registerOrchestratorTools(server, {
      port: options.orchestratorControlPort ?? (config.orchestratorDatabasePath === undefined ? undefined : new SqliteOrchestratorControlToolPort(config.orchestratorDatabasePath, checkBinding)),
      observabilityPort: options.executionObservabilityPort ?? (config.orchestratorDatabasePath === undefined ? undefined : new SqliteExecutionObservabilityToolPort(config.orchestratorDatabasePath, checkBinding)),
      authorizationSecret,
      ...(config.orchestratorConfigurationError === undefined ? {} : { configurationError: config.orchestratorConfigurationError }),
    });
    registerResourceTools(server, { port: options.resourceReportPort ?? new SqliteResourceReportPort(config.resourceDatabasePath) });
    registerOrchestratorLogTool(server, options.orchestratorLogsPort ?? new SystemdOrchestratorLogsPort({ environment }));
    registerOrchestratorServiceTool(server, {
      port: options.orchestratorServicePort ?? new SystemdOrchestratorServicePort({ environment, checkBinding }),
      ...(config.orchestratorConfigurationError === undefined ? {} : { configurationError: config.orchestratorConfigurationError }),
      authorizationSecret,
    });
  }
  if (!developmentTools) return server;
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
    authorizationSecret,
    reader: githubReader,
    mutator: githubMutator,
  });
  registerGitHubActionsWatchTool(server, {
    config: githubConfig,
    gateway: githubActionsGateway,
    configurationError: githubConfigurationError,
  });
  const shipmentPocEnabled = operationsTools && (options.githubShipmentPocConfig !== undefined || ["1", "true"].includes(environment.PIRX_GITHUB_SHIPMENT_POC?.trim().toLowerCase() ?? ""));
  const shipmentCycleEnabled = operationsTools && ["1", "true"].includes(environment.PIRX_GITHUB_SHIPMENT_CYCLE?.trim().toLowerCase() ?? "");
  const shipmentEnabled = shipmentPocEnabled || shipmentCycleEnabled;
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
  if (shipmentPocEnabled) {
    const stateFile = environment.PIRX_GITHUB_SHIPMENT_POC_STATE_FILE?.trim() || join(environment.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state"), "pirx", "github-shipment-poc.json");
    registerGitHubShipmentPocTool(server, {
      config: shipmentConfig,
      gateway: shipmentGateway,
      store: options.githubShipmentPocStore ?? new FileGitHubShipmentPocStore(stateFile),
      authorizationSecret,
      ...(githubConfigurationError === undefined ? {} : { configurationError: githubConfigurationError }),
    });
  }
  if (shipmentCycleEnabled) {
    registerGitHubShipmentCycleTool(server, {
      config: shipmentConfig,
      transport: shipmentTransport,
      authorizationSecret,
      environment,
      databasePath: config.orchestratorDatabasePath,
      checkBinding,
      ...(config.orchestratorConfigurationError === undefined ? {} : { runtimeConfigurationError: config.orchestratorConfigurationError }),
      ...(githubConfigurationError === undefined ? {} : { configurationError: githubConfigurationError }),
    });
  }
  const failureHandoffEnabled = operationsTools && (options.githubFailureHandoffPocConfig !== undefined || ["1", "true"].includes(environment.PIRX_GITHUB_FAILURE_HANDOFF_POC?.trim().toLowerCase() ?? ""));
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
      authorizationSecret,
      ...(githubConfigurationError === undefined ? {} : { configurationError: githubConfigurationError }),
    });
  }
  if (operationsTools && (environment.PIRX_GITHUB_POC_ISSUE?.trim().length ?? 0) > 0) {
    registerGitHubPocTool(server, {
      issue: config.githubPocIssue,
      config: githubConfig,
      transport,
      configurationError: config.githubPocConfigurationError ?? githubConfigurationError,
      authorizationSecret,
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
