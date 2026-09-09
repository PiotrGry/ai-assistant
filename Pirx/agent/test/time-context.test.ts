import assert from "node:assert/strict";
import test from "node:test";

import {
  currentTimeContext,
  currentTimeSystemContext,
} from "../src/time-context.js";

test("current time context represents the configured local day and offset", () => {
  const context = currentTimeContext(
    new Date("2026-08-30T22:30:45.123Z"),
    "Europe/Warsaw",
  );

  assert.deepEqual(context, {
    instantUtc: "2026-08-30T22:30:45.123Z",
    localDate: "2026-08-31",
    localTime: "00:30:45",
    localDateTime: "2026-08-31T00:30:45+02:00",
    timeZone: "Europe/Warsaw",
    utcOffset: "+02:00",
  });
});

test("current time context follows the Europe/Warsaw DST transition", () => {
  const before = currentTimeContext(
    new Date("2026-03-29T00:30:00.000Z"),
    "Europe/Warsaw",
  );
  const after = currentTimeContext(
    new Date("2026-03-29T01:30:00.000Z"),
    "Europe/Warsaw",
  );

  assert.equal(before.localDateTime, "2026-03-29T01:30:00+01:00");
  assert.equal(after.localDateTime, "2026-03-29T03:30:00+02:00");
});

test("system context is concise and explicit about relative dates", () => {
  const context = currentTimeSystemContext(
    new Date("2026-08-30T12:00:00.000Z"),
    "Europe/Warsaw",
  );

  assert.match(context, /2026-08-30T14:00:00\+02:00/u);
  assert.match(context, /Europe\/Warsaw/u);
  assert.match(context, /"dzisiaj", "jutro"/u);
});
