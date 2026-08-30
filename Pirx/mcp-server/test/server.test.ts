import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  CalendarError,
  type CalendarEvent,
  type CalendarEventFields,
  type CalendarEventUpdate,
  type CalendarOperations,
  type ListEventsOptions,
} from "../src/google-calendar/types.js";
import { ObsidianVault } from "../src/obsidian/vaults.js";
import { createMcpServer } from "../src/server.js";

const sampleEvent: CalendarEvent = {
  id: "event-1",
  summary: "Test event",
  start: "2026-08-30T10:00:00Z",
  end: "2026-08-30T11:00:00Z",
  allDay: false,
  timeZone: "UTC",
};

function fakeCalendar(): CalendarOperations {
  return {
    async listCalendars() {
      return [{ id: "primary", summary: "Primary", primary: true, timeZone: "UTC" }];
    },
    async listEvents(_options: ListEventsOptions) {
      throw new CalendarError("rate_limited", "Synthetic rate limit for regression test.");
    },
    async getEvent(_calendarId: string | undefined, _eventId: string) {
      return sampleEvent;
    },
    async createEvent(
      _calendarId: string | undefined,
      _event: CalendarEventFields,
    ) {
      return sampleEvent;
    },
    async updateEvent(
      _calendarId: string | undefined,
      _eventId: string,
      _update: CalendarEventUpdate,
    ) {
      return sampleEvent;
    },
    async deleteEvent(_calendarId: string | undefined, _eventId: string) {},
  };
}

async function connectedServer() {
  const root = await mkdtemp(join(tmpdir(), "pirx-server-vault-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    environment: {},
    obsidianVault: new ObsidianVault(root),
    calendar: fakeCalendar(),
  });
  const client = new Client({ name: "pirx-test", version: "0.1.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { root, server, client };
}

test("server exposes complete tools with safe annotations", async (context) => {
  const fixture = await connectedServer();
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const listed = await fixture.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [
      "calendar_create_event",
      "calendar_delete_event",
      "calendar_get_event",
      "calendar_list_calendars",
      "calendar_list_events",
      "calendar_update_event",
      "hello",
      "obsidian_add_link",
      "obsidian_append",
      "obsidian_backlinks",
      "obsidian_create",
      "obsidian_delete",
      "obsidian_links",
      "obsidian_list",
      "obsidian_move",
      "obsidian_read",
      "obsidian_search",
      "obsidian_write",
      "system_info",
    ],
  );

  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("calendar_list_events")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("calendar_list_events")?.annotations?.idempotentHint, true);
  assert.equal(byName.get("calendar_create_event")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("calendar_create_event")?.annotations?.idempotentHint, false);
  assert.equal(byName.get("calendar_delete_event")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("obsidian_read")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("obsidian_write")?.annotations?.destructiveHint, true);
  assert.match(byName.get("calendar_get_event")?.description ?? "", /current external state/u);
  assert.match(byName.get("obsidian_read")?.description ?? "", /current external state/u);
});

test("a failed Calendar tool does not kill MCP and a later call succeeds", async (context) => {
  const fixture = await connectedServer();
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const failure = await fixture.client.callTool({
    name: "calendar_list_events",
    arguments: {},
  });
  assert.equal(failure.isError, true);
  assert.match(JSON.stringify(failure.content), /Synthetic rate limit/u);

  const success = await fixture.client.callTool({
    name: "calendar_list_calendars",
    arguments: {},
  });
  assert.notEqual(success.isError, true);
  assert.deepEqual(success.structuredContent, {
    calendars: [{ id: "primary", summary: "Primary", primary: true, timeZone: "UTC" }],
  });
});

test("an unsafe Obsidian call is controlled and hello still works", async (context) => {
  const fixture = await connectedServer();
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const failure = await fixture.client.callTool({
    name: "obsidian_read",
    arguments: { path: "../../etc/passwd" },
  });
  assert.equal(failure.isError, true);

  const hello = await fixture.client.callTool({
    name: "hello",
    arguments: { name: "Piotr" },
  });
  assert.notEqual(hello.isError, true);
  assert.deepEqual(hello.structuredContent, { greeting: "Hello, Piotr!" });
});

test("missing integration configuration does not prevent MCP startup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-missing-config-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    environment: {
      PIRX_GOOGLE_CREDENTIALS_FILE: join(root, "missing-credentials.json"),
      PIRX_GOOGLE_TOKEN_FILE: join(root, "missing-token.json"),
      PIRX_GOOGLE_CALENDAR_TIMEZONE: "UTC",
    },
  });
  const client = new Client({ name: "pirx-config-test", version: "0.1.0" });
  context.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const obsidian = await client.callTool({
    name: "obsidian_list",
    arguments: {},
  });
  assert.equal(obsidian.isError, true);
  assert.match(JSON.stringify(obsidian.content), /PIRX_OBSIDIAN_VAULT/u);

  const calendar = await client.callTool({
    name: "calendar_list_calendars",
    arguments: {},
  });
  assert.equal(calendar.isError, true);
  assert.match(JSON.stringify(calendar.content), /not authorized/u);

  const hello = await client.callTool({
    name: "hello",
    arguments: { name: "still-alive" },
  });
  assert.notEqual(hello.isError, true);
});
