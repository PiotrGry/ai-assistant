import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubConfigurationError,
  GitHubTransport,
  GitHubWriteQueue,
  executeWithGitHubRetry,
  loadGitHubConfig,
  type GitHubConfig,
  type GitHubFetch,
} from "../src/index.js";

const config: GitHubConfig = {
  token: "secret-token",
  owner: "PiotrGry",
  repository: "ai-assistant",
  projectOwner: "PiotrGry",
  projectNumber: 3,
  apiUrl: "https://api.github.test",
  timeoutMs: 100,
};

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorCode(result: { readonly outcome: string; readonly error?: { readonly code: string } }): string {
  assert.notEqual(result.outcome, "success");
  assert.ok(result.error !== undefined);
  return result.error.code;
}

test("loadGitHubConfig validates fields without exposing the token", () => {
  assert.throws(
    () => loadGitHubConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof GitHubConfigurationError);
      assert.match(error.message, /PIRX_GITHUB_OWNER/u);
      assert.doesNotMatch(error.message, /super-secret/u);
      return true;
    },
  );
  assert.deepEqual(
    loadGitHubConfig({
      PIRX_GITHUB_OWNER: "owner",
      PIRX_GITHUB_REPOSITORY: "repo",
      PIRX_GITHUB_PROJECT_OWNER: "owner",
      PIRX_GITHUB_PROJECT_NUMBER: "3",
      PIRX_GITHUB_TIMEOUT_MS: "2500",
    }, { tokenProvider: () => "token" }),
    { ...config, token: "token", owner: "owner", repository: "repo", projectOwner: "owner", timeoutMs: 2500, apiUrl: "https://api.github.com" },
  );
});

test("REST transport sends auth at the boundary and returns typed metadata", async () => {
  let requestUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const fetch: GitHubFetch = async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return response({ number: 48 }, 200, {
      "x-github-request-id": "request-1",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-remaining": "4999",
      "x-ratelimit-reset": "2000000000",
      "x-ratelimit-used": "1",
    });
  };
  const transport = new GitHubTransport(config, { fetch });
  const result = await transport.restRead<{ number: number }>(
    { method: "GET", path: "/repos/PiotrGry/ai-assistant/issues/48", query: { per_page: 1 } },
    { correlationId: "corr-1" },
  );

  assert.equal(result.outcome, "success");
  assert.equal(result.value.number, 48);
  assert.equal(result.response?.requestId, "request-1");
  assert.equal(result.response?.rateLimit.remaining, 4999);
  assert.equal(requestUrl?.toString(), "https://api.github.test/repos/PiotrGry/ai-assistant/issues/48?per_page=1");
  assert.equal((requestInit?.headers as Record<string, string>).authorization, "Bearer secret-token");
  assert.equal((requestInit?.headers as Record<string, string>)["x-pirx-correlation-id"], "corr-1");
});

test("GraphQL transport returns only data and never raw GraphQL errors", async () => {
  const fetch: GitHubFetch = async (_url, init) => {
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body)) as { query: string; variables?: unknown };
    assert.match(body.query, /query Issue/u);
    return response({ data: { repository: { name: "ai-assistant" } } });
  };
  const transport = new GitHubTransport(config, { fetch });
  const result = await transport.graphqlRead<{ repository: { name: string } }>(
    { query: "query Issue { repository { name } }", variables: { owner: "PiotrGry" } },
    { correlationId: "corr-graphql" },
  );
  assert.deepEqual(result.outcome === "success" ? result.value : undefined, { repository: { name: "ai-assistant" } });
});

test("transport maps authorization, target, rate-limit, and server statuses explicitly", async () => {
  const cases = [
    [401, "authentication", "permanent_error"],
    [403, "forbidden", "permanent_error"],
    [404, "not_found", "permanent_error"],
    [429, "rate_limited", "rate_limited"],
    [503, "retryable", "retryable_error"],
  ] as const;
  for (const [status, code, outcome] of cases) {
    const transport = new GitHubTransport(config, { fetch: async () => response({}, status) });
    const result = await transport.restRead<unknown>({ method: "GET", path: "/status" }, { correlationId: `status-${status}` });
    assert.equal(result.outcome, outcome);
    assert.equal(errorCode(result), code);
  }
});

test("GraphQL errors and malformed success bodies are sanitized", async () => {
  const graphql = new GitHubTransport(config, {
    fetch: async () => response({ errors: [{ message: "secret-token" }] }),
  });
  const graphqlResult = await graphql.graphqlRead<unknown>({ query: "query { viewer { login } }" }, { correlationId: "graphql-error" });
  assert.equal(errorCode(graphqlResult), "graphql_error");
  assert.doesNotMatch(JSON.stringify(graphqlResult), /secret-token/u);

  const malformed = new GitHubTransport(config, { fetch: async () => new Response("not-json", { status: 200 }) });
  const malformedResult = await malformed.restRead<unknown>({ method: "GET", path: "/malformed" }, { correlationId: "malformed" });
  assert.equal(errorCode(malformedResult), "malformed_response");
});

test("transport parses Retry-After HTTP-date metadata", async () => {
  const retryAt = new Date(Date.now() + 2_000).toUTCString();
  const transport = new GitHubTransport(config, {
    fetch: async () => response({}, 429, { "retry-after": retryAt }),
  });
  const result = await transport.restRead<unknown>({ method: "GET", path: "/date-rate" }, { correlationId: "date-rate" });
  const delay = result.response?.rateLimit.retryAfterMs;
  assert.ok(delay !== undefined && delay > 0 && delay <= 2_000);
});

test("transport normalizes rate limits and avoids leaking response bodies", async () => {
  const fetch: GitHubFetch = async () => response({ message: "secret-token should not escape" }, 429, {
    "retry-after": "2",
    "x-ratelimit-remaining": "0",
  });
  const transport = new GitHubTransport(config, { fetch });
  const result = await transport.restRead<unknown>({ method: "GET", path: "/rate" }, { correlationId: "corr-rate" });
  assert.equal(result.outcome, "rate_limited");
  assert.equal(result.error.code, "rate_limited");
  assert.equal(result.response?.rateLimit.retryAfterMs, 2000);
  assert.doesNotMatch(JSON.stringify(result), /secret-token/u);
});

test("transport reports malformed rate-limit headers without exposing them as zero", async () => {
  const fetch: GitHubFetch = async () => response({ ok: true }, 429, {
    "retry-after": "not-a-delay",
    "x-ratelimit-reset": "not-a-timestamp",
    "x-ratelimit-remaining": "NaN",
  });
  const transport = new GitHubTransport(config, { fetch });
  const result = await transport.restRead<unknown>({ method: "GET", path: "/rate" }, { correlationId: "corr-malformed" });
  assert.deepEqual(result.response?.rateLimit.warnings, ["malformed_reset", "malformed_retry_after", "malformed_counter"]);
  assert.equal(result.response?.rateLimit.remaining, undefined);
});

test("transport distinguishes cancellation, retryable reads, and uncertain writes", async () => {
  const abortError = new DOMException("aborted", "AbortError");
  const fetch: GitHubFetch = async (_url, init) => {
    await new Promise<void>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(abortError), { once: true });
    });
    throw abortError;
  };
  const transport = new GitHubTransport(config, { fetch });
  const readController = new AbortController();
  const readPromise = transport.restRead<unknown>({ method: "GET", path: "/slow" }, { correlationId: "read", signal: readController.signal });
  readController.abort();
  const read = await readPromise;
  assert.equal(read.outcome, "permanent_error");
  assert.equal(read.error.code, "cancelled");

  const write = await transport.restWrite<unknown>({ method: "POST", path: "/mutation", body: { value: 1 } }, { correlationId: "write", timeoutMs: 5 });
  assert.equal(write.outcome, "unknown");
  assert.equal(write.error.code, "timeout");
});

test("write queue serializes FIFO work and replays the same completed result", async () => {
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const queue = new GitHubWriteQueue({ capacity: 2, correlationIdFactory: (() => { let n = 0; return () => `q-${++n}`; })() });
  const first = queue.submit({
    operationKind: "update_issue",
    idempotencyKey: "issue-48-title",
    target: "issue:48",
    timeoutMs: 1_000,
    payloadIdentity: "title:v1",
    execute: async ({ correlationId }) => {
      events.push(`start:${correlationId}`);
      await firstGate;
      events.push("finish:first");
      return { outcome: "success", value: "first", correlationId, remoteOutcome: "accepted" } as const;
    },
  });
  const duplicate = queue.submit({
    operationKind: "update_issue",
    idempotencyKey: "issue-48-title",
    target: "issue:48",
    timeoutMs: 1_000,
    payloadIdentity: "title:v1",
    execute: async () => { throw new Error("duplicate must not execute"); },
  });
  const second = queue.submit({
    operationKind: "update_issue",
    idempotencyKey: "issue-48-body",
    target: "issue:48",
    timeoutMs: 1_000,
    execute: async ({ correlationId }) => {
      events.push("second");
      return { outcome: "success", value: "second", correlationId, remoteOutcome: "accepted" } as const;
    },
  });
  const overflow = queue.submit({
    operationKind: "update_issue",
    idempotencyKey: "issue-48-labels",
    target: "issue:48",
    timeoutMs: 1_000,
    execute: async () => { throw new Error("overflow must not execute"); },
  });
  assert.equal(errorCode(await overflow), "queue_full");
  releaseFirst?.();
  const [firstResult, duplicateResult, secondResult] = await Promise.all([first, duplicate, second]);
  assert.equal(firstResult.correlationId, duplicateResult.correlationId);
  assert.equal(secondResult.outcome, "success");
  assert.deepEqual(events, ["start:q-1", "finish:first", "second"]);
  await queue.close();
});

test("write queue reports duplicate conflicts, isolates failures, and rejects after shutdown", async () => {
  const queue = new GitHubWriteQueue({ correlationIdFactory: () => "queue-correlation" });
  const failed = await queue.submit({
    operationKind: "delete_issue",
    idempotencyKey: "delete:1",
    target: "issue:1",
    timeoutMs: 100,
    payloadIdentity: "v1",
    execute: async () => { throw new Error("network"); },
  });
  assert.equal(failed.outcome, "unknown");
  assert.equal(errorCode(failed), "network");
  const conflict = await queue.submit({
    operationKind: "delete_issue",
    idempotencyKey: "delete:1",
    target: "issue:1",
    timeoutMs: 100,
    payloadIdentity: "v2",
    execute: async () => { throw new Error("conflict must not execute"); },
  });
  assert.equal(errorCode(conflict), "duplicate_conflict");
  await queue.close();
  const closed = await queue.submit({
    operationKind: "delete_issue",
    idempotencyKey: "delete:2",
    target: "issue:2",
    timeoutMs: 100,
    execute: async () => { throw new Error("closed must not execute"); },
  });
  assert.equal(errorCode(closed), "shutdown");
});

test("write queue can use the shared bounded retry policy for explicitly idempotent writes", async () => {
  const queue = new GitHubWriteQueue();
  let attempts = 0;
  const result = await queue.submit({
    operationKind: "add_label",
    idempotencyKey: "label:1",
    target: "issue:48",
    timeoutMs: 100,
    idempotent: true,
    retryPolicy: { maxAttempts: 2, maxTotalDelayMs: 1, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0, sleep: async () => undefined },
    execute: async ({ correlationId }) => {
      attempts += 1;
      return attempts === 1
        ? { outcome: "retryable_error", correlationId, remoteOutcome: "not_accepted", error: { code: "retryable", message: "temporary" } } as const
        : { outcome: "success", value: true, correlationId, remoteOutcome: "accepted" } as const;
    },
  });
  assert.equal(result.outcome, "success");
  assert.equal(attempts, 2);
  await queue.close();
});

test("write queue drain mode finishes accepted work before closing", async () => {
  const queue = new GitHubWriteQueue();
  const result = queue.submit({
    operationKind: "create_issue",
    idempotencyKey: "create:1",
    target: "repo",
    timeoutMs: 100,
    execute: async ({ correlationId }) => ({ outcome: "success", value: true, correlationId, remoteOutcome: "accepted" } as const),
  });
  await queue.close({ drain: true });
  assert.equal((await result).outcome, "success");
  assert.equal(queue.closed, true);
});

test("retry policy honors primary reset, then succeeds without real waiting", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const decision = await executeWithGitHubRetry(
    {
      operation: "read",
      correlationId: "retry-primary",
      execute: async () => {
        attempts += 1;
        if (attempts === 1) {
          return {
            outcome: "rate_limited",
            correlationId: "retry-primary",
            remoteOutcome: "not_accepted",
            error: { code: "rate_limited", message: "limited" },
            response: { status: 429, rateLimit: { remaining: 0, resetAt: 6_000 } },
          } as const;
        }
        return { outcome: "success", value: "ok", correlationId: "retry-primary", remoteOutcome: "accepted" } as const;
      },
    },
    { now: () => 1_000, sleep: async (delay) => { sleeps.push(delay); }, jitterRatio: 0 },
  );
  assert.equal(decision.reason, "success");
  assert.equal(decision.attempts, 2);
  assert.deepEqual(sleeps, [5_000]);
});

test("retry policy honors secondary delay, caps malformed metadata, and does not spin", async () => {
  const sleeps: number[] = [];
  const decision = await executeWithGitHubRetry(
    {
      operation: "read",
      correlationId: "retry-secondary",
      execute: async () => ({
        outcome: "rate_limited",
        correlationId: "retry-secondary",
        remoteOutcome: "not_accepted",
        error: { code: "rate_limited", message: "limited" },
        response: { status: 429, rateLimit: { warnings: ["malformed_retry_after"] } },
      } as const),
    },
    {
      maxAttempts: 2,
      maxTotalDelayMs: 100,
      baseDelayMs: 10,
      maxDelayMs: 50,
      jitterRatio: 0,
      random: () => 0,
      sleep: async (delay) => { sleeps.push(delay); },
    },
  );
  assert.equal(decision.reason, "max_attempts_exhausted");
  assert.equal(decision.attempts, 2);
  assert.deepEqual(sleeps, [10]);
});

test("retry policy uses Retry-After, caps jitter, and stops at total delay bounds", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const secondary = await executeWithGitHubRetry(
    {
      operation: "read",
      correlationId: "retry-after",
      execute: async () => {
        attempts += 1;
        return attempts === 1
          ? { outcome: "rate_limited", correlationId: "retry-after", remoteOutcome: "not_accepted", error: { code: "rate_limited", message: "limited" }, response: { status: 429, rateLimit: { retryAfterMs: 25_000 } } } as const
          : { outcome: "success", value: true, correlationId: "retry-after", remoteOutcome: "accepted" } as const;
      },
    },
    { maxTotalDelayMs: 30_000, sleep: async (delay) => { sleeps.push(delay); } },
  );
  assert.equal(secondary.reason, "success");
  assert.deepEqual(sleeps, [25_000]);

  sleeps.length = 0;
  const jitter = await executeWithGitHubRetry(
    {
      operation: "read",
      correlationId: "jitter",
      execute: async () => ({ outcome: "retryable_error", correlationId: "jitter", remoteOutcome: "not_accepted", error: { code: "retryable", message: "temporary" } } as const),
    },
    { maxAttempts: 2, maxTotalDelayMs: 2_000, baseDelayMs: 1_000, maxDelayMs: 1_200, jitterRatio: 1, random: () => 1, sleep: async (delay) => { sleeps.push(delay); } },
  );
  assert.equal(jitter.reason, "max_attempts_exhausted");
  assert.deepEqual(sleeps, [1_200]);

  sleeps.length = 0;
  const bounded = await executeWithGitHubRetry(
    {
      operation: "read",
      correlationId: "delay-bound",
      execute: async () => ({ outcome: "rate_limited", correlationId: "delay-bound", remoteOutcome: "not_accepted", error: { code: "rate_limited", message: "limited" }, response: { status: 429, rateLimit: { retryAfterMs: 500 } } } as const),
    },
    { maxAttempts: 2, maxTotalDelayMs: 100, sleep: async (delay) => { sleeps.push(delay); } },
  );
  assert.equal(bounded.reason, "total_delay_bound_exhausted");
  assert.deepEqual(sleeps, []);
});

test("retry policy does not retry permanent 4xx or repeated server failures beyond the bound", async () => {
  let permanentAttempts = 0;
  const permanent = await executeWithGitHubRetry(
    {
      operation: "read",
      execute: async () => {
        permanentAttempts += 1;
        return { outcome: "permanent_error", correlationId: "permanent", remoteOutcome: "not_accepted", error: { code: "forbidden", message: "forbidden" } } as const;
      },
    },
  );
  assert.equal(permanent.reason, "non_retryable_outcome");
  assert.equal(permanentAttempts, 1);

  const repeated = await executeWithGitHubRetry(
    {
      operation: "read",
      execute: async () => ({ outcome: "retryable_error", correlationId: "repeated", remoteOutcome: "not_accepted", error: { code: "retryable", message: "503" } } as const),
    },
    { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, maxTotalDelayMs: 2, jitterRatio: 0, sleep: async () => undefined },
  );
  assert.equal(repeated.reason, "max_attempts_exhausted");
  assert.equal(repeated.attempts, 3);
});

test("retry policy retries only safe writes and stops uncertain mutations", async () => {
  let safeAttempts = 0;
  const safe = await executeWithGitHubRetry(
    {
      operation: "write",
      idempotent: true,
      correlationId: "safe-write",
      execute: async () => {
        safeAttempts += 1;
        return safeAttempts === 1
          ? { outcome: "retryable_error", correlationId: "safe-write", remoteOutcome: "not_accepted", error: { code: "retryable", message: "5xx" } } as const
          : { outcome: "success", value: true, correlationId: "safe-write", remoteOutcome: "accepted" } as const;
      },
    },
    { baseDelayMs: 1, maxDelayMs: 1, maxTotalDelayMs: 1, jitterRatio: 0, sleep: async () => undefined },
  );
  assert.equal(safe.reason, "success");
  assert.equal(safeAttempts, 2);

  const unknown = await executeWithGitHubRetry(
    {
      operation: "write",
      idempotent: true,
      correlationId: "unknown-write",
      execute: async () => ({ outcome: "unknown", correlationId: "unknown-write", remoteOutcome: "unknown", error: { code: "network", message: "lost" } } as const),
    },
  );
  assert.equal(unknown.reason, "unknown_write_outcome");
  assert.equal(unknown.attempts, 1);
});

test("retry policy returns explicit cancellation while waiting", async () => {
  const controller = new AbortController();
  const decision = await executeWithGitHubRetry(
    {
      operation: "read",
      signal: controller.signal,
      correlationId: "cancelled-retry",
      execute: async () => ({
        outcome: "retryable_error",
        correlationId: "cancelled-retry",
        remoteOutcome: "not_accepted",
        error: { code: "retryable", message: "temporary" },
      } as const),
    },
    {
      sleep: async () => {
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
    },
  );
  assert.equal(decision.reason, "cancelled");
  assert.equal(decision.finalOutcome.outcome, "permanent_error");
});
