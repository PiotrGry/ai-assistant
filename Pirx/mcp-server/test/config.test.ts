import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadMcpServerConfig } from "../src/config.js";

test("MCP configuration uses the existing environment-based approach", () => {
  const config = loadMcpServerConfig({
    PIRX_OBSIDIAN_VAULT: "/tmp/pirx-vault",
    PIRX_GOOGLE_CREDENTIALS_FILE: "/tmp/pirx-creds.json",
    PIRX_GOOGLE_TOKEN_FILE: "/tmp/pirx-token.json",
    PIRX_GOOGLE_CALENDAR_ID: "work@example.com",
    PIRX_GOOGLE_CALENDAR_TIMEZONE: "Europe/Warsaw",
    PIRX_GOOGLE_TIMEOUT_MS: "4321",
    PIRX_GOOGLE_AUTH_TIMEOUT_MS: "9876",
  });

  assert.equal(config.obsidianVaultPath, resolve("/tmp/pirx-vault"));
  assert.equal(config.googleCalendar.credentialsFile, resolve("/tmp/pirx-creds.json"));
  assert.equal(config.googleCalendar.tokenFile, resolve("/tmp/pirx-token.json"));
  assert.equal(config.googleCalendar.defaultCalendarId, "work@example.com");
  assert.equal(config.googleCalendar.defaultTimeZone, "Europe/Warsaw");
  assert.equal(config.googleCalendar.requestTimeoutMs, 4_321);
  assert.equal(config.googleCalendar.authorizationTimeoutMs, 9_876);
});

test("MCP configuration rejects invalid timeouts and timezones", () => {
  assert.throws(
    () => loadMcpServerConfig({ PIRX_GOOGLE_TIMEOUT_MS: "0" }),
    /positive integer/u,
  );
  assert.throws(
    () =>
      loadMcpServerConfig({
        PIRX_GOOGLE_CALENDAR_TIMEZONE: "Not/A_Real_Timezone",
      }),
    /valid IANA timezone/u,
  );
});
