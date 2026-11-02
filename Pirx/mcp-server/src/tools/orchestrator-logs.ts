import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { diagnosticContext } from "@pirx/orchestrator";

const execute = promisify(execFile);
export interface OrchestratorLogEntry { readonly cursor: string; readonly timestamp: string; readonly message: string; readonly priority?: string; }
export type OrchestratorLogsResult = { readonly outcome: "success"; readonly entries: readonly OrchestratorLogEntry[]; readonly nextBeforeCursor?: string } | { readonly outcome: "unavailable" | "invalid_request" | "unsupported_platform" | "invalid_data"; readonly message: string };
export interface OrchestratorLogsPort { read(limit: number, beforeCursor?: string): Promise<OrchestratorLogsResult>; }
const CURSOR = /^[A-Za-z0-9=;_:+./-]{1,2048}$/u;

export class SystemdOrchestratorLogsPort implements OrchestratorLogsPort {
  readonly #platform: string;
  readonly #execute: typeof execute;
  readonly #environment: NodeJS.ProcessEnv;
  public constructor(options: { readonly platform?: string; readonly execute?: typeof execute; readonly environment?: NodeJS.ProcessEnv } = {}) { this.#platform = options.platform ?? process.platform; this.#execute = options.execute ?? execute; this.#environment = options.environment ?? process.env; }
  public async read(limit: number, beforeCursor?: string): Promise<OrchestratorLogsResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (beforeCursor !== undefined && !CURSOR.test(beforeCursor))) return { outcome: "invalid_request", message: "Log limit or cursor is invalid." };
    if (this.#platform !== "linux") return { outcome: "unsupported_platform", message: "Daemon journal access requires Linux systemd." };
    const args = ["--user", "--unit=pirx-orchestrator.service", "--output=json", "--no-pager", "--reverse", `--lines=${limit + 2}`];
    if (beforeCursor !== undefined) args.push(`--cursor=${beforeCursor}`);
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "USER", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (this.#environment[key] !== undefined) env[key] = this.#environment[key];
    try {
      const { stdout } = await this.#execute("/usr/bin/journalctl", args, { shell: false, env, timeout: 5_000, maxBuffer: 1_048_576, encoding: "utf8" });
      const parsed: OrchestratorLogEntry[] = [];
      for (const line of stdout.split("\n").filter((item) => item.trim().length > 0)) {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (beforeCursor !== undefined && row.__CURSOR === beforeCursor) continue;
        if (typeof row.__CURSOR !== "string" || !CURSOR.test(row.__CURSOR) || typeof row.__REALTIME_TIMESTAMP !== "string" || !/^\d+$/u.test(row.__REALTIME_TIMESTAMP) || typeof row.MESSAGE !== "string") return { outcome: "invalid_data", message: "A journal entry has an unsupported shape." };
        let message: string;
        try { message = JSON.stringify(diagnosticContext(JSON.parse(row.MESSAGE))); }
        catch { message = String(diagnosticContext(row.MESSAGE)); }
        parsed.push({ cursor: row.__CURSOR, timestamp: new Date(Number(row.__REALTIME_TIMESTAMP) / 1_000).toISOString(), message, ...(typeof row.PRIORITY === "string" ? { priority: row.PRIORITY } : {}) });
      }
      const entries = parsed.slice(0, limit);
      return { outcome: "success", entries, ...(parsed.length > limit ? { nextBeforeCursor: entries.at(-1)!.cursor } : {}) };
    } catch { return { outcome: "unavailable", message: "Daemon journal could not be read: service access, cursor, output size, or journalctl failed. No entries were silently discarded." }; }
  }
}

export function registerOrchestratorLogTool(server: McpServer, port: OrchestratorLogsPort): void {
  server.registerTool("pirx_orchestrator_logs", {
    title: "Read Pirx daemon journal",
    description: "Read the daemon's own systemd journal, newest first. Follow nextBeforeCursor as beforeCursor for older entries. Only pirx-orchestrator.service is accessible. Returns sanitized complete messages and timestamps; no shell or arbitrary unit access.",
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional(), beforeCursor: z.string().max(2048).regex(CURSOR).optional() }).strict(),
    outputSchema: z.union([z.object({ outcome: z.literal("success"), entries: z.array(z.object({ cursor: z.string(), timestamp: z.string(), message: z.string(), priority: z.string().optional() })), nextBeforeCursor: z.string().optional() }), z.object({ outcome: z.enum(["unavailable", "invalid_request", "unsupported_platform", "invalid_data"]), message: z.string() })]),
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    const result = await port.read(input.limit ?? 20, input.beforeCursor);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(result.outcome === "success" ? {} : { isError: true }) };
  });
}
