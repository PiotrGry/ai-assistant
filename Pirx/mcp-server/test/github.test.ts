import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  failure,
  type GitHubConfig,
  type GitHubOperationResult,
} from "@pirx/orchestrator";

import { createMcpServer, type GitHubPocTransport } from "../src/server.js";

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

  async restRead<T>(request: { path: string }, context: { correlationId: string }): Promise<GitHubOperationResult<T>> {
    if (this.failureResult !== undefined) {
      return this.failureResult as GitHubOperationResult<T>;
    }
    if (request.path.endsWith("/comments")) {
      return success(this.comments, context.correlationId) as GitHubOperationResult<T>;
    }
    return success(issuePayload(), context.correlationId) as GitHubOperationResult<T>;
  }

  async restWrite<T>(request: { body?: unknown }, context: { correlationId: string }): Promise<GitHubOperationResult<T>> {
    this.writes.push(request.body);
    const comment = {
      id: 9001,
      html_url: "https://github.com/PiotrGry/ai-assistant/issues/179#issuecomment-9001",
      body: (request.body as { body: string }).body,
    };
    this.comments.push(comment);
    return success(comment, context.correlationId) as GitHubOperationResult<T>;
  }

  async graphqlRead<T>(_request: unknown, context: { correlationId: string }): Promise<GitHubOperationResult<T>> {
    return success({ data: { search: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }, context.correlationId) as GitHubOperationResult<T>;
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
  });
  const client = new Client({ name: "github-poc-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
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

  const result = await fixture.client.callTool({
    name: "github_issue_round_trip_poc",
    arguments: {
      eventId: "mcp-test-event",
      summary: "Controlled MCP integration test.",
      correlationId: "mcp-test-correlation",
    },
  });
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

  const redirected = await fixture.client.callTool({
    name: "github_issue_round_trip_poc",
    arguments: {
      eventId: "redirect-attempt",
      summary: "Should be rejected",
      issue: 1,
    },
  });
  assert.equal(redirected.isError, true);
  assert.equal(transport.writes.length, 1);
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

  const result = await fixture.client.callTool({
    name: "github_issue_round_trip_poc",
    arguments: { eventId: "failure-event", summary: "Failure mapping test" },
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

  const result = await fixture.client.callTool({
    name: "github_issue_round_trip_poc",
    arguments: {
      eventId: "event-with-token=secret",
      summary: "Must be rejected",
    },
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
