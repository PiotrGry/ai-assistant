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
