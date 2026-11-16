import { HeadlessConfigurationError, readHeadlessOrchestratorConfig, resolveHeadlessOrchestratorConfigSelection, resolveRuntimeStoragePath, RuntimeStorageError } from "@pirx/orchestrator";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface GoogleCalendarConfig {
  readonly credentialsFile: string;
  readonly tokenFile: string;
  readonly defaultCalendarId: string;
  readonly defaultTimeZone: string;
  readonly requestTimeoutMs: number;
  readonly authorizationTimeoutMs: number;
}

export interface McpServerConfig {
  readonly obsidianVaultPath: string | undefined;
  readonly orchestratorDatabasePath: string | undefined;
  readonly orchestratorProfilePath?: string;
  readonly orchestratorConfigurationSource?: "explicit_profile" | "default_profile" | "database_override";
  readonly orchestratorConfigurationCode?: string;
  readonly orchestratorConfigurationError?: string;
  readonly resourceDatabasePath: string;
  readonly googleCalendar: GoogleCalendarConfig | undefined;
  readonly googleCalendarConfigurationError?: string;
  readonly githubPocIssue: number | undefined;
  readonly githubPocConfigurationError: string | undefined;
  /** GitHub repository the chat tools use, taken from or checked against the daemon profile. */
  readonly githubTarget?: { readonly owner: string; readonly repository: string };
  readonly githubTargetError?: string;
}

/**
 * Chat GitHub tools must target a repository the daemon reads, or an Issue
 * created in chat lands where no worker will ever pick it up. With a daemon
 * profile, an unset target is taken from it and a differing one is an error.
 */
function chatGitHubTarget(
  environment: NodeJS.ProcessEnv,
  daemonRepositories: readonly string[] | undefined,
): Pick<McpServerConfig, "githubTarget" | "githubTargetError"> {
  if (daemonRepositories === undefined) return {};
  const owner = environment.PIRX_GITHUB_OWNER?.trim();
  const repository = environment.PIRX_GITHUB_REPOSITORY?.trim();
  const daemon = daemonRepositories.join(", ");
  if (owner && repository) {
    const chat = `${owner}/${repository}`;
    return daemonRepositories.includes(chat)
      ? { githubTarget: { owner, repository } }
      : { githubTargetError: `Chat GitHub target ${chat} (PIRX_GITHUB_OWNER/PIRX_GITHUB_REPOSITORY) differs from the daemon repositories ${daemon}. Remove both variables or set them to a daemon repository.` };
  }
  if (daemonRepositories.length !== 1) {
    return { githubTargetError: `The daemon reads several repositories (${daemon}). Set PIRX_GITHUB_OWNER and PIRX_GITHUB_REPOSITORY to one of them.` };
  }
  const [daemonOwner, daemonRepository] = daemonRepositories[0]!.split("/");
  return { githubTarget: { owner: daemonOwner!, repository: daemonRepository! } };
}

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (received: ${value}).`);
  }
  return parsed;
}

function configuredTimeZone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return detected.length > 0 ? detected : "UTC";
}

function optionalPath(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  return resolve(value.trim());
}

function optionalPositiveInteger(value: string | undefined): {
  readonly value: number | undefined;
  readonly error: string | undefined;
} {
  if (value === undefined || value.trim().length === 0) {
    return { value: undefined, error: undefined };
  }
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return {
      value: undefined,
      error: "PIRX_GITHUB_POC_ISSUE must be a positive integer.",
    };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return {
      value: undefined,
      error: "PIRX_GITHUB_POC_ISSUE must be a positive integer.",
    };
  }
  return { value: parsed, error: undefined };
}

export function loadMcpServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
  const dataHome = environment.XDG_DATA_HOME?.trim() || resolve(homedir(), ".local", "share");
  let googleCalendar: GoogleCalendarConfig | undefined;
  let googleCalendarConfigurationError: string | undefined;
  try { googleCalendar = loadGoogleCalendarConfig(environment); }
  catch (error: unknown) { googleCalendarConfigurationError = error instanceof Error ? error.message : "Google Calendar configuration is invalid."; }

  const githubPocIssue = optionalPositiveInteger(environment.PIRX_GITHUB_POC_ISSUE);

  let orchestratorDatabasePath: string | undefined;
  let orchestratorProfilePath: string | undefined;
  let orchestratorConfigurationSource: McpServerConfig["orchestratorConfigurationSource"];
  let orchestratorConfigurationCode: string | undefined;
  let orchestratorConfigurationError: string | undefined;
  let daemonRepositories: readonly string[] | undefined;
  try {
    const selection = resolveHeadlessOrchestratorConfigSelection(environment);
    const runtime = readHeadlessOrchestratorConfig(environment);
    if (runtime !== undefined) {
      daemonRepositories = runtime.repositories.map((item) => item.repository);
      orchestratorDatabasePath = resolveRuntimeStoragePath(environment, runtime?.databasePath);
      orchestratorProfilePath = selection.filename;
      orchestratorConfigurationSource = selection.source;
    } else if (environment.PIRX_ORCHESTRATOR_SERVICE_ENABLED !== "true" && optionalPath(environment.PIRX_ORCHESTRATOR_DATABASE) !== undefined) {
      orchestratorDatabasePath = resolveRuntimeStoragePath(environment);
      orchestratorConfigurationSource = "database_override";
    } else {
      orchestratorConfigurationCode = "missing_configuration";
      orchestratorConfigurationError = "Configure pirx/orchestrator.json or set PIRX_ORCHESTRATOR_CONFIG to the daemon's profile.";
    }
  } catch (error: unknown) {
    orchestratorConfigurationCode = error instanceof HeadlessConfigurationError || error instanceof RuntimeStorageError ? error.code : "configuration_error";
    orchestratorConfigurationError = error instanceof HeadlessConfigurationError || error instanceof RuntimeStorageError
      ? error.message
      : "Orchestrator runtime configuration could not be verified.";
  }

  return {
    obsidianVaultPath:
      optionalPath(environment.PIRX_OBSIDIAN_VAULT),
    orchestratorDatabasePath,
    ...(orchestratorProfilePath === undefined ? {} : { orchestratorProfilePath }),
    ...(orchestratorConfigurationSource === undefined ? {} : { orchestratorConfigurationSource }),
    ...(orchestratorConfigurationCode === undefined ? {} : { orchestratorConfigurationCode }),
    ...(orchestratorConfigurationError === undefined ? {} : { orchestratorConfigurationError }),
    resourceDatabasePath: optionalPath(environment.PIRX_GPU_DB) ?? resolve(dataHome, "pirx", "gpu.sqlite"),
    googleCalendar,
    ...(googleCalendarConfigurationError === undefined ? {} : { googleCalendarConfigurationError }),
    githubPocIssue: githubPocIssue.value,
    githubPocConfigurationError: githubPocIssue.error,
    ...chatGitHubTarget(environment, daemonRepositories),
  };
}

export function loadGoogleCalendarConfig(environment: NodeJS.ProcessEnv = process.env): GoogleCalendarConfig {
  const googleDirectory = resolve(homedir(), ".config", "pirx", "google-calendar");
  const timeZone =
    environment.PIRX_GOOGLE_CALENDAR_TIMEZONE?.trim() || configuredTimeZone();

  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new Error(
      `PIRX_GOOGLE_CALENDAR_TIMEZONE must be a valid IANA timezone (received: ${timeZone}).`,
    );
  }

  return {
    credentialsFile: resolve(
      environment.PIRX_GOOGLE_CREDENTIALS_FILE?.trim() ||
        resolve(googleDirectory, "credentials.json"),
    ),
    tokenFile: resolve(
      environment.PIRX_GOOGLE_TOKEN_FILE?.trim() || resolve(googleDirectory, "token.json"),
    ),
    defaultCalendarId:
      environment.PIRX_GOOGLE_CALENDAR_ID?.trim() || "primary",
    defaultTimeZone: timeZone,
    requestTimeoutMs: positiveInteger(
      "PIRX_GOOGLE_TIMEOUT_MS",
      environment.PIRX_GOOGLE_TIMEOUT_MS ?? "10000",
    ),
    authorizationTimeoutMs: positiveInteger(
      "PIRX_GOOGLE_AUTH_TIMEOUT_MS",
      environment.PIRX_GOOGLE_AUTH_TIMEOUT_MS ?? "300000",
    ),
  };
}
