import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

test("agent configuration accepts the shared Google Calendar timezone", () => {
  const config = loadConfig({
    PIRX_GOOGLE_CALENDAR_TIMEZONE: "Europe/Warsaw",
  });

  assert.equal(config.timeZone, "Europe/Warsaw");
});

test("agent configuration rejects an invalid timezone before startup", () => {
  assert.throws(
    () =>
      loadConfig({
        PIRX_GOOGLE_CALENDAR_TIMEZONE: "Not/A_Real_Timezone",
      }),
    /prawidłową strefą IANA/u,
  );
});

test("agent configuration exposes explicit storage privacy modes", () => {
  assert.equal(loadConfig({}).storageMode, "full_local");
  assert.equal(
    loadConfig({ PIRX_STORAGE_MODE: "redacted" }).storageMode,
    "redacted",
  );
  assert.throws(
    () => loadConfig({ PIRX_STORAGE_MODE: "secret_dump" }),
    /PIRX_STORAGE_MODE musi być jednym z/u,
  );
});

test("agent configuration defaults to a context window with room for tool results", () => {
  assert.equal(loadConfig({}).numCtx, 32_768);
  assert.equal(loadConfig({ OLLAMA_NUM_CTX: "8192" }).numCtx, 8_192);
});

test("agent configuration enables the continuation check unless disabled", () => {
  assert.equal(loadConfig({}).continuationCheck, true);
  assert.equal(loadConfig({ PIRX_CONTINUATION_CHECK: "false" }).continuationCheck, false);
  assert.throws(
    () => loadConfig({ PIRX_CONTINUATION_CHECK: "maybe" }),
    /PIRX_CONTINUATION_CHECK/u,
  );
});
