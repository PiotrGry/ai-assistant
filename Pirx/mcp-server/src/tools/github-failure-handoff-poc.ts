import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  FAILURE_HANDOFF_POC_FEATURE_BASE,
  FAILURE_HANDOFF_POC_REPOSITORY,
  FAILURE_HANDOFF_POC_WORKFLOW,
  GitHubFailureHandoffPoc,
  GitHubActionsWatcher,
  type GitHubConfig,
  type GitHubFailureHandoffCodexRunner,
  type GitHubFailureHandoffPocGateway,
  type GitHubFailureHandoffPocStore,
} from "@pirx/orchestrator";

import { verifyHostAuthorization } from "../authorization.js";

const safeText = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value) && !/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(value), "Value contains unsupported or sensitive content");
const inputSchema = z.object({
  eventId: safeText.describe("Stable CODE_PUSHED event identifier"),
  headBranch: z.string().trim().regex(/^pirx\/poc-failure-[A-Za-z0-9._/-]{1,120}$/u).describe("Dedicated pirx/poc-failure-* branch"),
  expectedHeadSha: z.string().trim().min(4).max(128).regex(/^[A-Za-z0-9._-]+$/u).describe("Exact branch head SHA"),
  requiredWorkflowName: z.literal(FAILURE_HANDOFF_POC_WORKFLOW),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  pollIntervalMs: z.number().int().positive().max(60_000).optional(),
  maxFailedJobs: z.number().int().positive().max(10).optional(),
  maxFailedSteps: z.number().int().positive().max(20).optional(),
  maxLogBytes: z.number().int().positive().max(8_192).optional(),
  codexTimeoutMs: z.number().int().positive().max(120_000).optional(),
  correlationId: safeText.optional(),
}).strict();

const failedJob = z.object({ id: z.number().int().positive(), name: z.string(), url: z.string().url().optional(), failedSteps: z.array(z.object({ name: z.string(), number: z.number().int().positive().optional() })) });
const evidence = z.object({
  schemaVersion: z.literal(1),
  repository: z.literal(FAILURE_HANDOFF_POC_REPOSITORY),
  pullRequest: z.object({ number: z.number().int().positive(), url: z.string().url(), headBranch: z.string(), headSha: z.string() }),
  workflow: z.object({ name: z.string(), runId: z.number().int().positive(), url: z.string().url(), headSha: z.string(), conclusion: z.string() }),
  failedJobs: z.array(failedJob),
  logExcerpt: z.string().optional(),
  redactionCount: z.number().int().nonnegative(),
  evidenceBytes: z.number().int().positive(),
  evidenceDigest: z.string().length(64),
});
const outputSchema = z.object({
  outcome: z.enum(["failure_handoff_completed", "unexpected_ci_success", "failure_evidence_unavailable", "worker_handoff_failed", "worker_authentication_required", "worker_quota_exhausted", "pending_or_timeout", "stale_head", "not_found", "ambiguous", "policy_blocked", "authorization_required", "rate_limited", "provider_error", "unknown"]),
  repository: z.literal(FAILURE_HANDOFF_POC_REPOSITORY),
  featureBase: z.literal(FAILURE_HANDOFF_POC_FEATURE_BASE),
  requiredWorkflowName: z.literal(FAILURE_HANDOFF_POC_WORKFLOW),
  eventId: z.string(),
  headBranch: z.string(),
  expectedHeadSha: z.string(),
  correlationId: z.string(),
  handoffId: z.string(),
  message: z.string(),
  errorCode: z.string().optional(),
  pullRequest: z.object({ number: z.number().int().positive(), url: z.string().url(), headSha: z.string(), state: z.string(), merged: z.boolean() }).optional(),
  run: z.object({ id: z.number().int().positive(), name: z.string(), url: z.string().url(), headSha: z.string(), conclusion: z.string() }).optional(),
  evidence: evidence.optional(),
  codexReceipt: z.object({ handoffId: z.string(), outcome: z.string(), acknowledgement: z.string().optional() }).optional(),
  replayed: z.boolean(),
  updatedAt: z.string(),
});

function structured(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

function fallback(input: z.infer<typeof inputSchema>, correlationId: string, handoffId: string, outcome: "authorization_required" | "provider_error", message: string, errorCode: string) {
  return { outcome, repository: FAILURE_HANDOFF_POC_REPOSITORY, featureBase: FAILURE_HANDOFF_POC_FEATURE_BASE, requiredWorkflowName: FAILURE_HANDOFF_POC_WORKFLOW, eventId: input.eventId, headBranch: input.headBranch, expectedHeadSha: input.expectedHeadSha, correlationId, handoffId, message, errorCode, replayed: false, updatedAt: new Date().toISOString() };
}

export function registerGitHubFailureHandoffPocTool(
  server: McpServer,
  options: {
    readonly config: GitHubConfig | undefined;
    readonly gateway: GitHubFailureHandoffPocGateway | undefined;
    readonly store: GitHubFailureHandoffPocStore;
    readonly codex: GitHubFailureHandoffCodexRunner;
    readonly authorizationSecret: string | undefined;
    readonly configurationError?: string;
  },
): void {
  server.registerTool(
    "github_failed_ci_codex_handoff_poc",
    {
      title: "Run the controlled failed-CI Codex handoff POC",
      description: "Create or reuse one controlled failure PR into develop, observe the exact named failed workflow, forward bounded sanitized evidence to one fresh restricted Codex CLI session, and stop. This operation never merges, creates a release PR, dispatches workflows, or deploys.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
    },
    async (input, context) => {
      const correlationId = input.correlationId ?? randomUUID();
      const handoffId = randomUUID();
      const authorization = verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "github_failed_ci_codex_handoff_poc", input);
      if (authorization === undefined) return structured(fallback(input, correlationId, handoffId, "authorization_required", "This failure handoff mutation must be authorized by the Pirx host for the exact event, branch, revision, workflow, and bounds.", "authorization_required"), true);
      if (options.config === undefined || options.gateway === undefined) return structured(fallback(input, correlationId, handoffId, "provider_error", options.configurationError ?? "GitHub failure handoff POC is unavailable because GitHub is not configured.", "configuration"), true);
      try {
        const result = await new GitHubFailureHandoffPoc(options.gateway, new GitHubActionsWatcher(options.gateway, options.config), options.codex, options.store, options.config).execute({
          eventId: input.eventId,
          headBranch: input.headBranch,
          expectedHeadSha: input.expectedHeadSha,
          requiredWorkflowName: input.requiredWorkflowName,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
          ...(input.maxFailedJobs === undefined ? {} : { maxFailedJobs: input.maxFailedJobs }),
          ...(input.maxFailedSteps === undefined ? {} : { maxFailedSteps: input.maxFailedSteps }),
          ...(input.maxLogBytes === undefined ? {} : { maxLogBytes: input.maxLogBytes }),
          ...(input.codexTimeoutMs === undefined ? {} : { codexTimeoutMs: input.codexTimeoutMs }),
          ...(input.correlationId === undefined ? { correlationId } : { correlationId: input.correlationId }),
        });
        return structured(result, result.outcome !== "failure_handoff_completed" || result.replayed);
      } catch {
        return structured(fallback(input, correlationId, handoffId, "provider_error", "Failure handoff POC failed before a normalized result was produced.", "execution_failed"), true);
      }
    },
  );
}
