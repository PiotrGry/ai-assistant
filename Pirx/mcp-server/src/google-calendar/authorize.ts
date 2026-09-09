import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";

import type { GoogleCalendarConfig } from "../config.js";
import { GoogleOAuthTokenProvider } from "./auth.js";
import { CalendarError } from "./types.js";

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not determine Google OAuth callback port."));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

export type BrowserCommandRunner = (
  command: string,
  arguments_: readonly string[],
) => Promise<void>;

export interface BrowserOpenOptions {
  readonly platform?: NodeJS.Platform;
  readonly run?: BrowserCommandRunner;
}

function defaultBrowserRunner(
  command: string,
  arguments_: readonly string[],
): Promise<void> {
  return promisify(execFile)(command, [...arguments_], {
    windowsHide: true,
  }).then(() => undefined);
}

export async function openBrowser(
  url: string,
  options: BrowserOpenOptions = {},
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to open a non-HTTPS authorization URL: ${url}`);
  }
  const platform = options.platform ?? process.platform;
  const command = platform === "darwin"
    ? { executable: "open", arguments: [url] }
    : platform === "win32"
      ? { executable: "cmd.exe", arguments: ["/c", "start", "", url] }
      : { executable: "xdg-open", arguments: [url] };
  await (options.run ?? defaultBrowserRunner)(command.executable, command.arguments);
}

export interface GoogleAuthorizationOptions {
  readonly openUrl?: ((url: string) => Promise<void>) | false;
  readonly onRedirectUri?: (redirectUri: string) => void;
  readonly readCallbackUrl?: () => Promise<string | undefined>;
}

export function parseAuthorizationCallback(
  rawUrl: string,
  expectedState: string,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch (error: unknown) {
    throw new CalendarError("authentication", "The pasted Google OAuth callback is not a valid URL.", {
      cause: error,
    });
  }
  if (url.pathname !== "/oauth2/callback") {
    throw new CalendarError(
      "authentication",
      "The pasted URL is not a Pirx Google OAuth callback URL.",
    );
  }
  if (url.searchParams.get("state") !== expectedState) {
    throw new CalendarError("authentication", "Google OAuth state did not match.");
  }
  const oauthError = url.searchParams.get("error");
  if (oauthError !== null) {
    throw new CalendarError(
      "authentication",
      `Google authorization was not completed (${oauthError}).`,
    );
  }
  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) {
    throw new CalendarError("authentication", "Google OAuth callback had no code.");
  }
  return code;
}

export async function authorizeGoogleCalendar(
  config: GoogleCalendarConfig,
  writeMessage: (message: string) => void = console.log,
  options: GoogleAuthorizationOptions = {},
): Promise<void> {
  let expectedState: string | undefined;
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth2/callback") {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (expectedState === undefined) {
        throw new CalendarError("authentication", "Google OAuth callback arrived too early.");
      }
      const code = parseAuthorizationCallback(
        new URL(request.url ?? "/", "http://127.0.0.1").toString(),
        expectedState,
      );

      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("Google Calendar authorization completed. You can close this tab.");
      resolveCode?.(code);
    } catch (error: unknown) {
      const controlled =
        error instanceof Error ? error : new Error("Google OAuth callback failed.");
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end(controlled.message);
      rejectCode?.(controlled);
    }
  });

  let timer: NodeJS.Timeout | undefined;
  try {
    const port = await listenLoopback(server);
    const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;
    options.onRedirectUri?.(redirectUri);
    const provider = new GoogleOAuthTokenProvider(config);
    const authorization = await provider.createAuthorizationRequest(redirectUri);
    const authorizationState = authorization.state;
    expectedState = authorizationState;

    writeMessage("Open this URL in a browser to authorize Google Calendar:");
    writeMessage(authorization.url);
    if (options.openUrl !== false) {
      try {
        await (options.openUrl ?? openBrowser)(authorization.url);
        writeMessage("A browser window was opened. Complete Google authorization there.");
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        writeMessage(`Could not open a browser automatically (${detail}). Use the URL above.`);
      }
    }

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new CalendarError(
            "timeout",
            `Google authorization was not completed within ${config.authorizationTimeoutMs} ms.`,
          ),
        );
      }, config.authorizationTimeoutMs);
    });
    const callbackUrlCode = options.readCallbackUrl === undefined
      ? undefined
      : options.readCallbackUrl().then((value) => {
          if (value === undefined || value.trim().length === 0) {
            throw new CalendarError("authentication", "No Google OAuth callback URL was provided.");
          }
          return parseAuthorizationCallback(value, authorizationState);
        });
    const code = await Promise.race([
      codePromise,
      timeout,
      ...(callbackUrlCode === undefined ? [] : [callbackUrlCode]),
    ]);
    await provider.exchangeAuthorizationCode(
      code,
      authorization.codeVerifier,
      redirectUri,
    );
    writeMessage(`Google Calendar token saved securely at ${config.tokenFile}.`);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await closeServer(server).catch(() => undefined);
  }
}
