import { HeadlessConfigurationError, readHeadlessOrchestratorConfig, resolveRuntimeStoragePath, RuntimeStorageError } from "@pirx/orchestrator";
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
  readonly orchestratorConfigurationError?: string;
  readonly resourceDatabasePath: string;
  readonly googleCalendar: GoogleCalendarConfig | undefined;
  readonly googleCalendarConfigurationError?: string;
  readonly githubPocIssue: number | undefined;
  readonly githubPocConfigurationError: string | undefined;
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
  let orchestratorConfigurationError: string | undefined;
  try {
    const runtime = readHeadlessOrchestratorConfig(environment);
    if (runtime !== undefined || (environment.PIRX_ORCHESTRATOR_SERVICE_ENABLED !== "true" && optionalPath(environment.PIRX_ORCHESTRATOR_DATABASE) !== undefined)) {
      orchestratorDatabasePath = resolveRuntimeStoragePath(environment, runtime?.databasePath);
    } else {
      orchestratorConfigurationError = "Configure pirx/orchestrator.json or set PIRX_ORCHESTRATOR_CONFIG to the daemon's profile.";
    }
  } catch (error: unknown) {
    orchestratorConfigurationError = error instanceof HeadlessConfigurationError || error instanceof RuntimeStorageError
      ? error.message
      : "Orchestrator runtime configuration could not be verified.";
  }

  return {
    obsidianVaultPath:
      optionalPath(environment.PIRX_OBSIDIAN_VAULT),
    orchestratorDatabasePath,
    ...(orchestratorConfigurationError === undefined ? {} : { orchestratorConfigurationError }),
    resourceDatabasePath: optionalPath(environment.PIRX_GPU_DB) ?? resolve(dataHome, "pirx", "gpu.sqlite"),
    googleCalendar,
    ...(googleCalendarConfigurationError === undefined ? {} : { googleCalendarConfigurationError }),
    githubPocIssue: githubPocIssue.value,
    githubPocConfigurationError: githubPocIssue.error,
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
