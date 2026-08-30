import assert from "node:assert/strict";
import test from "node:test";

import type { GoogleCalendarConfig } from "../src/config.js";
import type { AccessTokenProvider, FetchLike } from "../src/google-calendar/auth.js";
import { GoogleCalendarClient } from "../src/google-calendar/client.js";
import { CalendarError } from "../src/google-calendar/types.js";

const config: GoogleCalendarConfig = {
  credentialsFile: "/unused/credentials.json",
  tokenFile: "/unused/token.json",
  defaultCalendarId: "primary",
  defaultTimeZone: "Europe/Warsaw",
  requestTimeoutMs: 50,
  authorizationTimeoutMs: 1_000,
};

const tokenProvider: AccessTokenProvider = {
  async getAccessToken() {
    return "test-access-token";
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function event(
  id: string,
  start: Record<string, string>,
  end: Record<string, string>,
  summary = id,
): unknown {
  return { id, summary, start, end, status: "confirmed" };
}

test("listCalendars returns concise entries and follows bounded pagination", async () => {
  const urls: URL[] = [];
  const responses = [
    jsonResponse({
      items: [{ id: "primary", summary: "Main", primary: true, timeZone: "Europe/Warsaw" }],
      nextPageToken: "next",
    }),
    jsonResponse({ items: [{ id: "work", summary: "Work", accessRole: "writer" }] }),
  ];
  const fetch: FetchLike = async (input) => {
    urls.push(new URL(input));
    const response = responses.shift();
    assert.ok(response !== undefined);
    return response;
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  assert.deepEqual(await client.listCalendars(), [
    { id: "primary", summary: "Main", primary: true, timeZone: "Europe/Warsaw" },
    { id: "work", summary: "Work", accessRole: "writer" },
  ]);
  assert.equal(urls.length, 2);
  assert.equal(urls[1]?.searchParams.get("pageToken"), "next");
});

test("listEvents sends the requested range and returns timed/all-day events chronologically", async () => {
  let requested: URL | undefined;
  const fetch: FetchLike = async (input) => {
    requested = new URL(input);
    return jsonResponse({
      items: [
        event("later", { dateTime: "2026-03-29T10:00:00+02:00", timeZone: "Europe/Warsaw" }, { dateTime: "2026-03-29T11:00:00+02:00", timeZone: "Europe/Warsaw" }),
        event("all-day", { date: "2026-03-28" }, { date: "2026-03-29" }),
      ],
    });
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });
  const events = await client.listEvents({
    calendarId: "work@example.com",
    timeMin: "2026-03-28T00:00:00+01:00",
    timeMax: "2026-03-30T00:00:00+02:00",
    maxResults: 25,
  });

  assert.deepEqual(events.map((item) => item.id), ["all-day", "later"]);
  assert.equal(events[0]?.allDay, true);
  assert.equal(events[1]?.timeZone, "Europe/Warsaw");
  assert.ok(requested !== undefined);
  assert.match(requested.pathname, /work%40example\.com\/events$/u);
  assert.equal(requested.searchParams.get("orderBy"), "startTime");
  assert.equal(requested.searchParams.get("singleEvents"), "true");
  assert.equal(requested.searchParams.get("timeMin"), "2026-03-28T00:00:00+01:00");
  assert.equal(requested.searchParams.get("timeZone"), "Europe/Warsaw");
});

test("getEvent uses an explicit event ID", async () => {
  let requested: URL | undefined;
  const fetch: FetchLike = async (input) => {
    requested = new URL(input);
    return jsonResponse(
      event(
        "event/id",
        { dateTime: "2026-08-30T10:00:00Z" },
        { dateTime: "2026-08-30T11:00:00Z" },
        "Meeting",
      ),
    );
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  assert.equal((await client.getEvent("primary", "event/id")).summary, "Meeting");
  assert.ok(requested !== undefined);
  assert.match(requested.pathname, /events\/event%2Fid$/u);
});

test("createEvent preserves explicit DST offsets and performs exactly one POST", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch: FetchLike = async (input, init = {}) => {
    requests.push({ url: new URL(input), init });
    return jsonResponse(
      event(
        "created",
        { dateTime: "2026-03-29T01:30:00+01:00", timeZone: "Europe/Warsaw" },
        { dateTime: "2026-03-29T03:30:00+02:00", timeZone: "Europe/Warsaw" },
        "DST meeting",
      ),
    );
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  const created = await client.createEvent(undefined, {
    summary: "DST meeting",
    start: "2026-03-29T01:30:00+01:00",
    end: "2026-03-29T03:30:00+02:00",
    timeZone: "Europe/Warsaw",
    attendees: ["person@example.com"],
  });

  assert.equal(created.id, "created");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), {
    summary: "DST meeting",
    start: { dateTime: "2026-03-29T01:30:00+01:00", timeZone: "Europe/Warsaw" },
    end: { dateTime: "2026-03-29T03:30:00+02:00", timeZone: "Europe/Warsaw" },
    attendees: [{ email: "person@example.com" }],
  });
});

test("createEvent represents all-day dates without injecting a timezone", async () => {
  let body: unknown;
  const fetch: FetchLike = async (_input, init = {}) => {
    body = JSON.parse(String(init.body)) as unknown;
    return jsonResponse(event("holiday", { date: "2026-12-24" }, { date: "2026-12-25" }));
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  const created = await client.createEvent(undefined, {
    summary: "Holiday",
    start: "2026-12-24",
    end: "2026-12-25",
  });
  assert.equal(created.allDay, true);
  assert.deepEqual(body, {
    summary: "Holiday",
    start: { date: "2026-12-24" },
    end: { date: "2026-12-25" },
  });
});

test("updateEvent PATCHes only supplied fields", async () => {
  let request: RequestInit | undefined;
  const fetch: FetchLike = async (_input, init = {}) => {
    request = init;
    return jsonResponse(
      event(
        "event-1",
        { dateTime: "2026-08-30T10:00:00Z" },
        { dateTime: "2026-08-30T11:00:00Z" },
        "Updated",
      ),
    );
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  await client.updateEvent(undefined, "event-1", { summary: "Updated", location: "" });
  assert.equal(request?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(request?.body)), { summary: "Updated", location: "" });
});

test("deleteEvent issues one DELETE for the requested event", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch: FetchLike = async (input, init = {}) => {
    requests.push({ url: new URL(input), init });
    return new Response(null, { status: 204 });
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  await client.deleteEvent("primary", "delete-me");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.init.method, "DELETE");
  assert.match(requests[0]?.url.pathname ?? "", /events\/delete-me$/u);
});

for (const [status, code] of [
  [401, "authentication"],
  [403, "forbidden"],
  [404, "not_found"],
  [429, "rate_limited"],
  [503, "unavailable"],
] as const) {
  test(`HTTP ${status} becomes a controlled ${code} error`, async () => {
    const fetch: FetchLike = async () =>
      jsonResponse({ error: { message: "controlled API failure" } }, status);
    const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

    await assert.rejects(
      () => client.getEvent(undefined, "event"),
      (error: unknown) =>
        error instanceof CalendarError && error.code === code && error.status === status,
    );
  });
}

test("network timeout is bounded and controlled", async () => {
  const timeoutConfig = { ...config, requestTimeoutMs: 5 };
  const fetch: FetchLike = async (_input, init = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
        once: true,
      });
    });
  const client = new GoogleCalendarClient(tokenProvider, timeoutConfig, { fetch });

  await assert.rejects(
    () => client.listCalendars(),
    (error: unknown) => error instanceof CalendarError && error.code === "timeout",
  );
});

test("malformed responses are rejected", async () => {
  const malformedJson: FetchLike = async () => new Response("not JSON", { status: 200 });
  const malformedShape: FetchLike = async () => jsonResponse({ items: "not-an-array" });

  await assert.rejects(
    () => new GoogleCalendarClient(tokenProvider, config, { fetch: malformedJson }).listCalendars(),
    (error: unknown) => error instanceof CalendarError && error.code === "malformed_response",
  );
  await assert.rejects(
    () => new GoogleCalendarClient(tokenProvider, config, { fetch: malformedShape }).listEvents({}),
    (error: unknown) => error instanceof CalendarError && error.code === "malformed_response",
  );
});

test("failed create requests are never retried", async () => {
  let attempts = 0;
  const fetch: FetchLike = async () => {
    attempts += 1;
    throw new Error("DNS unavailable");
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  await assert.rejects(
    () =>
      client.createEvent(undefined, {
        summary: "No duplicate",
        start: "2026-08-30T10:00:00Z",
        end: "2026-08-30T11:00:00Z",
      }),
    (error: unknown) => error instanceof CalendarError && error.code === "network",
  );
  assert.equal(attempts, 1);
});

test("event timing rejects mixed, reversed and timezone-less timed inputs", async () => {
  const fetch: FetchLike = async () => {
    assert.fail("invalid event input must fail before any network request");
  };
  const client = new GoogleCalendarClient(tokenProvider, config, { fetch });

  for (const input of [
    { summary: "Mixed", start: "2026-08-30", end: "2026-08-30T11:00:00Z" },
    { summary: "Reversed", start: "2026-08-30T11:00:00Z", end: "2026-08-30T10:00:00Z" },
    { summary: "Ambiguous", start: "2026-08-30T10:00:00", end: "2026-08-30T11:00:00" },
  ]) {
    await assert.rejects(
      () => client.createEvent(undefined, input),
      (error: unknown) => error instanceof CalendarError && error.code === "invalid_request",
    );
  }
});
