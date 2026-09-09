import assert from "node:assert/strict";
import test from "node:test";

import { openBrowser } from "../src/google-calendar/authorize.js";

test("opens authorization URLs with the native command on macOS", async () => {
  let command: string | undefined;
  let arguments_: readonly string[] | undefined;
  await openBrowser("https://accounts.google.com/o/oauth2/v2/auth?state=test", {
    platform: "darwin",
    run: async (executable, args) => {
      command = executable;
      arguments_ = args;
    },
  });
  assert.equal(command, "open");
  assert.deepEqual(arguments_, [
    "https://accounts.google.com/o/oauth2/v2/auth?state=test",
  ]);
});

test("uses xdg-open on Linux and rejects unsafe URLs", async () => {
  let command: string | undefined;
  await openBrowser("https://accounts.google.com/auth", {
    platform: "linux",
    run: async (executable) => {
      command = executable;
    },
  });
  assert.equal(command, "xdg-open");
  await assert.rejects(
    () => openBrowser("http://127.0.0.1/callback"),
    /non-HTTPS authorization URL/u,
  );
});
