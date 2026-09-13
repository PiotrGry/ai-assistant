import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  failure,
  type GitHubConfig,
  type GitHubOperationResult,
} from "@pirx/orchestrator";

import { createMcpServer, type GitHubPocTransport } from "../src/server.js";
import { createHostAuthorization, HOST_AUTHORIZATION_META_KEY } from "../src/authorization.js";

const authorizationSecret = "mcp-test-authorization-secret";

const githubConfig: GitHubConfig = {
  token: "secret-token-that-must-not-leak",
  owner: "PiotrGry",
  repository: "ai-assistant",
  projectOwner: "PiotrGry",
  projectNumber: 3,
  apiUrl: "https://api.github.test",
  timeoutMs: 1_000,
};

function issuePayload() {
  return {
    node_id: "I_kwDOtest",
    number: 179,
    html_url: "https://github.com/PiotrGry/ai-assistant/issues/179",
    title: "[POC TEST] GitHub Issue lifecycle sandbox",
    body: "controlled sandbox",
    state: "open",
    user: { login: "PiotrGry" },
    labels: [{ name: "poc-test", color: "5319E7" }],
    assignees: [],
    milestone: null,
    created_at: "2026-09-11T09:00:00Z",
    updated_at: "2026-09-11T09:00:00Z",
    closed_at: null,
  };
}

function success<T>(value: T, correlationId: string): GitHubOperationResult<T> {
  return {
    outcome: "success",
    value,
    correlationId,
    remoteOutcome: "accepted",
  };
}

class FakeGitHubTransport implements GitHubPocTransport {
  readonly writes: unknown[] = [];
  readonly comments: Array<Record<string, unknown>> = [];
  failureResult: GitHubOperationResult<unknown> | undefined;
  largeBody = false;

  async restRead<T>(request: { path: string }, context: { correlationId: string }): Promise<GitHubOperationResult<T>> {
    if (this.failureResult !== undefined) {
      return this.failureResult as GitHubOperationResult<T>;
    }
    if (request.path.endsWith("/comments")) {
      return success(this.comments, context.correlationId) as GitHubOperationResult<T>;
    }
    if (request.path.endsWith("/issues")) {
      return success([this.payload()], context.correlationId) as GitHubOperationResult<T>;
    }
    return success(this.payload(), context.correlationId) as GitHubOperationResult<T>;
  }

  private payload() {
    return this.largeBody
      ? { ...issuePayload(), body: "x".repeat(20_000) }
      : issuePayload();
  }

  async restWrite<T>(request: { path: string; body?: unknown }, context: { correlationId: string }): Promise<GitHubOperationResult<T>> {
    this.writes.push(request.body);
    if (!request.path.endsWith("/comments")) {
      return success(issuePayload(), context.correlationId) as GitHubOperationResult<T>;
    }
    const comment = {
      id: 9001,
      html_url: "https://github.com/PiotrGry/ai-assistant/issues/179#issuecomment-9001",
      body: (request.body as { body: string }).body,
    };
    this.comments.push(comment);
    return success(comment, context.correlationId) as GitHubOperationResult<T>;
  }

  async graphqlRead<T>(request: { query?: string; variables?: { query?: string } }, context: { correlationId: string }): Promise<GitHubOperationResult<T>> {
    if (request.query?.includes("repository(") === true) {
      return success({ repository: { issues: { nodes: [] } } }, context.correlationId) as GitHubOperationResult<T>;
    }
    if (request.variables?.query?.includes("pirx-operation") === true) {
      return success({
        search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      }, context.correlationId) as GitHubOperationResult<T>;
    }
    return success({
      search: {
        nodes: [{
          id: "I_kwDOtest",
          number: 179,
          url: "https://github.com/PiotrGry/ai-assistant/issues/179",
          title: "[POC TEST] GitHub Issue lifecycle sandbox",
          body: "controlled sandbox",
          state: "OPEN",
          author: { login: "PiotrGry" },
          labels: { nodes: [{ name: "poc-test", color: "5319E7" }] },
          assignees: { nodes: [] },
          milestone: null,
          createdAt: "2026-09-11T09:00:00Z",
          updatedAt: "2026-09-11T09:00:00Z",
          closedAt: null,
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }, context.correlationId) as GitHubOperationResult<T>;
  }
}

async function connected(options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly transport?: GitHubPocTransport;
  readonly config?: GitHubConfig;
}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({
    environment: options.environment ?? {
      PIRX_GITHUB_POC_ISSUE: "179",
      PIRX_GOOGLE_CALENDAR_TIMEZONE: "UTC",
    },
    ...(options.transport === undefined ? {} : { githubPocTransport: options.transport }),
    ...(options.config === undefined ? {} : { githubPocConfig: options.config }),
    githubAuthorizationSecret: authorizationSecret,
  });
  const client = new Client({ name: "github-poc-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

async function callAuthorized(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
  operationId: string = randomUUID(),
  signedArguments: Record<string, unknown> = arguments_,
) {
  return client.callTool({
    name,
    arguments: arguments_,
    _meta: {
      [HOST_AUTHORIZATION_META_KEY]: createHostAuthorization(authorizationSecret, name, signedArguments, operationId),
    },
  });
}

test("GitHub POC is omitted when its fixed target is not configured", async (context) => {
  const fixture = await connected({ environment: { PIRX_GOOGLE_CALENDAR_TIMEZONE: "UTC" } });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const listed = await fixture.client.listTools();
  assert.equal(listed.tools.some((tool) => tool.name === "github_issue_round_trip_poc"), false);
});

test("repository-scoped Issue tools stay listed and name the missing GitHub configuration", async (context) => {
  const fixture = await connected({ environment: { PIRX_GOOGLE_CALENDAR_TIMEZONE: "UTC" } });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const listed = await fixture.client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "github_issue_get"));

  const get = await fixture.client.callTool({
    name: "github_issue_get",
    arguments: { issueNumber: 179 },
  });
  assert.equal(get.isError, true);
  const content = get.structuredContent as { errorCode: string; message: string };
  assert.equal(content.errorCode, "configuration");
  assert.match(content.message, /PIRX_GITHUB_OWNER/u);
});

test("GitHub POC uses the fixed Issue and proves idempotent replay", async (context) => {
  const transport = new FakeGitHubTransport();
  const fixture = await connected({ transport, config: githubConfig });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const listed = await fixture.client.listTools();
  const tool = listed.tools.find((item) => item.name === "github_issue_round_trip_poc");
  assert.ok(tool);
  assert.match(tool.description ?? "", /fixed configured.*Issue/u);
  assert.equal(tool.annotations?.readOnlyHint, false);

  const result = await callAuthorized(fixture.client, "github_issue_round_trip_poc", {
    eventId: "mcp-test-event",
    summary: "Controlled MCP integration test.",
    correlationId: "mcp-test-correlation",
  }, "poc-operation-1");
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    outcome: "success",
    correlationId: "mcp-test-correlation",
    remoteOutcome: "accepted",
    issue: {
      owner: "PiotrGry",
      repository: "ai-assistant",
      nodeId: "I_kwDOtest",
      number: 179,
      url: "https://github.com/PiotrGry/ai-assistant/issues/179",
    },
    comment: {
      id: 9001,
      url: "https://github.com/PiotrGry/ai-assistant/issues/179#issuecomment-9001",
    },
    initialState: "open",
    verifiedState: "open",
    changed: true,
    replayed: true,
    replayNoOp: true,
    replayComment: {
      id: 9001,
      url: "https://github.com/PiotrGry/ai-assistant/issues/179#issuecomment-9001",
    },
  });
  assert.equal(transport.writes.length, 1);
  assert.equal(JSON.stringify(result).includes("secret-token"), false);

  const redirected = await callAuthorized(fixture.client, "github_issue_round_trip_poc", {
    eventId: "redirect-attempt",
    summary: "Should be rejected",
    issue: 1,
  });
  assert.equal(redirected.isError, true);
  assert.equal(transport.writes.length, 1);
});

test("repository-scoped Issue tools expose bounded reads and host-authorized mutations", async (context) => {
  const transport = new FakeGitHubTransport();
  const fixture = await connected({ transport, config: githubConfig });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const listed = await fixture.client.listTools();
  for (const name of [
    "github_issue_get",
    "github_issue_list",
    "github_issue_search",
    "github_issue_create",
    "github_issue_update",
    "github_issue_comment",
    "github_issue_close",
    "github_issue_reopen",
  ]) {
    assert.ok(listed.tools.some((tool) => tool.name === name), name);
  }
  assert.equal(listed.tools.find((tool) => tool.name === "github_issue_get")?.annotations?.readOnlyHint, true);
  assert.equal(listed.tools.find((tool) => tool.name === "github_issue_close")?.annotations?.destructiveHint, true);

  const get = await fixture.client.callTool({
    name: "github_issue_get",
    arguments: { issueNumber: 179, correlationId: "get-correlation" },
  });
  assert.equal(get.isError, undefined);
  assert.equal((get.structuredContent as { issue: { number: number } }).issue.number, 179);

  const list = await fixture.client.callTool({
    name: "github_issue_list",
    arguments: { state: "open", pageSize: 1, maxItems: 1 },
  });
  assert.equal(list.isError, undefined);
  assert.equal((list.structuredContent as { page: { items: unknown[] } }).page.items.length, 1);

  const search = await fixture.client.callTool({
    name: "github_issue_search",
    arguments: { text: "sandbox", maxItems: 1 },
  });
  assert.equal(search.isError, undefined);

  const denied = await fixture.client.callTool({
    name: "github_issue_create",
    arguments: { title: "Denied" },
  });
  assert.equal(denied.isError, true);
  assert.equal((denied.structuredContent as { errorCode: string }).errorCode, "authorization_required");
  assert.equal(transport.writes.length, 0);

  const spoofed = await callAuthorized(fixture.client, "github_issue_create", { title: "Different" }, "spoofed-operation", { title: "Original" });
  assert.equal(spoofed.isError, true);
  assert.equal((spoofed.structuredContent as { errorCode: string }).errorCode, "authorization_required");
  assert.equal(transport.writes.length, 0);

  const mutationCalls = [
    { name: "github_issue_create", arguments: { title: "Created" } },
    { name: "github_issue_update", arguments: { issueNumber: 179, title: "Updated" } },
    { name: "github_issue_comment", arguments: { issueNumber: 179, comment: "Authorized comment" } },
    { name: "github_issue_close", arguments: { issueNumber: 179 } },
    { name: "github_issue_reopen", arguments: { issueNumber: 179 } },
  ] as const;
  for (const call of mutationCalls) {
    const result = await callAuthorized(fixture.client, call.name, call.arguments);
    assert.notEqual(result.isError, true, call.name);
  }
  assert.equal(transport.writes.length, 4);

  const tooMany = await fixture.client.callTool({
    name: "github_issue_list",
    arguments: { maxItems: 101 },
  });
  assert.equal(tooMany.isError, true);

  const redirected = await fixture.client.callTool({
    name: "github_issue_get",
    arguments: { issueNumber: 179, repository: "other-owner/other-repository" },
  });
  assert.equal(redirected.isError, true);
});

test("Issue outputs bound large bodies without changing transport parity", async (context) => {
  const transport = new FakeGitHubTransport();
  transport.largeBody = true;
  const fixture = await connected({ transport, config: githubConfig });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const result = await fixture.client.callTool({
    name: "github_issue_get",
    arguments: { issueNumber: 179 },
  });
  assert.equal(result.isError, undefined);
  const issue = (result.structuredContent as { issue: { body?: string } }).issue;
  assert.ok(issue.body);
  assert.ok(issue.body.length <= 2_000);
  assert.match(issue.body, /body truncated by Pirx MCP/u);
  assert.equal(result.content?.[0]?.type, "text");
  assert.deepEqual(JSON.parse((result.content?.[0] as { text: string }).text), result.structuredContent);
});

test("GitHub POC maps normalized failures without exposing credentials", async (context) => {
  const transport = new FakeGitHubTransport();
  transport.failureResult = failure(
    "permanent_error",
    "forbidden",
    "GitHub rejected the operation with HTTP 403.",
    "failure-correlation",
    "not_accepted",
  );
  const fixture = await connected({ transport, config: githubConfig });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const result = await callAuthorized(fixture.client, "github_issue_round_trip_poc", {
    eventId: "failure-event", summary: "Failure mapping test",
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    outcome: "permanent_error",
    correlationId: "failure-correlation",
    remoteOutcome: "not_accepted",
    errorCode: "forbidden",
    message: "GitHub rejected the operation with HTTP 403.",
  });
  assert.equal(JSON.stringify(result).includes("secret-token"), false);
  assert.equal(transport.writes.length, 0);
});

test("GitHub POC rejects unsafe input before any GitHub write", async (context) => {
  const transport = new FakeGitHubTransport();
  const fixture = await connected({ transport, config: githubConfig });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const result = await callAuthorized(fixture.client, "github_issue_round_trip_poc", {
    eventId: "event-with-token=secret",
    summary: "Must be rejected",
  });
  assert.equal(result.isError, true);
  assert.equal(transport.writes.length, 0);
});

test("invalid GitHub POC configuration is controlled and does not break startup", async (context) => {
  const fixture = await connected({
    environment: {
      PIRX_GITHUB_POC_ISSUE: "not-an-issue",
      PIRX_GOOGLE_CALENDAR_TIMEZONE: "UTC",
    },
  });
  context.after(async () => {
    await fixture.client.close();
    await fixture.server.close();
  });

  const result = await fixture.client.callTool({
    name: "github_issue_round_trip_poc",
    arguments: { eventId: "invalid-config", summary: "Configuration test" },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /PIRX_GITHUB_POC_ISSUE/u);
});
