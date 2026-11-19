import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

/**
 * Reads the code health snapshot scripts/code-health.sh writes on a timer: coverage per file
 * and TODO/FIXME markers on the current origin/develop. Read-only and instant; the expensive
 * test run happens outside the model's turn.
 */
export function registerCodeHealthTool(server: McpServer, reportPath: string): void {
  server.registerTool("zdrovena_code_health", {
    title: "Read zdrovena code health",
    description: "Latest code health snapshot of zdrovena-reconciliation develop: total test coverage, the least-covered files (percent, missing statement count and missing line ranges) and TODO/FIXME markers, with the commit and time it was measured. Use it to find concrete, testable improvements when the backlog has no ready work. Read-only.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }).strict(),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    let result: Record<string, unknown>;
    try {
      const report = JSON.parse(await readFile(reportPath, "utf8")) as { weakestFiles?: unknown[] } & Record<string, unknown>;
      result = { outcome: "success", ...report, weakestFiles: (report.weakestFiles ?? []).slice(0, input.limit ?? 10) };
    } catch (error: unknown) {
      result = { outcome: "unavailable", message: `No code health snapshot at ${reportPath} yet; it is written by scripts/code-health.sh (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).` };
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(result.outcome === "success" ? {} : { isError: true }) };
  });
}
