import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const execute = promisify(execFile);

export interface ProductionErrorGroup {
  readonly kind: "exception" | "error_trace" | "failed_request";
  readonly role: string;
  readonly message: string;
  readonly count: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly operation?: string;
}
export type ProductionErrorsResult =
  | { readonly outcome: "success"; readonly hours: number; readonly groups: readonly ProductionErrorGroup[] }
  | { readonly outcome: "unconfigured" | "unavailable" | "invalid_request"; readonly message: string };
export interface ProductionErrorsPort { read(hours: number): Promise<ProductionErrorsResult>; }

/**
 * Errors the running app reported itself: exceptions, traces at severity Error or worse, and
 * failed requests, grouped by message. The query is fixed; the model only chooses the window.
 */
// "kind" is a KQL keyword, so the column is "source".
export function productionErrorsQuery(hours: number): string {
  return [
    `let since = ago(${hours}h);`,
    "union",
    " (exceptions | where timestamp > since | extend source = 'exception', msg = coalesce(outerMessage, problemId, type)),",
    " (traces | where timestamp > since and severityLevel >= 3 | extend source = 'error_trace', msg = message),",
    " (requests | where timestamp > since and success == false | extend source = 'failed_request', msg = strcat(resultCode, ' ', name))",
    "| summarize count = count(), firstSeen = min(timestamp), lastSeen = max(timestamp), operation = take_any(operation_Name) by source, role = cloud_RoleName, message = substring(msg, 0, 300)",
    "| top 30 by lastSeen desc",
  ].join("\n");
}

export class AzureCliProductionErrorsPort implements ProductionErrorsPort {
  readonly #app: string | undefined;
  readonly #resourceGroup: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #execute: typeof execute;
  public constructor(options: { readonly app?: string; readonly resourceGroup?: string; readonly environment?: NodeJS.ProcessEnv; readonly execute?: typeof execute }) {
    this.#app = options.app; this.#resourceGroup = options.resourceGroup; this.#environment = options.environment ?? process.env; this.#execute = options.execute ?? execute;
  }
  public async read(hours: number): Promise<ProductionErrorsResult> {
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) return { outcome: "invalid_request", message: "hours must be a whole number from 1 to 168." };
    if (this.#app === undefined || this.#resourceGroup === undefined) return { outcome: "unconfigured", message: "Set PIRX_APP_INSIGHTS_APP and PIRX_APP_INSIGHTS_RESOURCE_GROUP to read production errors." };
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "USER", "PATH", "LANG", "AZURE_CONFIG_DIR"]) if (this.#environment[key] !== undefined) env[key] = this.#environment[key];
    try {
      const { stdout } = await this.#execute("az", ["monitor", "app-insights", "query", "--app", this.#app, "--resource-group", this.#resourceGroup, "--analytics-query", productionErrorsQuery(hours), "--output", "json"], { shell: false, env, timeout: 60_000, maxBuffer: 4_194_304, encoding: "utf8" });
      return { outcome: "success", hours, groups: parseGroups(stdout) };
    } catch (error: unknown) {
      // az prints the query back on failure; keep its own "ERROR:" line, not a line of the query.
      const detail = error instanceof Error ? error.message.split("\n").find((line) => line.startsWith("ERROR:")) ?? error.message.split("\n")[0] : String(error);
      return { outcome: "unavailable", message: `Application Insights could not be read: ${(detail ?? "").slice(0, 300)}` };
    }
  }
}

export function parseGroups(stdout: string): readonly ProductionErrorGroup[] {
  const value = JSON.parse(stdout) as { tables?: Array<{ columns: Array<{ name: string }>; rows: unknown[][] }> };
  const table = value.tables?.[0];
  if (table === undefined) return [];
  const at = (name: string) => table.columns.findIndex((column) => column.name === name);
  const [kind, role, message, count, firstSeen, lastSeen, operation] = ["source", "role", "message", "count", "firstSeen", "lastSeen", "operation"].map(at);
  return table.rows.map((row) => ({
    kind: String(row[kind!]) as ProductionErrorGroup["kind"],
    role: String(row[role!] ?? ""),
    message: String(row[message!] ?? ""),
    count: Number(row[count!]),
    firstSeen: String(row[firstSeen!]),
    lastSeen: String(row[lastSeen!]),
    ...(row[operation!] ? { operation: String(row[operation!]) } : {}),
  }));
}

export function registerProductionErrorsTool(server: McpServer, port: ProductionErrorsPort): void {
  server.registerTool("zdrovena_production_errors", {
    title: "Read zdrovena production errors",
    description: "Errors the zdrovena app reported itself in Application Insights: exceptions, traces at severity Error or worse, and failed requests, grouped by message with counts and first/last seen. Read-only. Choose the window in hours (1-168, default 24); an empty list means no errors were recorded in that window.",
    inputSchema: z.object({ hours: z.number().int().min(1).max(168).optional() }).strict(),
    outputSchema: z.union([
      z.object({ outcome: z.literal("success"), hours: z.number(), groups: z.array(z.object({ kind: z.enum(["exception", "error_trace", "failed_request"]), role: z.string(), message: z.string(), count: z.number(), firstSeen: z.string(), lastSeen: z.string(), operation: z.string().optional() })) }),
      z.object({ outcome: z.enum(["unconfigured", "unavailable", "invalid_request"]), message: z.string() }),
    ]),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    const result = await port.read(input.hours ?? 24);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(result.outcome === "success" ? {} : { isError: true }) };
  });
}
