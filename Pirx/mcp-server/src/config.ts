import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
  readonly googleCalendar: GoogleCalendarConfig;
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

function defaultObsidianVault(): string | undefined {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "..", "..", "vault"),
    resolve(moduleDirectory, "..", "..", "..", "vault"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function loadMcpServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): McpServerConfig {
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

  const githubPocIssue = optionalPositiveInteger(environment.PIRX_GITHUB_POC_ISSUE);

  return {
    obsidianVaultPath:
      optionalPath(environment.PIRX_OBSIDIAN_VAULT) ?? defaultObsidianVault(),
    googleCalendar: {
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
    },
    githubPocIssue: githubPocIssue.value,
    githubPocConfigurationError: githubPocIssue.error,
  };
}
