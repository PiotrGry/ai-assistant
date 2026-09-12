import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  GitHubIssueLifecycleRoundTrip,
  GitHubIssueMutator,
  GitHubIssueReader,
  type GitHubConfig,
  type GitHubOperationResult,
} from "@pirx/orchestrator";

import { verifyHostAuthorization } from "../authorization.js";

import type { GitHubPocTransport } from "../server.js";

const safeText = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      !/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(value),
    "Value contains unsupported or sensitive content",
  );

const inputSchema = z.object({
  eventId: safeText.describe("Stable event identifier used for idempotent replay"),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine(
      (value) =>
        !/[\u0000-\u001f\u007f]/u.test(value) &&
        !/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(value),
      "Summary contains unsupported or sensitive content",
    ),
  correlationId: safeText.optional(),
}).strict();

const issueRefSchema = z.object({
  owner: z.string(),
  repository: z.string(),
  nodeId: z.string(),
  number: z.number().int().positive(),
  url: z.string(),
});

const commentRefSchema = z.object({ id: z.number().int().positive(), url: z.string() });
const successSchema = z.object({
  outcome: z.literal("success"),
  correlationId: z.string(),
  remoteOutcome: z.literal("accepted"),
  issue: issueRefSchema,
  comment: commentRefSchema,
  initialState: z.enum(["open", "closed"]),
  verifiedState: z.enum(["open", "closed"]),
  changed: z.boolean(),
  replayed: z.boolean(),
  replayNoOp: z.boolean(),
  replayComment: commentRefSchema,
});
const failureSchema = z.object({
  outcome: z.enum([
    "rate_limited",
    "retryable_error",
    "permanent_error",
    "unknown",
  ]),
  correlationId: z.string(),
  remoteOutcome: z.enum(["accepted", "not_accepted", "unknown"]),
  errorCode: z.string(),
  message: z.string(),
});

type PocResult = z.infer<typeof successSchema> | z.infer<typeof failureSchema>;

function structured(result: PocResult, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  };
}

function unavailable(message: string) {
  return structured(
    {
      outcome: "permanent_error",
      correlationId: randomUUID(),
      remoteOutcome: "not_accepted",
      errorCode: "configuration",
      message,
    },
    true,
  );
}

function mapResult(result: GitHubOperationResult<unknown>) {
  if (result.outcome !== "success") {
    return structured(
      {
        outcome: result.outcome,
        correlationId: result.correlationId,
        remoteOutcome: result.remoteOutcome,
        errorCode: result.error.code,
        message:
          result.error.code === "authentication"
            ? "GitHub authentication failed. Run gh auth login first."
            : result.error.message,
      },
      true,
    );
  }
  const value = result.value as {
    issue?: unknown;
    comment?: unknown;
    initialState?: unknown;
    verifiedState?: unknown;
    changed?: unknown;
    replayed?: unknown;
    replayNoOp?: unknown;
    replayComment?: unknown;
  };
  const parsed = successSchema.safeParse({
    outcome: "success",
    correlationId: result.correlationId,
    remoteOutcome: result.remoteOutcome,
    issue: value.issue,
    comment: value.comment,
    initialState: value.initialState,
    verifiedState: value.verifiedState,
    changed: value.changed,
    replayed: value.replayed,
    replayNoOp: value.replayNoOp,
    replayComment: value.replayComment,
  });
  return parsed.success
    ? structured(parsed.data)
    : unavailable("GitHub POC returned an invalid normalized result.");
}

export function registerGitHubPocTool(
  server: McpServer,
  options: {
    readonly issue: number | undefined;
    readonly config: GitHubConfig | undefined;
    readonly transport: GitHubPocTransport | undefined;
    readonly configurationError: string | undefined;
    readonly authorizationSecret: string | undefined;
    readonly reader: GitHubIssueReader | undefined;
    readonly mutator: GitHubIssueMutator | undefined;
  },
): void {
  server.registerTool(
    "github_issue_round_trip_poc",
    {
      title: "Run the controlled GitHub Issue round-trip POC",
      description:
        "Read, publish one marked lifecycle comment, verify, and replay the operation on the fixed configured Pirx sandbox Issue. The target Issue is server-controlled and cannot be selected by the caller.",
      inputSchema,
      outputSchema: z.union([successSchema, failureSchema]),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ eventId, summary, correlationId }, context) => {
      if (options.issue === undefined) {
        return unavailable(
          options.configurationError ??
            "GitHub POC is unavailable because PIRX_GITHUB_POC_ISSUE is not configured.",
        );
      }
      if (options.transport === undefined) {
        return unavailable(
          options.configurationError ??
            "GitHub POC is unavailable because GitHub credentials are not configured.",
        );
      }

      if (options.config === undefined) {
        return unavailable("GitHub POC is unavailable because GitHub configuration is incomplete.");
      }

      const authorization = verifyHostAuthorization(
        options.authorizationSecret,
        context.mcpReq._meta,
        "github_issue_round_trip_poc",
        { eventId, summary, ...(correlationId === undefined ? {} : { correlationId }) },
      );
      if (authorization === undefined) {
        return structured({
          outcome: "permanent_error",
          correlationId: correlationId ?? randomUUID(),
          remoteOutcome: "not_accepted",
          errorCode: "authorization_required",
          message: "This GitHub mutation must be authorized by the Pirx host for this exact tool target and argument set.",
        }, true);
      }
      const reader = options.reader;
      const mutator = options.mutator;
      if (reader === undefined || mutator === undefined) {
        return unavailable("GitHub POC is unavailable because its shared GitHub service is not configured.");
      }
      const roundTrip = new GitHubIssueLifecycleRoundTrip(reader, mutator);
      try {
        const result = await roundTrip.execute({
          issue: options.issue,
          replay: true,
          idempotencyKey: authorization.idempotencyKey,
          ...(correlationId === undefined ? {} : { correlationId }),
          lifecycle: {
            eventId,
            eventType: "manual.pirx_mcp.github_issue_round_trip_poc",
            taskId: "github-issue-round-trip-poc",
            timestamp: new Date().toISOString(),
            summary,
          },
        });
        return mapResult(result);
      } catch {
        return unavailable("GitHub POC failed before a normalized result was produced.");
      } finally {
      }
    },
  );
}
