import { randomUUID } from "node:crypto";

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  GitHubShipmentPoc,
  GitHubActionsWatcher,
  type GitHubConfig,
  type GitHubShipmentPocGatewayPort,
  type GitHubShipmentPocStore,
  SHIPMENT_POC_REPOSITORY,
} from "@pirx/orchestrator";

import { verifyHostAuthorization } from "../authorization.js";

const safeText = z.string().trim().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value) && !/bearer\s+|authorization\s*:|-----begin|(?:token|secret|password)\s*=/iu.test(value), "Value contains unsupported or sensitive content");
const sha = z.string().trim().min(4).max(128).regex(/^[A-Za-z0-9._-]+$/u);
const inputSchema = z.object({
  eventId: safeText.describe("Stable CODE_PUSHED event identifier"),
  headBranch: z.string().trim().regex(/^pirx\/poc-[A-Za-z0-9._/-]{1,120}$/u).describe("Dedicated pirx/poc-* branch"),
  expectedHeadSha: sha.describe("Exact CODE_PUSHED branch head SHA"),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  pollIntervalMs: z.number().int().positive().max(60_000).optional(),
  maxFailedJobs: z.number().int().min(0).max(10).optional(),
  maxFailedSteps: z.number().int().min(0).max(20).optional(),
  correlationId: safeText.optional(),
}).strict();

const evidencePull = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  headSha: z.string(),
  runId: z.number().int().positive().optional(),
  conclusion: z.string().optional(),
  failedJobsErrorCode: z.string().optional(),
  failedJobs: z.array(z.object({
    id: z.number().int().positive(),
    name: z.string(),
    url: z.string().url().optional(),
    failedSteps: z.array(z.object({ name: z.string(), number: z.number().int().positive().optional() })),
  })).optional(),
});
const outputSchema = z.object({
  outcome: z.enum(["production_approval_required", "feature_ci_failed", "release_ci_failed", "pending_or_timeout", "stale_head", "not_found", "ambiguous", "policy_blocked", "authorization_required", "rate_limited", "provider_error", "unknown"]),
  repository: z.literal(SHIPMENT_POC_REPOSITORY),
  featureBase: z.literal("develop"),
  releaseBase: z.literal("main"),
  eventId: z.string(),
  headBranch: z.string(),
  expectedHeadSha: z.string(),
  correlationId: z.string(),
  message: z.string(),
  errorCode: z.string().optional(),
  evidence: z.object({ featurePullRequest: evidencePull.optional(), releasePullRequest: evidencePull.optional(), developHeadSha: z.string().optional(), mergeSha: z.string().optional() }),
  replayed: z.boolean(),
  updatedAt: z.string(),
});

function structured(value: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

export function registerGitHubShipmentPocTool(
  server: McpServer,
  options: {
    readonly config: GitHubConfig | undefined;
    readonly gateway: GitHubShipmentPocGatewayPort | undefined;
    readonly store: GitHubShipmentPocStore;
    readonly authorizationSecret: string | undefined;
    readonly configurationError?: string;
  },
): void {
  server.registerTool(
    "github_shipment_round_trip_poc",
    {
      title: "Run the controlled GitHub shipment round-trip POC",
      description: "Verify one CODE_PUSHED branch, create or reuse its PR into develop, watch exact-head CI, merge only exact green CI into develop, then create or reuse and watch the develop-to-main release PR. This operation stops before main and never deploys production.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input, context) => {
      const correlationId = input.correlationId ?? randomUUID();
      const authorization = verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "github_shipment_round_trip_poc", input);
      if (authorization === undefined) {
        return structured({ outcome: "authorization_required", repository: SHIPMENT_POC_REPOSITORY, featureBase: "develop", releaseBase: "main", eventId: input.eventId, headBranch: input.headBranch, expectedHeadSha: input.expectedHeadSha, correlationId, message: "This shipment mutation must be authorized by the Pirx host for the exact event, branch, revision, and bounded watch settings.", errorCode: "authorization_required", evidence: {}, replayed: false, updatedAt: new Date().toISOString() }, true);
      }
      if (options.config === undefined || options.gateway === undefined) {
        return structured({ outcome: "provider_error", repository: SHIPMENT_POC_REPOSITORY, featureBase: "develop", releaseBase: "main", eventId: input.eventId, headBranch: input.headBranch, expectedHeadSha: input.expectedHeadSha, correlationId, message: options.configurationError ?? "GitHub shipment POC is unavailable because GitHub is not configured.", errorCode: "configuration", evidence: {}, replayed: false, updatedAt: new Date().toISOString() }, true);
      }
      try {
        const result = await new GitHubShipmentPoc(options.gateway, new GitHubActionsWatcher(options.gateway, options.config), options.store, options.config).execute({
          eventId: input.eventId,
          headBranch: input.headBranch,
          expectedHeadSha: input.expectedHeadSha,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
          ...(input.maxFailedJobs === undefined ? {} : { maxFailedJobs: input.maxFailedJobs }),
          ...(input.maxFailedSteps === undefined ? {} : { maxFailedSteps: input.maxFailedSteps }),
          correlationId,
        });
        return structured(result, result.outcome !== "production_approval_required");
      } catch {
        return structured({ outcome: "unknown", repository: SHIPMENT_POC_REPOSITORY, featureBase: "develop", releaseBase: "main", eventId: input.eventId, headBranch: input.headBranch, expectedHeadSha: input.expectedHeadSha, correlationId, message: "Shipment POC failed before a normalized result was produced.", errorCode: "execution_failed", evidence: {}, replayed: false, updatedAt: new Date().toISOString() }, true);
      }
    },
  );
}
