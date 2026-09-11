import assert from "node:assert/strict";
import test from "node:test";

import {
  failure,
  GitHubIssueReader,
  type GitHubIssueReadTransport,
  type GitHubOperationResult,
  type GitHubRequestContext,
  type GitHubResponseMetadata,
} from "../src/index.js";
import type { GitHubGraphqlReadRequest, GitHubRestReadRequest } from "../src/transport-types.js";

const config = { owner: "PiotrGry", repository: "ai-assistant" } as const;
const metadata: GitHubResponseMetadata = { status: 200, rateLimit: {} };

function success<T>(value: T, correlationId = "issue-correlation", response = metadata): GitHubOperationResult<T> {
  return { outcome: "success", value, correlationId, remoteOutcome: "accepted", response };
}

function restIssue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    node_id: `node-${number}`,
    number,
    html_url: `https://github.com/PiotrGry/ai-assistant/issues/${number}`,
    title: `Issue ${number}`,
    body: number === 2 ? null : `Body ${number}`,
    state: "open",
    user: { login: "piotr" },
    labels: [{ name: number === 1 ? "github" : "pirx", color: "0366d6" }],
    assignees: [{ login: "worker" }],
    milestone: { number: 1, title: "M1", state: "open" },
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-02T10:00:00Z",
    closed_at: null,
    ...overrides,
  };
}

function graphqlIssue(number: number): Record<string, unknown> {
  return {
    id: `node-${number}`,
    number,
    url: `https://github.com/PiotrGry/ai-assistant/issues/${number}`,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state: "OPEN",
    author: { login: "piotr" },
    labels: { nodes: [{ name: "github", color: "0366d6" }] },
    assignees: { nodes: [{ login: "worker" }] },
    milestone: { number: 1, title: "M1", state: "OPEN" },
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    closedAt: null,
  };
}

class FakeIssueTransport implements GitHubIssueReadTransport {
  readonly restCalls: Array<{ request: GitHubRestReadRequest; context: GitHubRequestContext }> = [];
  readonly graphqlCalls: Array<{ request: GitHubGraphqlReadRequest; context: GitHubRequestContext }> = [];
  restHandler: (request: GitHubRestReadRequest, context: GitHubRequestContext) => Promise<GitHubOperationResult<unknown>> = async () => success([]);
  graphqlHandler: (request: GitHubGraphqlReadRequest, context: GitHubRequestContext) => Promise<GitHubOperationResult<unknown>> = async () => success({});

  async restRead<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    this.restCalls.push({ request, context });
    return await this.restHandler(request, context) as GitHubOperationResult<T>;
  }

  async graphqlRead<T>(request: GitHubGraphqlReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    this.graphqlCalls.push({ request, context });
    return await this.graphqlHandler(request, context) as GitHubOperationResult<T>;
  }
}

function noRetry() {
  return { maxAttempts: 1, sleep: async () => undefined } as const;
}

test("getIssue maps REST data and omits nullable fields without exposing raw payloads", async () => {
  const transport = new FakeIssueTransport();
  transport.restHandler = async () => success(restIssue(48, { body: null, milestone: null, assignees: [] }), "get-48");
  const reader = new GitHubIssueReader(transport, config);
  const result = await reader.getIssue(48, { correlationId: "get-48" });

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") return;
  assert.deepEqual(result.value, {
    owner: "PiotrGry",
    repository: "ai-assistant",
    nodeId: "node-48",
    number: 48,
    url: "https://github.com/PiotrGry/ai-assistant/issues/48",
    title: "Issue 48",
    state: "open",
    author: { login: "piotr" },
    labels: [{ name: "pirx", color: "0366d6" }],
    assignees: [],
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
  });
  assert.match(transport.restCalls[0]?.request.path ?? "", /issues\/48$/u);
});

test("listIssues follows REST pagination, filters pull requests, and respects an exact result bound", async () => {
  const transport = new FakeIssueTransport();
  transport.restHandler = async (request) => {
    const page = request.query?.page;
    if (page === 1) {
      return success([restIssue(1), restIssue(2, { pull_request: { url: "pr" } })], "list", {
        status: 200,
        rateLimit: {},
        pagination: { next: "https://api.github.test/repos/PiotrGry/ai-assistant/issues?page=2" },
      });
    }
    return success([restIssue(3)], "list");
  };
  const reader = new GitHubIssueReader(transport, config, { defaultPageSize: 2, defaultMaxItems: 3 });
  const result = await reader.listIssues(
    { state: "all", labels: ["github", "pirx"], milestone: "none", sort: "updated", direction: "desc" },
    { correlationId: "list", pageSize: 2, maxItems: 3 },
  );

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") return;
  assert.deepEqual(result.value.items.map((issue) => issue.number), [1, 3]);
  assert.equal(result.value.complete, true);
  assert.equal(transport.restCalls.length, 2);
  assert.deepEqual(transport.restCalls[0]?.request.query, {
    state: "all",
    labels: "github,pirx",
    milestone: "none",
    sort: "updated",
    direction: "desc",
    page: 1,
    per_page: 2,
  });
});

test("listIssues returns an opaque cursor when the caller's maximum is reached", async () => {
  const transport = new FakeIssueTransport();
  transport.restHandler = async () => success([restIssue(1), restIssue(2)], "bounded", {
    status: 200,
    rateLimit: {},
    pagination: { next: "https://api.github.test/repos/PiotrGry/ai-assistant/issues?page=2" },
  });
  const reader = new GitHubIssueReader(transport, config);
  const result = await reader.listIssues({}, { correlationId: "bounded", pageSize: 2, maxItems: 2 });
  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") return;
  assert.equal(result.value.complete, false);
  assert.match(result.value.nextCursor ?? "", /^v1:rest:[A-Za-z0-9_-]+$/u);
});

test("searchIssues uses a focused GraphQL query and follows cursor pagination", async () => {
  const transport = new FakeIssueTransport();
  transport.graphqlHandler = async (_request, _context) => {
    const call = transport.graphqlCalls.length;
    return call === 1
      ? success({ search: { nodes: [graphqlIssue(10)], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } }, "search")
      : success({ search: { nodes: [graphqlIssue(11)], pageInfo: { hasNextPage: false, endCursor: null } } }, "search");
  };
  const reader = new GitHubIssueReader(transport, config, { defaultPageSize: 1, defaultMaxItems: 2 });
  const result = await reader.searchIssues(
    { state: "open", labels: ["github"], milestone: 1, text: "rate limit", sort: "updated", direction: "asc" },
    { correlationId: "search", pageSize: 1, maxItems: 2 },
  );

  assert.equal(result.outcome, "success");
  if (result.outcome !== "success") return;
  assert.deepEqual(result.value.items.map((issue) => issue.number), [10, 11]);
  assert.equal(result.value.complete, true);
  assert.equal(transport.graphqlCalls.length, 2);
  const first = transport.graphqlCalls[0]?.request;
  assert.ok(first !== undefined);
  assert.match(first.query, /labels\(first: 100\)/u);
  assert.doesNotMatch(first.query, /comments|projectItems|history/u);
  assert.match(String(first.variables?.query), /repo:PiotrGry\/ai-assistant is:issue is:open label:"github" milestone:1 sort:updated-asc "rate limit"/u);
  assert.equal(first.variables?.after, undefined);
  assert.equal(transport.graphqlCalls[1]?.request.variables?.after, "cursor-1");
});

test("invalid filters and cursors fail before a network call", async () => {
  const transport = new FakeIssueTransport();
  const reader = new GitHubIssueReader(transport, config);
  const invalidFilter = await reader.listIssues({ state: "invalid" as never });
  const invalidCursor = await reader.searchIssues({}, { cursor: "v1:rest:MQ" });
  assert.equal(invalidFilter.outcome, "permanent_error");
  assert.equal(invalidCursor.outcome, "permanent_error");
  assert.equal(invalidFilter.error.code, "invalid_filter");
  assert.equal(invalidCursor.error.code, "invalid_cursor");
  assert.equal(transport.restCalls.length, 0);
  assert.equal(transport.graphqlCalls.length, 0);
});

test("a mid-pagination failure is partial and carries the failed cursor and items read", async () => {
  const transport = new FakeIssueTransport();
  transport.restHandler = async (request) => request.query?.page === 1
    ? success([restIssue(1)], "partial", { status: 200, rateLimit: {}, pagination: { next: "https://api.github.test/issues?page=2" } })
    : failure("rate_limited", "rate_limited", "limited", "partial", "not_accepted", { status: 429, rateLimit: { retryAfterMs: 1 } });
  const reader = new GitHubIssueReader(transport, config, { retryPolicy: noRetry(), defaultPageSize: 1, defaultMaxItems: 3 });
  const result = await reader.listIssues({}, { correlationId: "partial", pageSize: 1, maxItems: 3 });
  assert.equal(result.outcome, "rate_limited");
  assert.equal(result.error.details?.itemsRead, 1);
  assert.match(String(result.error.details?.failedCursor), /^v1:rest:/u);
});

test("read failures and cancellation preserve normalized outcomes", async () => {
  const transport = new FakeIssueTransport();
  transport.restHandler = async () => failure("permanent_error", "not_found", "GitHub resource was not found.", "read-failure", "not_accepted");
  const reader = new GitHubIssueReader(transport, config, { retryPolicy: noRetry() });
  const notFound = await reader.getIssue(999, { correlationId: "read-failure" });
  assert.equal(notFound.outcome, "permanent_error");
  assert.equal(notFound.error.code, "not_found");

  const controller = new AbortController();
  controller.abort();
  const cancelled = await reader.getIssue(1, { correlationId: "cancelled", signal: controller.signal });
  assert.equal(cancelled.outcome, "permanent_error");
  assert.equal(cancelled.error.code, "cancelled");
});
