import type { GitHubConfig } from "./config.js";
import {
  failure,
  success,
  type GitHubOperationResult,
  type GitHubResponseMetadata,
} from "./outcome.js";
import type { GitHubRequestContext, GitHubRestReadRequest, GitHubRestWriteRequest, GitHubGraphqlReadRequest, GitHubGraphqlWriteRequest, GitHubFetch } from "./transport-types.js";

const GITHUB_API_VERSION = "2022-11-28";

function finiteHeaderNumber(headers: Headers, name: string): { readonly value?: number; readonly malformed: boolean } {
  const value = headers.get(name);
  if (value === null || !/^\d+$/u.test(value.trim())) {
    return { malformed: value !== null };
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? { value: parsed, malformed: false } : { malformed: true };
}

function retryAfterMs(headers: Headers, now: number): { readonly value?: number; readonly malformed: boolean } {
  const value = headers.get("retry-after")?.trim();
  if (value === undefined || value.length === 0) {
    return { malformed: false };
  }
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const parsed = Number(value) * 1_000;
    return Number.isFinite(parsed)
      ? { value: Math.max(0, Math.round(parsed)), malformed: false }
      : { malformed: true };
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) {
    return { malformed: true };
  }
  return { value: Math.max(0, date - now), malformed: false };
}

function linkPagination(headers: Headers): GitHubResponseMetadata["pagination"] {
  const value = headers.get("link");
  if (value === null) {
    return undefined;
  }
  const links: Record<string, string> = {};
  for (const part of value.split(",")) {
    const match = /^\s*<([^<>]+)>\s*;\s*rel="([^"]+)"\s*$/u.exec(part);
    if (match === null) {
      continue;
    }
    const [, url, relation] = match;
    if (url !== undefined && (relation === "next" || relation === "previous")) {
      links[relation] = url;
    }
  }
  return Object.keys(links).length === 0
    ? undefined
    : {
        ...(links.next === undefined ? {} : { next: links.next }),
        ...(links.previous === undefined ? {} : { previous: links.previous }),
      };
}

function metadata(response: Response, now = Date.now()): GitHubResponseMetadata {
  const resetSeconds = finiteHeaderNumber(response.headers, "x-ratelimit-reset");
  const limit = finiteHeaderNumber(response.headers, "x-ratelimit-limit");
  const remaining = finiteHeaderNumber(response.headers, "x-ratelimit-remaining");
  const used = finiteHeaderNumber(response.headers, "x-ratelimit-used");
  const retryAfter = retryAfterMs(response.headers, now);
  const requestId = response.headers.get("x-github-request-id") ?? response.headers.get("x-request-id");
  const warnings = [
    ...(resetSeconds.malformed ? ["malformed_reset" as const] : []),
    ...(retryAfter.malformed ? ["malformed_retry_after" as const] : []),
    ...([limit, remaining, used].some((item) => item.malformed) ? ["malformed_counter" as const] : []),
  ];
  const resetAt = resetSeconds.value === undefined ? undefined : resetSeconds.value * 1_000;
  const pagination = linkPagination(response.headers);
  return {
    status: response.status,
    ...(requestId === null ? {} : { requestId }),
    ...(pagination === undefined ? {} : { pagination }),
    rateLimit: {
      ...(limit.value === undefined ? {} : { limit: limit.value }),
      ...(remaining.value === undefined ? {} : { remaining: remaining.value }),
      ...(resetAt === undefined ? {} : { resetAt }),
      ...(used.value === undefined ? {} : { used: used.value }),
      ...(retryAfter.value === undefined ? {} : { retryAfterMs: retryAfter.value }),
      ...(warnings.length === 0 ? {} : { warnings }),
    },
  };
}

function signalAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function responseResult<T>(
  response: Response,
  value: T,
  correlationId: string,
  mutation: boolean,
): GitHubOperationResult<T> {
  const responseMetadata = metadata(response);
  if (response.ok) {
    return success(value, correlationId, responseMetadata);
  }
  const remoteOutcome = mutation && response.status >= 500 ? "unknown" : "not_accepted";
  if (response.status === 401) {
    return failure("permanent_error", "authentication", "GitHub authentication failed.", correlationId, remoteOutcome, responseMetadata);
  }
  if (response.status === 403) {
    return failure("permanent_error", "forbidden", "GitHub rejected the operation with HTTP 403.", correlationId, remoteOutcome, responseMetadata);
  }
  if (response.status === 404) {
    return failure("permanent_error", "not_found", "GitHub resource was not found.", correlationId, remoteOutcome, responseMetadata);
  }
  if (response.status === 429) {
    return failure("rate_limited", "rate_limited", "GitHub rate limit was reached.", correlationId, "not_accepted", responseMetadata);
  }
  if (response.status === 422) {
    return failure("permanent_error", "validation_failed", "GitHub rejected the mutation validation.", correlationId, remoteOutcome, responseMetadata);
  }
  if (response.status >= 500) {
    return failure("retryable_error", "retryable", "GitHub is temporarily unavailable.", correlationId, remoteOutcome, responseMetadata);
  }
  return failure("permanent_error", "invalid_request", `GitHub rejected the request with HTTP ${response.status}.`, correlationId, remoteOutcome, responseMetadata);
}

function responseWithBody<T>(response: Response, text: string, correlationId: string, mutation: boolean): GitHubOperationResult<T> {
  if (!response.ok) {
    return responseResult(response, undefined as T, correlationId, mutation);
  }
  if (response.status === 204 || text.trim().length === 0) {
    return responseResult(response, undefined as T, correlationId, mutation);
  }
  try {
    return responseResult(response, JSON.parse(text) as T, correlationId, mutation);
  } catch {
    return failure("permanent_error", "malformed_response", "GitHub returned malformed JSON.", correlationId, mutation ? "unknown" : "not_accepted", metadata(response));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PRE_EXECUTION_GRAPHQL_CODES = new Set([
  "GRAPHQL_PARSE_FAILED",
  "GRAPHQL_VALIDATION_FAILED",
]);

/**
 * GraphQL only guarantees that parse/validation failures happened before
 * execution. Resolver errors, including errors without `data`, are not proof
 * that another mutation field or an external side effect did not run.
 */
function provenGraphQlPreExecutionRejection(body: Record<string, unknown>): boolean {
  if ("data" in body || !Array.isArray(body.errors) || body.errors.length === 0) return false;
  return body.errors.every((value) => {
    if (!isRecord(value) || "path" in value || !isRecord(value.extensions)) return false;
    const code = value.extensions.code;
    return typeof code === "string" && PRE_EXECUTION_GRAPHQL_CODES.has(code.toUpperCase());
  });
}

function graphQlFailure(
  mutation: boolean,
  provenNotExecuted: boolean,
  code: "graphql_error" | "malformed_response",
  message: string,
  correlationId: string,
  response: Response,
): GitHubOperationResult<never> {
  const uncertain = mutation && !provenNotExecuted;
  return failure(
    uncertain ? "unknown" : "permanent_error",
    code,
    message,
    correlationId,
    uncertain ? "unknown" : "not_accepted",
    metadata(response),
  );
}

function graphQlBody<T>(response: Response, text: string, correlationId: string, mutation: boolean): GitHubOperationResult<T> {
  if (!response.ok) {
    return responseResult(response, undefined as T, correlationId, mutation);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return graphQlFailure(mutation, false, "malformed_response", "GitHub returned malformed GraphQL JSON.", correlationId, response);
  }
  if (!isRecord(body)) {
    return graphQlFailure(mutation, false, "malformed_response", "GitHub returned an invalid GraphQL response.", correlationId, response);
  }
  if ("errors" in body && Array.isArray(body.errors) && body.errors.length > 0) {
    return graphQlFailure(
      mutation,
      provenGraphQlPreExecutionRejection(body),
      "graphql_error",
      "GitHub GraphQL returned an operation error.",
      correlationId,
      response,
    );
  }
  if (!("data" in body)) {
    return graphQlFailure(mutation, false, "malformed_response", "GitHub returned an invalid GraphQL response.", correlationId, response);
  }
  return responseResult(response, (body as { data: T }).data, correlationId, mutation);
}

async function responseTextWithinDeadline(response: Response, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      response.text(),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException("Request aborted", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally { if (abort !== undefined) signal.removeEventListener("abort", abort); }
}

export class GitHubTransport {
  readonly #config: GitHubConfig;
  readonly #fetch: GitHubFetch;

  constructor(config: GitHubConfig, options: { readonly fetch?: GitHubFetch } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? (fetch as GitHubFetch);
  }

  async restRead<T>(request: GitHubRestReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    return this.#request<T>(request, context, false, false);
  }

  async restWrite<T>(request: GitHubRestWriteRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    return this.#request<T>(request, context, true, false);
  }

  async graphqlRead<T>(request: GitHubGraphqlReadRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    if (/^\s*mutation\b/u.test(request.query)) {
      return failure("permanent_error", "invalid_request", "GraphQL read clients cannot execute mutations.", context.correlationId, "not_accepted");
    }
    return this.#request<T>(request, context, false, true);
  }

  async graphqlWrite<T>(request: GitHubGraphqlWriteRequest, context: GitHubRequestContext): Promise<GitHubOperationResult<T>> {
    return this.#request<T>(request, context, true, true);
  }

  async #request<T>(
    request: GitHubRestReadRequest | GitHubRestWriteRequest | GitHubGraphqlReadRequest | GitHubGraphqlWriteRequest,
    context: GitHubRequestContext,
    mutation: boolean,
    graphql: boolean,
  ): Promise<GitHubOperationResult<T>> {
    if (mutation && this.#config.writeTargetExplicit === false) {
      return failure("permanent_error", "invalid_request", "GitHub writes require explicit PIRX_GITHUB_OWNER and PIRX_GITHUB_REPOSITORY.", context.correlationId, "not_accepted");
    }
    let endpoint: URL;
    try { endpoint = new URL(this.#config.apiUrl); }
    catch { return failure("permanent_error", "invalid_request", "GitHub API endpoint is invalid.", context.correlationId, "not_accepted"); }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
      return failure("permanent_error", "invalid_request", "GitHub credentials require an HTTPS endpoint without embedded credentials.", context.correlationId, "not_accepted");
    }
    if (context.correlationId.trim().length === 0) {
      return failure("permanent_error", "invalid_request", "GitHub correlation ID is required.", context.correlationId, "not_accepted");
    }
    if (context.timeoutMs !== undefined && (!Number.isSafeInteger(context.timeoutMs) || context.timeoutMs <= 0)) {
      return failure("permanent_error", "invalid_request", "GitHub request timeout must be a positive integer.", context.correlationId, "not_accepted");
    }
    if (graphql && (request as GitHubGraphqlReadRequest | GitHubGraphqlWriteRequest).query.trim().length === 0) {
      return failure("permanent_error", "invalid_request", "GitHub GraphQL query is required.", context.correlationId, "not_accepted");
    }
    if (signalAborted(context.signal)) return failure("permanent_error", "cancelled", "GitHub request was cancelled before dispatch.", context.correlationId, "not_accepted");
    const controller = new AbortController();
    let timedOut = false;
    const timeoutMs = context.timeoutMs ?? this.#config.timeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("GitHub request timed out.", "TimeoutError"));
    }, timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort(context.signal?.reason);
    if (signalAborted(context.signal)) {
      abort();
    } else {
      context.signal?.addEventListener("abort", abort, { once: true });
    }

    let response: Response;
    try {
      const restRequest = request as GitHubRestReadRequest | GitHubRestWriteRequest;
      const graphqlRequest = request as GitHubGraphqlReadRequest | GitHubGraphqlWriteRequest;
      const url = graphql
        ? new URL(`${this.#config.apiUrl}/graphql`)
        : new URL(restRequest.path.replace(/^\/+/, ""), `${this.#config.apiUrl}/`);
      if (url.origin !== endpoint.origin || url.protocol !== "https:" || url.username || url.password) {
        return failure("permanent_error", "invalid_request", "GitHub request cannot leave the configured HTTPS origin.", context.correlationId, "not_accepted");
      }
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#config.token}`,
        "x-github-api-version": GITHUB_API_VERSION,
        "x-pirx-correlation-id": context.correlationId,
      };
      let body: string | undefined;
      let method: string;
      if (graphql) {
        method = "POST";
        headers["content-type"] = "application/json";
        body = JSON.stringify({ query: graphqlRequest.query, ...(graphqlRequest.variables === undefined ? {} : { variables: graphqlRequest.variables }) });
      } else {
        method = restRequest.method;
        if (restRequest.query !== undefined) {
          for (const [key, value] of Object.entries(restRequest.query)) {
            if (value !== undefined) url.searchParams.set(key, String(value));
          }
        }
        if ("body" in restRequest && restRequest.body !== undefined) {
          headers["content-type"] = "application/json";
          body = JSON.stringify(restRequest.body);
        }
      }
      response = await this.#fetch(url, {
        method,
        redirect: "error",
        headers,
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      const text = await responseTextWithinDeadline(response, controller.signal);
      return graphql
        ? graphQlBody<T>(response, text, context.correlationId, mutation)
        : responseWithBody<T>(response, text, context.correlationId, mutation);
    } catch (error: unknown) {
      if (signalAborted(context.signal)) {
        return failure("permanent_error", "cancelled", "GitHub request was cancelled.", context.correlationId, mutation ? "unknown" : "not_accepted");
      }
      if (timedOut || isAbortError(error)) {
        return failure(mutation ? "unknown" : "retryable_error", "timeout", "GitHub request timed out.", context.correlationId, mutation ? "unknown" : "not_accepted");
      }
      return failure(mutation ? "unknown" : "retryable_error", "network", "GitHub network request failed.", context.correlationId, mutation ? "unknown" : "not_accepted");
    } finally {
      clearTimeout(timeout);
      context.signal?.removeEventListener("abort", abort);
    }

  }
}
