import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import * as z from "zod/v4";

import type { GoogleCalendarConfig } from "../config.js";
import { CalendarError } from "./types.js";

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const oauthClientSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
  redirect_uris: z.array(z.string()).optional(),
});

const credentialsFileSchema = z
  .object({
    installed: oauthClientSchema.optional(),
    web: oauthClientSchema.optional(),
  })
  .refine((value) => value.installed !== undefined || value.web !== undefined);

const storedTokenSchema = z.object({
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  expiry_date: z.number().int().positive().optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

type OAuthClient = z.infer<typeof oauthClientSchema>;
type StoredToken = z.infer<typeof storedTokenSchema>;

interface AuthorizationRequest {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function timeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

async function jsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new CalendarError("configuration", `Google credential file not found: ${path}`, {
        cause: error,
      });
    }
    if (error instanceof SyntaxError) {
      throw new CalendarError("configuration", `Google credential file is not valid JSON: ${path}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export class GoogleOAuthTokenProvider implements AccessTokenProvider {
  readonly #config: GoogleCalendarConfig;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  #token: StoredToken | undefined;
  #refreshInFlight: Promise<string> | undefined;

  constructor(
    config: GoogleCalendarConfig,
    options: { readonly fetch?: FetchLike; readonly now?: () => number } = {},
  ) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  async #credentials(): Promise<OAuthClient> {
    const parsed = credentialsFileSchema.safeParse(
      await jsonFile(this.#config.credentialsFile),
    );
    if (!parsed.success) {
      throw new CalendarError(
        "configuration",
        `Google credential file has an unsupported shape: ${this.#config.credentialsFile}`,
      );
    }
    const client = parsed.data.installed ?? parsed.data.web;
    if (client === undefined) {
      throw new CalendarError("configuration", "Google OAuth client credentials are missing.");
    }
    return client;
  }

  async #storedToken(): Promise<StoredToken> {
    if (this.#token !== undefined) {
      return this.#token;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.#config.tokenFile, "utf8")) as unknown;
    } catch (error: unknown) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        throw new CalendarError(
          "authentication",
          `Google Calendar is not authorized. Run the calendar authorization command; token file is missing: ${this.#config.tokenFile}`,
          { cause: error },
        );
      }
      throw new CalendarError(
        "authentication",
        `Could not read Google Calendar token file: ${this.#config.tokenFile}`,
        { cause: error },
      );
    }

    const parsed = storedTokenSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CalendarError(
        "authentication",
        `Google Calendar token file has an unsupported shape: ${this.#config.tokenFile}`,
      );
    }
    this.#token = parsed.data;
    return parsed.data;
  }

  async getAccessToken(): Promise<string> {
    const token = await this.#storedToken();
    if (
      token.access_token !== undefined &&
      token.expiry_date !== undefined &&
      token.expiry_date > this.#now() + 60_000
    ) {
      return token.access_token;
    }
    if (token.refresh_token === undefined) {
      throw new CalendarError(
        "authentication",
        "Google Calendar token is expired and has no refresh token. Run authorization again.",
      );
    }

    this.#refreshInFlight ??= this.#refresh(token).finally(() => {
      this.#refreshInFlight = undefined;
    });
    return this.#refreshInFlight;
  }

  async #refresh(previous: StoredToken): Promise<string> {
    const client = await this.#credentials();
    const refreshed = await this.#requestToken({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: previous.refresh_token ?? "",
      grant_type: "refresh_token",
    });
    return this.#storeToken(refreshed, previous);
  }

  async createAuthorizationRequest(redirectUri: string): Promise<AuthorizationRequest> {
    const client = await this.#credentials();
    const state = base64Url(randomBytes(32));
    const codeVerifier = base64Url(randomBytes(64));
    const codeChallenge = base64Url(
      createHash("sha256").update(codeVerifier).digest(),
    );
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: GOOGLE_CALENDAR_SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return { url: url.toString(), state, codeVerifier };
  }

  async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<void> {
    if (code.trim().length === 0) {
      throw new CalendarError("authentication", "Google authorization code is empty.");
    }
    const client = await this.#credentials();
    const response = await this.#requestToken({
      client_id: client.client_id,
      client_secret: client.client_secret,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    let previous: StoredToken = {};
    try {
      previous = await this.#storedToken();
    } catch (error: unknown) {
      if (!(error instanceof CalendarError) || error.code !== "authentication") {
        throw error;
      }
    }
    if (response.refresh_token === undefined && previous.refresh_token === undefined) {
      throw new CalendarError(
        "authentication",
        "Google OAuth did not return a refresh token. Revoke the app grant and authorize again.",
      );
    }
    await this.#storeToken(response, previous);
  }

  async #requestToken(parameters: Record<string, string>): Promise<z.infer<typeof tokenResponseSchema>> {
    const signal = AbortSignal.timeout(this.#config.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters),
        signal,
      });
    } catch (error: unknown) {
      if (timeoutError(error)) {
        throw new CalendarError("timeout", "Google OAuth request timed out.", {
          cause: error,
        });
      }
      throw new CalendarError("network", "Google OAuth request failed.", { cause: error });
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error: unknown) {
      if (timeoutError(error) || signal.aborted) {
        throw new CalendarError("timeout", "Google OAuth response timed out.", {
          cause: error,
        });
      }
      throw new CalendarError("network", "Could not read the Google OAuth response.", {
        cause: error,
      });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(responseText) as unknown;
    } catch (error: unknown) {
      throw new CalendarError("malformed_response", "Google OAuth returned malformed JSON.", {
        cause: error,
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new CalendarError(
        "authentication",
        response.status === 400
          ? "Google OAuth rejected the authorization or refresh token. Authorize Calendar again."
          : `Google OAuth request failed with HTTP ${response.status}.`,
        { status: response.status },
      );
    }

    const parsed = tokenResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new CalendarError(
        "malformed_response",
        "Google OAuth response did not contain a valid access token.",
        { status: response.status },
      );
    }
    return parsed.data;
  }

  async #storeToken(
    response: z.infer<typeof tokenResponseSchema>,
    previous: StoredToken,
  ): Promise<string> {
    const token: StoredToken = {
      access_token: response.access_token,
      ...(response.refresh_token !== undefined
        ? { refresh_token: response.refresh_token }
        : previous.refresh_token !== undefined
          ? { refresh_token: previous.refresh_token }
          : {}),
      ...(response.token_type !== undefined ? { token_type: response.token_type } : {}),
      ...(response.scope !== undefined ? { scope: response.scope } : {}),
      expiry_date: this.#now() + (response.expires_in ?? 3_600) * 1_000,
    };
    await writePrivateJson(this.#config.tokenFile, token);
    this.#token = token;
    return response.access_token;
  }
}
