import { RuntimeStorageError } from "@pirx/orchestrator";
import type { RuntimeBindingCheck } from "../runtime-binding.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { verifyHostAuthorization } from "../authorization.js";

const execute = promisify(execFile);
export const ORCHESTRATOR_SERVICE = "pirx-orchestrator.service";
export type OrchestratorServiceResult = { readonly outcome: "start_requested" | "unconfigured" | "unsupported_platform" | "unavailable"; readonly message: string };
export interface OrchestratorServicePort { start(): Promise<OrchestratorServiceResult>; }

export class SystemdOrchestratorServicePort implements OrchestratorServicePort {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #platform: string;
  readonly #execute: typeof execute;
  readonly #checkBinding: RuntimeBindingCheck;
  public constructor(options: { readonly environment?: NodeJS.ProcessEnv; readonly platform?: string; readonly execute?: typeof execute; readonly checkBinding?: RuntimeBindingCheck } = {}) {
    this.#environment = options.environment ?? process.env;
    this.#platform = options.platform ?? process.platform;
    this.#execute = options.execute ?? execute;
    this.#checkBinding = options.checkBinding ?? (() => {});
  }
  public async start(): Promise<OrchestratorServiceResult> {
    if (this.#environment.PIRX_ORCHESTRATOR_SERVICE_ENABLED !== "true") return { outcome: "unconfigured", message: "Install the pirx-orchestrator user service and set PIRX_ORCHESTRATOR_SERVICE_ENABLED=true in the chat environment." };
    if (this.#platform !== "linux") return { outcome: "unsupported_platform", message: "Chat service startup currently supports Linux systemd user services." };
    try { this.#checkBinding(); }
    catch (error: unknown) { return { outcome: "unconfigured", message: error instanceof RuntimeStorageError ? error.message : "Runtime identity could not be verified; service start was not requested." }; }
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (this.#environment[key] !== undefined) env[key] = this.#environment[key];
    try {
      await this.#execute("/usr/bin/systemctl", ["--user", "start", "--no-block", ORCHESTRATOR_SERVICE], { shell: false, env, timeout: 5_000, maxBuffer: 4_096, encoding: "utf8" });
      return { outcome: "start_requested", message: "The user service manager accepted the start request. Read pirx_orchestrator_status to verify a fresh running heartbeat; this is not proof an Attempt started." };
    } catch {
      return { outcome: "unavailable", message: "The orchestrator user service could not be started. Check its installation and user service-manager availability." };
    }
  }
}

export function registerOrchestratorServiceTool(server: McpServer, options: { readonly port: OrchestratorServicePort; readonly authorizationSecret: string | undefined; readonly configurationError?: string }): void {
  server.registerTool("pirx_orchestrator_start", {
    title: "Start the supervised Pirx orchestrator",
    description: "Request startup of the installed pirx-orchestrator user service to process the configured GitHub Queue through leased Claude CLI workers. Does not select an arbitrary Issue or bypass Queue order. Verify status afterwards; start_requested is not proof of execution.",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ outcome: z.enum(["start_requested", "authorization_required", "unconfigured", "unsupported_platform", "unavailable"]), message: z.string() }),
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
  }, async (_input, context) => {
    const result = verifyHostAuthorization(options.authorizationSecret, context.mcpReq._meta, "pirx_orchestrator_start", {}) === undefined
      ? { outcome: "authorization_required", message: "Exact host authorization is required to start orchestration." }
      : options.configurationError !== undefined
        ? { outcome: "unconfigured", message: options.configurationError }
        : await options.port.start();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(result.outcome === "start_requested" ? {} : { isError: true }) };
  });
}
