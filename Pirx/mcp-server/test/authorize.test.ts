import assert from "node:assert/strict";
import test from "node:test";

import { openBrowser, parseAuthorizationCallback } from "../src/google-calendar/authorize.js";

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

test("parses a callback URL pasted from a browser", () => {
  assert.equal(
    parseAuthorizationCallback(
      "http://127.0.0.1:1234/oauth2/callback?state=expected&code=authorization-code&iss=https%3A%2F%2Faccounts.google.com",
      "expected",
    ),
    "authorization-code",
  );
});

test("rejects a pasted callback URL with a different OAuth state", () => {
  assert.throws(
    () => parseAuthorizationCallback(
      "http://127.0.0.1:1234/oauth2/callback?state=wrong&code=authorization-code",
      "expected",
    ),
    /state did not match/u,
  );
});
