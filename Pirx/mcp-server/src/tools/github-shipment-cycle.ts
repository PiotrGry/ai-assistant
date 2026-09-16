import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  GitHubActionsGateway,
  GitHubCiGatewayAdapter,
  GitHubPullRequestGateway,
  GitHubTransport,
  GitHubWriteQueue,
  RuntimeSqliteStore,
  ShipmentCycleCoordinator,
  type GitHubConfig,
  type GitHubShipmentPocTransport,
  type TaskId,
  type AttemptId,
  type UtcTimestamp,
} from "@pirx/orchestrator";
import { verifyHostAuthorization } from "../authorization.js";

const repository = "PiotrGry/zdrovena-reconciliation" as const;
const workflow = "Develop — Fast Gate" as const;
const inputSchema = z.object({
  taskId: z.string().trim().min(1).max(128),
  attemptId: z.string().trim().min(1).max(128),
  eventId: z.string().trim().min(1).max(256),
  headBranch: z.string().trim().regex(/^pirx\/poc-failure-[A-Za-z0-9._/-]{1,100}$/u),
  expectedHeadSha: z.string().trim().min(4).max(128).regex(/^[A-Za-z0-9._-]+$/u),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  correlationId: z.string().trim().min(1).max(256).optional(),
}).strict();
const outputSchema = z.object({ outcome: z.string(), taskId: z.string(), attemptId: z.string(), eventId: z.string(), message: z.string() }).passthrough();

function structured(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) }; }

export function registerGitHubShipmentCycleTool(server: McpServer, options: { readonly config: GitHubConfig | undefined; readonly transport: GitHubShipmentPocTransport | undefined; readonly authorizationSecret: string | undefined; readonly environment: NodeJS.ProcessEnv; readonly configurationError?: string }): void {
  server.registerTool("github_shipment_cycle", { title: "Run the durable GitHub shipment cycle", description: "Run the production Task/Attempt CI recovery boundary: create or reuse one feature PR, correlate exact CI, record bounded failure evidence and create one retry Attempt, or record exact-green recovery without merging. This tool never merges a pull request, creates a release PR, dispatches workflows, or deploys.", inputSchema, outputSchema, annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true } }, async (input, context) => {
    const correlationId = input.correlationId ?? randomUUID();
    const authorization = verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "github_shipment_cycle", input);
    if (authorization === undefined) return structured({ outcome: "worker_authentication_required", taskId: input.taskId, attemptId: input.attemptId, eventId: input.eventId, message: "This shipment mutation requires host authorization for the exact cycle arguments." }, true);
    if (options.config === undefined || options.transport === undefined) return structured({ outcome: "unknown", taskId: input.taskId, attemptId: input.attemptId, eventId: input.eventId, message: options.configurationError ?? "GitHub shipment cycle is unavailable because GitHub is not configured." }, true);
    const queue = new GitHubWriteQueue(); const store = RuntimeSqliteStore.open({ environment: options.environment });
    try {
      const github = new GitHubPullRequestGateway(options.transport, options.config, queue);
      const actions = new GitHubActionsGateway(options.transport, options.config);
      const ci = new GitHubCiGatewayAdapter(actions, options.config);
      const output = await new ShipmentCycleCoordinator(store, github, ci).run({ taskId: input.taskId as TaskId, attemptId: input.attemptId as AttemptId, eventId: input.eventId, correlationId, repository: { owner: "PiotrGry", repository: "zdrovena-reconciliation" }, headBranch: input.headBranch, baseBranch: "develop", expectedHeadSha: input.expectedHeadSha, provider: "github-actions", workflowName: workflow, completionMode: "exact_green", mergePolicy: { headPattern: "^pirx/poc-failure-", baseBranch: "develop", requiredChecks: [workflow], requiredApprovals: 0, mergeMethod: "squash", requireMergeable: true }, now: new Date().toISOString() as UtcTimestamp, ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }) });
      return structured(output, output.outcome !== "recovery_success" && output.outcome !== "retry_created");
    } catch { return structured({ outcome: "unknown", taskId: input.taskId, attemptId: input.attemptId, eventId: input.eventId, message: "Durable shipment cycle failed before a normalized result was produced." }, true); }
    finally { store.close(); await queue.close({ drain: true }); }
  });
}
