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
  readonly googleCalendar: GoogleCalendarConfig;
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

  return {
    obsidianVaultPath: optionalPath(environment.PIRX_OBSIDIAN_VAULT),
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
  };
}
