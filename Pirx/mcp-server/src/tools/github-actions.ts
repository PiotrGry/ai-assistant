import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  GitHubActionsWatcher,
  type GitHubActionsReadGateway,
  type GitHubActionsWatchRequest,
  type GitHubConfig,
} from "@pirx/orchestrator";

const positiveInteger = z.number().int().positive();
const boundedText = z.string().trim().min(1).max(256);

const inputSchema = z.object({
  workflowRunId: positiveInteger.optional(),
  pullRequestNumber: positiveInteger.optional(),
  expectedHeadSha: z.string().trim().min(4).max(128).regex(/^[A-Za-z0-9._-]+$/u).optional(),
  timeoutMs: positiveInteger.max(300_000).optional(),
  pollIntervalMs: positiveInteger.max(60_000).optional(),
  maxFailedJobs: z.number().int().min(0).max(10).optional(),
  maxFailedSteps: z.number().int().min(0).max(20).optional(),
  correlationId: boundedText.optional(),
}).strict().superRefine((input, context) => {
  const hasRun = input.workflowRunId !== undefined;
  const hasPullRequest = input.pullRequestNumber !== undefined;
  if (hasRun === hasPullRequest) {
    context.addIssue({ code: "custom", message: "Provide exactly one of workflowRunId or pullRequestNumber." });
  }
  if (hasRun && input.expectedHeadSha !== undefined) {
    context.addIssue({ code: "custom", message: "expectedHeadSha is only valid with pullRequestNumber." });
  }
  if (hasPullRequest && input.expectedHeadSha === undefined) {
    context.addIssue({ code: "custom", message: "expectedHeadSha is required with pullRequestNumber." });
  }
});

const terminalSchema = z.object({
  outcome: z.enum(["success", "failed", "cancelled"]),
  repository: z.string(),
  workflowRunId: z.number().int().positive(),
  pullRequestNumber: z.number().int().positive().optional(),
  expectedHeadSha: z.string().optional(),
  testedRevision: z.string(),
  status: z.literal("completed"),
  conclusion: z.string(),
  runUrl: z.string(),
  workflowName: z.string().optional(),
  failedJobs: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string(),
    url: z.string().optional(),
    failedSteps: z.array(z.object({ name: z.string(), number: z.number().int().positive().optional() })),
  })).optional(),
  polls: z.number().int().nonnegative(),
  providerAttempts: z.number().int().nonnegative(),
});

const errorSchema = z.object({
  outcome: z.enum(["invalid_request", "rate_limited", "not_found", "ambiguous", "provider_error", "unknown", "timeout", "cancelled"]),
  repository: z.string(),
  workflowRunId: z.number().int().positive().optional(),
  pullRequestNumber: z.number().int().positive().optional(),
  expectedHeadSha: z.string().optional(),
  errorCode: z.string(),
  message: z.string(),
  polls: z.number().int().nonnegative(),
  providerAttempts: z.number().int().nonnegative(),
});

function structured(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

export function registerGitHubActionsWatchTool(
  server: McpServer,
  options: {
    readonly config: GitHubConfig | undefined;
    readonly gateway: GitHubActionsReadGateway | undefined;
    readonly configurationError: string | undefined;
  },
): void {
  server.registerTool(
    "github_actions_watch",
    {
      title: "Watch one GitHub Actions run",
      description: "Read-only bounded CI observation. One tool call resolves the exact workflow run or pull request head, polls internally, and returns one normalized terminal result.",
      inputSchema,
      outputSchema: z.union([terminalSchema, errorSchema]),
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      if (options.config === undefined || options.gateway === undefined) {
        return structured({
          outcome: "provider_error",
          repository: options.config === undefined ? "unknown/unknown" : `${options.config.owner}/${options.config.repository}`,
          errorCode: "configuration",
          message: options.configurationError ?? "GitHub Actions watch is unavailable because GitHub is not configured.",
          polls: 0,
          providerAttempts: 0,
        }, true);
      }
      const request: GitHubActionsWatchRequest = {
        ...(input.workflowRunId === undefined ? {} : { workflowRunId: input.workflowRunId }),
        ...(input.pullRequestNumber === undefined ? {} : { pullRequestNumber: input.pullRequestNumber }),
        ...(input.expectedHeadSha === undefined ? {} : { expectedHeadSha: input.expectedHeadSha }),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
        ...(input.maxFailedJobs === undefined ? {} : { maxFailedJobs: input.maxFailedJobs }),
        ...(input.maxFailedSteps === undefined ? {} : { maxFailedSteps: input.maxFailedSteps }),
        correlationId: input.correlationId ?? randomUUID(),
      };
      const result = await new GitHubActionsWatcher(options.gateway, options.config).watch(request);
      return structured(result, result.outcome !== "success" && result.outcome !== "failed" && result.outcome !== "cancelled");
    },
  );
}
