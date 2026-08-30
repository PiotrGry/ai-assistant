import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GoogleCalendarConfig } from "../src/config.js";
import { GoogleOAuthTokenProvider, type FetchLike } from "../src/google-calendar/auth.js";
import { CalendarError } from "../src/google-calendar/types.js";

async function authFiles(): Promise<{
  root: string;
  config: GoogleCalendarConfig;
}> {
  const root = await mkdtemp(join(tmpdir(), "pirx-calendar-auth-"));
  const credentialsFile = join(root, "credentials.json");
  const tokenFile = join(root, "private", "token.json");
  await writeFile(
    credentialsFile,
    JSON.stringify({
      installed: {
        client_id: "client-id",
        client_secret: "client-secret",
        redirect_uris: ["http://127.0.0.1"],
      },
    }),
    "utf8",
  );
  return {
    root,
    config: {
      credentialsFile,
      tokenFile,
      defaultCalendarId: "primary",
      defaultTimeZone: "UTC",
      requestTimeoutMs: 50,
      authorizationTimeoutMs: 1_000,
    },
  };
}

test("expired access token is refreshed once and stored with mode 0600", async () => {
  const fixture = await authFiles();
  try {
    const tokenDirectory = join(fixture.root, "private");
    await mkdir(tokenDirectory, { recursive: true });
    await writeFile(
      fixture.config.tokenFile,
      JSON.stringify({
        access_token: "expired",
        refresh_token: "refresh-secret",
        expiry_date: 1,
      }),
      "utf8",
    );
    let requests = 0;
    const fetch: FetchLike = async (_input, init = {}) => {
      requests += 1;
      const body = String(init.body);
      assert.match(body, /grant_type=refresh_token/u);
      assert.match(body, /refresh_token=refresh-secret/u);
      return new Response(
        JSON.stringify({ access_token: "new-access", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      );
    };
    const provider = new GoogleOAuthTokenProvider(fixture.config, {
      fetch,
      now: () => 1_000_000,
    });

    assert.equal(await provider.getAccessToken(), "new-access");
    assert.equal(await provider.getAccessToken(), "new-access");
    assert.equal(requests, 1);
    assert.equal((await stat(fixture.config.tokenFile)).mode & 0o777, 0o600);
    const stored = JSON.parse(await readFile(fixture.config.tokenFile, "utf8")) as Record<string, unknown>;
    assert.equal(stored["refresh_token"], "refresh-secret");
    assert.equal(stored["access_token"], "new-access");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid refresh token becomes a controlled authentication error", async () => {
  const fixture = await authFiles();
  try {
    await mkdir(join(fixture.root, "private"), { recursive: true });
    await writeFile(
      fixture.config.tokenFile,
      JSON.stringify({ refresh_token: "invalid", expiry_date: 1 }),
      "utf8",
    );
    const fetch: FetchLike = async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const provider = new GoogleOAuthTokenProvider(fixture.config, { fetch });

    await assert.rejects(
      () => provider.getAccessToken(),
      (error: unknown) =>
        error instanceof CalendarError && error.code === "authentication",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
