import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  GitHubIssueMutator,
  GitHubIssueReader,
  type GitHubIssueMutationResult,
  type GitHubIssueRef,
  type GitHubIssueSummary,
  type GitHubOperationResult,
} from "@pirx/orchestrator";

import { verifyHostAuthorization } from "../authorization.js";

const safeText = (max: number) => z.string().trim().min(1).max(max).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value) &&
    !/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(value),
  "Value contains unsupported or sensitive content",
);
const issueNumber = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const state = z.enum(["open", "closed", "all"]);
const issueState = z.enum(["open", "closed"]);
const labels = z.array(safeText(100)).max(100);
const milestone = z.union([z.literal("none"), issueNumber]);
const correlationId = safeText(256).optional();
const idempotencyKey = safeText(256).optional();
const paging = z.object({
  pageSize: z.number().int().min(1).max(100).optional(),
  maxItems: z.number().int().min(1).max(100).optional(),
  cursor: safeText(2_000).optional(),
});
const filter = z.object({
  state: state.optional(),
  labels: labels.optional(),
  milestone: milestone.optional(),
  sort: z.enum(["created", "updated", "comments"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});

const authorSchema = z.object({ login: z.string() });
const labelSchema = z.object({ name: z.string(), color: z.string().optional() });
const issueRefSchema = z.object({
  owner: z.string(), repository: z.string(), nodeId: z.string(),
  number: issueNumber, url: z.string(),
});
const issueSchema = issueRefSchema.extend({
  title: z.string(), body: z.string().max(2_000).optional(), state: issueState,
  author: authorSchema.optional(), labels: z.array(labelSchema),
  assignees: z.array(authorSchema),
  milestone: z.object({ number: issueNumber, title: z.string(), state: issueState.optional() }).optional(),
  createdAt: z.string(), updatedAt: z.string(), closedAt: z.string().optional(),
  parentIssue: issueRefSchema.optional(), blockingIssueNumbers: z.array(issueNumber).optional(),
});
const rawIssueSchema = issueSchema.extend({ body: z.string().max(65_536).optional() });
const commentSchema = z.object({ id: issueNumber, url: z.string() });
const failureSchema = z.object({
  outcome: z.enum(["rate_limited", "retryable_error", "permanent_error", "unknown"]),
  remoteOutcome: z.enum(["accepted", "not_accepted", "unknown"]),
  correlationId: z.string(), errorCode: z.string(), message: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  resetAt: z.number().int().nonnegative().optional(),
});
const pageSchema = z.object({
  items: z.array(issueSchema), nextCursor: z.string().optional(), complete: z.boolean(),
});
const rawPageSchema = z.object({
  items: z.array(rawIssueSchema), nextCursor: z.string().optional(), complete: z.boolean(),
});
const readSuccess = (value: z.ZodTypeAny) => z.object({
  outcome: z.literal("success"), remoteOutcome: z.literal("accepted"), correlationId: z.string(),
}).extend(value instanceof z.ZodObject ? value.shape : {});
const mutationSuccess = z.object({
  outcome: z.literal("success"), remoteOutcome: z.literal("accepted"), correlationId: z.string(),
  issue: issueSchema, operation: z.enum(["created", "updated"]), changed: z.boolean(),
  noOp: z.boolean(), idempotencyKey: z.string(),
});
const commentSuccess = z.object({
  outcome: z.literal("success"), remoteOutcome: z.literal("accepted"), correlationId: z.string(),
  issue: issueRefSchema, comment: commentSchema, eventId: z.string(), changed: z.boolean(),
  noOp: z.boolean(), idempotencyKey: z.string(),
});

function structured(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function failureResult(correlation: string, errorCode: string, message: string) {
  return structured({
    outcome: "permanent_error",
    remoteOutcome: "not_accepted",
    correlationId: correlation,
    errorCode,
    message,
  }, true);
}

function unavailable(message: string, correlation: string = randomUUID()) {
  return failureResult(correlation, "configuration", message);
}

type GitHubFailureResult = Extract<GitHubOperationResult<unknown>, { outcome: "rate_limited" | "retryable_error" | "permanent_error" | "unknown" }>;

function mapFailure(result: GitHubFailureResult) {
  const message = result.error.code === "authentication"
    ? "GitHub authentication failed. Run gh auth login first."
    : result.error.message;
  const rateLimit = result.response?.rateLimit;
  return structured({
    outcome: result.outcome,
    remoteOutcome: result.remoteOutcome,
    correlationId: result.correlationId,
    errorCode: result.error.code,
    message,
    ...(rateLimit?.retryAfterMs === undefined ? {} : { retryAfterMs: rateLimit.retryAfterMs }),
    ...(rateLimit?.resetAt === undefined ? {} : { resetAt: rateLimit.resetAt }),
  }, true);
}

function mapIssue(value: unknown): GitHubIssueSummary | undefined {
  const parsed = rawIssueSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const body = parsed.data.body;
  return body === undefined || body.length <= 2_000
    ? parsed.data as GitHubIssueSummary
    : { ...parsed.data, body: `${body.slice(0, 1_950)}\n[… body truncated by Pirx MCP …]` } as GitHubIssueSummary;
}

function mapPage(value: unknown): { readonly items: readonly GitHubIssueSummary[]; readonly nextCursor?: string; readonly complete: boolean } | undefined {
  const parsed = rawPageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const items = parsed.data.items.map(mapIssue);
  if (items.some((item): item is undefined => item === undefined)) return undefined;
  return {
    items: items as GitHubIssueSummary[],
    ...(parsed.data.nextCursor === undefined ? {} : { nextCursor: parsed.data.nextCursor }),
    complete: parsed.data.complete,
  };
}

function issueRef(value: GitHubIssueRef) {
  return {
    owner: value.owner,
    repository: value.repository,
    nodeId: value.nodeId,
    number: value.number,
    url: value.url,
  };
}

function mapRead<T>(result: GitHubOperationResult<T>, value: Record<string, unknown>) {
  if (result.outcome !== "success") return mapFailure(result);
  return structured({ outcome: "success", remoteOutcome: result.remoteOutcome, correlationId: result.correlationId, ...value });
}

function mapMutation(result: GitHubOperationResult<GitHubIssueMutationResult>) {
  if (result.outcome !== "success") return mapFailure(result);
  const issue = mapIssue(result.value.issue);
  if (issue === undefined) return unavailable("GitHub returned an invalid normalized Issue result.", result.correlationId);
  return structured({
    outcome: "success", remoteOutcome: result.remoteOutcome, correlationId: result.correlationId,
    issue, operation: result.value.operation, changed: result.value.changed,
    noOp: result.value.noOp, idempotencyKey: result.value.idempotencyKey,
  });
}

function expectedState(expectedStateValue: "open" | "closed" | undefined, expectedUpdatedAtValue: string | undefined) {
  return expectedStateValue === undefined && expectedUpdatedAtValue === undefined
    ? undefined
    : {
      ...(expectedStateValue === undefined ? {} : { state: expectedStateValue }),
      ...(expectedUpdatedAtValue === undefined ? {} : { updatedAt: expectedUpdatedAtValue }),
    };
}

function authorizationOrReject(
  secret: string | undefined,
  context: { readonly mcpReq: { readonly _meta?: unknown } },
  toolName: string,
  input: Record<string, unknown>,
  correlation: string,
) {
  return verifyHostAuthorization(secret, context.mcpReq._meta, toolName, input) ??
    failureResult(correlation, "authorization_required", "This GitHub mutation must be authorized by the Pirx host for this exact tool target and argument set.");
}

export function registerGitHubIssueTools(
  server: McpServer,
  options: {
    readonly configurationError: string | undefined;
    readonly authorizationSecret: string | undefined;
    readonly reader: GitHubIssueReader | undefined;
    readonly mutator: GitHubIssueMutator | undefined;
  },
): void {
  const unavailableMessage = options.configurationError ?? "GitHub Issue tools are unavailable because GitHub is not configured.";
  const reader = options.reader;
  const mutator = options.mutator;

  server.registerTool("github_issue_get", {
    title: "Get an Issue in the configured repository",
    description: "Read one current GitHub Issue by number in the server-configured repository. The repository cannot be changed by the caller.",
    inputSchema: z.object({ issueNumber, correlationId }).strict(),
    outputSchema: z.union([readSuccess(z.object({ issue: issueSchema })), failureSchema]),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ issueNumber: number, correlationId: requestedCorrelation }) => {
    const correlation = requestedCorrelation ?? randomUUID();
    if (reader === undefined) return unavailable(unavailableMessage, correlation);
    const result = await reader.getIssue(number, { correlationId: correlation });
    if (result.outcome !== "success") return mapFailure(result);
    const issue = mapIssue(result.value);
    return issue === undefined
      ? unavailable("GitHub returned an invalid normalized Issue result.", correlation)
      : mapRead(result, { issue });
  });

  server.registerTool("github_issue_list", {
    title: "List Issues in the configured repository",
    description: "List bounded pages of current Issues in the server-configured repository. Pull requests are excluded and the repository cannot be changed by the caller.",
    inputSchema: filter.extend(paging.shape).extend({ correlationId }).strict(),
    outputSchema: z.union([readSuccess(z.object({ page: pageSchema })), failureSchema]),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const correlation = input.correlationId ?? randomUUID();
    if (reader === undefined) return unavailable(unavailableMessage, correlation);
    const result = await reader.listIssues({
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
    }, {
      pageSize: input.pageSize ?? 25,
      maxItems: input.maxItems ?? 25,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      correlationId: correlation,
    });
    if (result.outcome !== "success") return mapFailure(result);
    const page = mapPage(result.value);
    return page === undefined
      ? unavailable("GitHub returned an invalid normalized Issue page.", correlation)
      : mapRead(result, { page });
  });

  server.registerTool("github_issue_search", {
    title: "Search Issues in the configured repository",
    description: "Search bounded current Issues using repository-scoped filters. The repository cannot be changed by the caller.",
    inputSchema: filter.extend(paging.shape).extend({ text: safeText(256).optional(), correlationId }).strict(),
    outputSchema: z.union([readSuccess(z.object({ page: pageSchema })), failureSchema]),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    const correlation = input.correlationId ?? randomUUID();
    if (reader === undefined) return unavailable(unavailableMessage, correlation);
    const result = await reader.searchIssues({
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
      ...(input.sort === undefined ? {} : { sort: input.sort }),
      ...(input.direction === undefined ? {} : { direction: input.direction }),
    }, {
      pageSize: input.pageSize ?? 25,
      maxItems: input.maxItems ?? 25,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      correlationId: correlation,
    });
    if (result.outcome !== "success") return mapFailure(result);
    const page = mapPage(result.value);
    return page === undefined
      ? unavailable("GitHub returned an invalid normalized Issue page.", correlation)
      : mapRead(result, { page });
  });

  const createInput = z.object({
    title: safeText(256), body: z.string().max(65_536).nullable().optional(), labels: labels.optional(), milestone: milestone.optional(),
    idempotencyKey, correlationId,
  }).strict();
  server.registerTool("github_issue_create", {
    title: "Create an Issue in the configured repository",
    description: "Create one GitHub Issue in the server-configured repository. Pirx host authorization is required and is bound to this exact operation.",
    inputSchema: createInput, outputSchema: z.union([mutationSuccess, failureSchema]),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input, context) => {
    const correlation = input.correlationId ?? randomUUID();
    const authorization = authorizationOrReject(options.authorizationSecret, context, "github_issue_create", input, correlation);
    if (!("idempotencyKey" in authorization)) return authorization;
    if (mutator === undefined) return unavailable(unavailableMessage, correlation);
    return mapMutation(await mutator.createIssue({
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
      idempotencyKey: authorization.idempotencyKey,
      correlationId: correlation,
    }));
  });

  const updateInput = z.object({
    issueNumber, title: safeText(256).optional(), body: z.string().max(65_536).nullable().optional(), state: issueState.optional(), labels: labels.optional(), milestone: milestone.optional(),
    expectedState: issueState.optional(), expectedUpdatedAt: safeText(100).optional(), idempotencyKey, correlationId,
  }).strict().superRefine((input, context) => {
    if (input.title === undefined && input.body === undefined && input.state === undefined && input.labels === undefined && input.milestone === undefined) {
      context.addIssue({ code: "custom", message: "At least one Issue field must be supplied.", input });
    }
  });
  server.registerTool("github_issue_update", {
    title: "Update an Issue in the configured repository",
    description: "Update supported fields on one Issue in the server-configured repository. Pirx host authorization is required and optimistic conflicts are reported.",
    inputSchema: updateInput, outputSchema: z.union([mutationSuccess, failureSchema]),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input, context) => {
    const correlation = input.correlationId ?? randomUUID();
    const authorization = authorizationOrReject(options.authorizationSecret, context, "github_issue_update", input, correlation);
    if (!("idempotencyKey" in authorization)) return authorization;
    if (mutator === undefined) return unavailable(unavailableMessage, correlation);
    const patch = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.labels === undefined ? {} : { labels: input.labels }),
      ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
    };
    const expected = expectedState(input.expectedState, input.expectedUpdatedAt);
    return mapMutation(await mutator.updateIssue({
      issue: input.issueNumber,
      patch,
      ...(expected === undefined ? {} : { expected }),
      idempotencyKey: authorization.idempotencyKey,
      correlationId: correlation,
    }));
  });

  const commentInput = z.object({ issueNumber, comment: safeText(500), eventId: safeText(256).optional(), idempotencyKey, correlationId }).strict();
  server.registerTool("github_issue_comment", {
    title: "Comment on an Issue in the configured repository",
    description: "Publish one marked lifecycle comment on an Issue in the server-configured repository. Pirx host authorization is required and replay is idempotent.",
    inputSchema: commentInput, outputSchema: z.union([commentSuccess, failureSchema]),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input, context) => {
    const correlation = input.correlationId ?? randomUUID();
    const authorization = authorizationOrReject(options.authorizationSecret, context, "github_issue_comment", input, correlation);
    if (!("idempotencyKey" in authorization)) return authorization;
    if (mutator === undefined) return unavailable(unavailableMessage, correlation);
    const eventId = input.eventId ?? authorization.idempotencyKey;
    const result = await mutator.publishLifecycleComment({
      issue: input.issueNumber,
      idempotencyKey: authorization.idempotencyKey,
      correlationId: correlation,
      envelope: { eventId, eventType: "manual.pirx_mcp.github_issue_comment", taskId: "github-issue-comment", timestamp: new Date().toISOString(), summary: input.comment },
    });
    if (result.outcome !== "success") return mapFailure(result);
    return structured({ outcome: "success", remoteOutcome: result.remoteOutcome, correlationId: result.correlationId, issue: issueRef(result.value.issue), comment: result.value.comment, eventId: result.value.eventId, changed: result.value.changed, noOp: result.value.noOp, idempotencyKey: result.value.idempotencyKey });
  });

  const transitionInput = z.object({ issueNumber, expectedState: issueState.optional(), expectedUpdatedAt: safeText(100).optional(), idempotencyKey, correlationId }).strict();
  for (const [name, transition, title] of [["github_issue_close", "close", "Close"], ["github_issue_reopen", "reopen", "Reopen"]] as const) {
    server.registerTool(name, {
      title: `${title} an Issue in the configured repository`,
      description: `${title} one Issue in the server-configured repository. Pirx host authorization is required and cannot target another repository.`,
      inputSchema: transitionInput, outputSchema: z.union([mutationSuccess, failureSchema]),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: transition === "close", openWorldHint: true },
    }, async (input, context) => {
      const correlation = input.correlationId ?? randomUUID();
      const authorization = authorizationOrReject(options.authorizationSecret, context, name, input, correlation);
      if (!("idempotencyKey" in authorization)) return authorization;
      if (mutator === undefined) return unavailable(unavailableMessage, correlation);
      const expected = expectedState(input.expectedState, input.expectedUpdatedAt);
      const request = {
        issue: input.issueNumber,
        ...(expected === undefined ? {} : { expected }),
        idempotencyKey: authorization.idempotencyKey,
        correlationId: correlation,
      };
      return mapMutation(await (transition === "close" ? mutator.closeIssue(request) : mutator.reopenIssue(request)));
    });
  }
}
