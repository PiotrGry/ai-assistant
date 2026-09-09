import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { loadMcpServerConfig } from "../config.js";
import { authorizeGoogleCalendar } from "./authorize.js";

const sshSession = process.env.SSH_CONNECTION !== undefined || process.env.SSH_TTY !== undefined;
const callbackInput = sshSession
  ? createInterface({ input: stdin, output: stdout })
  : undefined;

try {
  const authorizationOptions = sshSession
    ? {
        openUrl: false as const,
        onRedirectUri: (redirectUri: string) => {
          const port = new URL(redirectUri).port;
          console.log(`\nSSH mode detected. On your Mac, open another terminal and run:`);
          console.log(`ssh -N -L ${port}:127.0.0.1:${port} <your-ssh-user>@<your-server>`);
          console.log("Then open the Google authorization URL above in Safari.");
          console.log("If you do not create the tunnel, paste Safari's final callback URL below.");
        },
        readCallbackUrl: () => callbackInput!.question(
          "\nPaste the full callback URL from Safari (or use the SSH tunnel): ",
        ),
      }
    : {};
  await authorizeGoogleCalendar(
    loadMcpServerConfig().googleCalendar,
    console.log,
    authorizationOptions,
  );
} catch (error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Google Calendar authorization failed: ${detail}`);
  process.exitCode = 1;
} finally {
  callbackInput?.close();
  stdin.pause();
}
