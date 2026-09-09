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
  readonly openUrl?: (url: string) => Promise<void>;
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
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      const oauthError = url.searchParams.get("error");
      if (expectedState === undefined || state !== expectedState) {
        throw new CalendarError("authentication", "Google OAuth state did not match.");
      }
      if (oauthError !== null) {
        throw new CalendarError(
          "authentication",
          `Google authorization was not completed (${oauthError}).`,
        );
      }
      if (code === null || code.length === 0) {
        throw new CalendarError("authentication", "Google OAuth callback had no code.");
      }

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
    const provider = new GoogleOAuthTokenProvider(config);
    const authorization = await provider.createAuthorizationRequest(redirectUri);
    expectedState = authorization.state;

    writeMessage("Open this URL in a browser to authorize Google Calendar:");
    writeMessage(authorization.url);
    try {
      await (options.openUrl ?? openBrowser)(authorization.url);
      writeMessage("A browser window was opened. Complete Google authorization there.");
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      writeMessage(`Could not open a browser automatically (${detail}). Use the URL above.`);
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
    const code = await Promise.race([codePromise, timeout]);
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
