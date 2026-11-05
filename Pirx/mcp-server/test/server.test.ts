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
import { createHostAuthorization, HOST_AUTHORIZATION_META_KEY } from "../src/authorization.js";
import type { GitHubFailureHandoffPocGateway } from "@pirx/orchestrator";

const authorizationSecret = "calendar-obsidian-host-authorization";

const sampleEvent: CalendarEvent = {
  id: "event-1",
  summary: "Test event",
  start: "2026-08-30T10:00:00Z",
  end: "2026-08-30T11:00:00Z",
  allDay: false,
  timeZone: "UTC",
};

function fakeCalendar(createdEvents: CalendarEventFields[] = []): CalendarOperations {
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
      createdEvents.push(_event);
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
  const calendarCreates: CalendarEventFields[] = [];
  const server = createMcpServer({
    environment: {},
    obsidianVault: new ObsidianVault(root),
    calendar: fakeCalendar(calendarCreates),
    authorizationSecret,
  });
  const client = new Client({ name: "pirx-test", version: "0.1.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { root, server, client, calendarCreates };
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
      "github_actions_watch",
      "github_issue_close",
      "github_issue_comment",
      "github_issue_create",
      "github_issue_get",
      "github_issue_list",
      "github_issue_reopen",
      "github_issue_search",
      "github_issue_update",
      "hello",
      "obsidian_add_link",
      "obsidian_append",
      "obsidian_backlinks",
      "obsidian_create",
      "obsidian_delete",
      "obsidian_exists",
      "obsidian_links",
      "obsidian_list",
      "obsidian_move",
      "obsidian_read",
      "obsidian_search",
      "obsidian_write",
      "pirx_agent_conversation",
      "pirx_execution_report",
      "pirx_orchestrator_control",
      "pirx_orchestrator_diagnostic",
      "pirx_orchestrator_logs",
      "pirx_orchestrator_shutdown",
      "pirx_orchestrator_start",
      "pirx_orchestrator_status",
      "pirx_resource_report",
    "pirx_task_history",
      "system_info",
    ],
  );

  const byName = new Map(listed.tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("calendar_list_events")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("calendar_list_events")?.annotations?.idempotentHint, true);
  assert.equal(byName.get("calendar_create_event")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("calendar_create_event")?.annotations?.idempotentHint, false);
  assert.equal(byName.get("calendar_delete_event")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("github_actions_watch")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("github_actions_watch")?.annotations?.idempotentHint, true);
  assert.equal(byName.get("pirx_orchestrator_status")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("pirx_execution_report")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("pirx_execution_report")?.annotations?.idempotentHint, true);
  assert.equal(byName.get("pirx_resource_report")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("pirx_resource_report")?.annotations?.idempotentHint, true);
  assert.equal(byName.get("pirx_orchestrator_control")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("pirx_orchestrator_shutdown")?.annotations?.destructiveHint, true);
  assert.equal(byName.get("obsidian_read")?.annotations?.readOnlyHint, true);
  assert.equal(byName.get("obsidian_write")?.annotations?.destructiveHint, true);
  assert.match(byName.get("calendar_get_event")?.description ?? "", /current external state/u);
  assert.match(byName.get("obsidian_read")?.description ?? "", /current external state/u);
});

test("Calendar and Obsidian mutations require exact single-use host authorization while reads remain unchanged", async (context) => {
  const fixture = await connectedServer();
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
  });

  const event = {
    summary: "Authorized event",
    start: "2026-11-06T10:00:00Z",
    end: "2026-11-06T11:00:00Z",
  };
  const missing = await fixture.client.callTool({ name: "calendar_create_event", arguments: event });
  assert.equal(missing.isError, true);
  assert.equal((missing.structuredContent as { outcome: string }).outcome, "authorization_required");
  assert.equal(fixture.calendarCreates.length, 0);

  const eventAuthorization = createHostAuthorization(authorizationSecret, "calendar_create_event", event, "calendar-attempt-1", "calendar-mutation");
  const legacy = await fixture.client.callTool({
    name: "calendar_create_event",
    arguments: event,
    _meta: { [HOST_AUTHORIZATION_META_KEY]: { ...eventAuthorization, version: 1 } },
  });
  assert.equal(legacy.isError, true);
  assert.equal((legacy.structuredContent as { outcome: string }).outcome, "authorization_required");
  const changed = await fixture.client.callTool({
    name: "calendar_create_event",
    arguments: { ...event, summary: "Changed after approval" },
    _meta: { [HOST_AUTHORIZATION_META_KEY]: eventAuthorization },
  });
  assert.equal(changed.isError, true);
  assert.equal((changed.structuredContent as { outcome: string }).outcome, "authorization_required");
  assert.equal(fixture.calendarCreates.length, 0);

  const created = await fixture.client.callTool({
    name: "calendar_create_event",
    arguments: event,
    _meta: { [HOST_AUTHORIZATION_META_KEY]: eventAuthorization },
  });
  assert.notEqual(created.isError, true);
  assert.equal(fixture.calendarCreates.length, 1);
  const replayed = await fixture.client.callTool({
    name: "calendar_create_event",
    arguments: event,
    _meta: { [HOST_AUTHORIZATION_META_KEY]: eventAuthorization },
  });
  assert.equal(replayed.isError, true);
  assert.equal((replayed.structuredContent as { outcome: string }).outcome, "authorization_replayed");
  assert.equal(fixture.calendarCreates.length, 1);

  const createNote = { path: "work/exact.md", content: "before" };
  const createNoteAuthorization = createHostAuthorization(authorizationSecret, "obsidian_create", createNote, "note-create-1", "note-create");
  const noteCreated = await fixture.client.callTool({
    name: "obsidian_create",
    arguments: createNote,
    _meta: { [HOST_AUTHORIZATION_META_KEY]: createNoteAuthorization },
  });
  assert.notEqual(noteCreated.isError, true);

  const writeNote = { path: "work/exact.md", content: "after" };
  const writeAuthorization = createHostAuthorization(authorizationSecret, "obsidian_write", writeNote, "note-write-1", "note-write");
  const changedTarget = await fixture.client.callTool({
    name: "obsidian_write",
    arguments: { ...writeNote, path: "work/other.md" },
    _meta: { [HOST_AUTHORIZATION_META_KEY]: writeAuthorization },
  });
  assert.equal(changedTarget.isError, true);
  assert.equal((changedTarget.structuredContent as { outcome: string }).outcome, "authorization_required");
  const written = await fixture.client.callTool({
    name: "obsidian_write",
    arguments: writeNote,
    _meta: { [HOST_AUTHORIZATION_META_KEY]: writeAuthorization },
  });
  assert.notEqual(written.isError, true);
  const writeReplay = await fixture.client.callTool({
    name: "obsidian_write",
    arguments: writeNote,
    _meta: { [HOST_AUTHORIZATION_META_KEY]: writeAuthorization },
  });
  assert.equal(writeReplay.isError, true);
  assert.equal((writeReplay.structuredContent as { outcome: string }).outcome, "authorization_replayed");

  const read = await fixture.client.callTool({ name: "obsidian_read", arguments: { path: "work/exact.md" } });
  assert.notEqual(read.isError, true);
  assert.deepEqual(read.structuredContent, { path: "work/exact.md", content: "after" });
  const calendarRead = await fixture.client.callTool({ name: "calendar_get_event", arguments: { eventId: "event-1" } });
  assert.notEqual(calendarRead.isError, true);
});

test("shipment POC is annotated as a mutating operation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-shipment-server-vault-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    environment: {},
    obsidianVault: new ObsidianVault(root),
    calendar: fakeCalendar(),
    githubShipmentPocConfig: { token: "test", owner: "PiotrGry", repository: "zdrovena-reconciliation", apiUrl: "https://api.github.com", timeoutMs: 100 },
    githubShipmentPocTransport: { async restRead() { throw new Error("not called while listing tools"); }, async restWrite() { throw new Error("not called while listing tools"); } },
  });
  const client = new Client({ name: "pirx-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const tool = listed.tools.find((item) => item.name === "github_shipment_round_trip_poc");
  assert.ok(tool);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, true);
});

test("durable shipment cycle is listed as a mutating operation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-shipment-cycle-server-vault-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    environment: { PIRX_GITHUB_SHIPMENT_CYCLE: "1" },
    obsidianVault: new ObsidianVault(root),
    calendar: fakeCalendar(),
    githubPocConfig: { token: "test", owner: "PiotrGry", repository: "ai-assistant", apiUrl: "https://api.github.com", timeoutMs: 100 },
    githubShipmentPocTransport: { async restRead() { throw new Error("not called while listing tools"); }, async restWrite() { throw new Error("not called while listing tools"); } },
  });
  const client = new Client({ name: "pirx-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const listed = await client.listTools();
  const tool = listed.tools.find((item) => item.name === "github_shipment_cycle");
  assert.ok(tool); assert.equal(tool.annotations?.readOnlyHint, false); assert.equal(tool.annotations?.destructiveHint, true); assert.equal(tool.annotations?.idempotentHint, true);
});

test("failed-CI handoff POC is listed as mutating and denies missing host authorization", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-failure-handoff-server-vault-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    environment: {},
    obsidianVault: new ObsidianVault(root),
    calendar: fakeCalendar(),
    githubFailureHandoffPocConfig: { token: "test", owner: "PiotrGry", repository: "zdrovena-reconciliation", apiUrl: "https://api.github.com", timeoutMs: 100 },
    githubFailureHandoffPocGateway: {} as GitHubFailureHandoffPocGateway,
  });
  const client = new Client({ name: "pirx-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  const listed = await client.listTools();
  const tool = listed.tools.find((item) => item.name === "github_failed_ci_codex_handoff_poc");
  assert.ok(tool);
  assert.equal(tool.annotations?.readOnlyHint, false);
  assert.equal(tool.annotations?.destructiveHint, true);
  const denied = await client.callTool({
    name: "github_failed_ci_codex_handoff_poc",
    arguments: { eventId: "event", headBranch: "pirx/poc-failure-test", expectedHeadSha: "abcdef1234567890", requiredWorkflowName: "Develop — Fast Gate" },
  });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied.structuredContent), /authorization_required/u);
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

test("invalid optional integration configuration does not prevent MCP startup", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pirx-missing-config-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    environment: {
      PIRX_OBSIDIAN_VAULT: join(root, "missing-vault"),
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
  assert.match(JSON.stringify(obsidian.content), /Obsidian note not found/u);

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
