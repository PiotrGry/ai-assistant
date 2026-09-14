import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLAUDE_ROUND_TRIP_OUTCOMES = [
  "success",
  "claude_not_installed",
  "authentication_required",
  "quota_exhausted",
  "timeout",
  "cancelled",
  "invalid_output",
  "process_error",
  "unknown",
] as const;
export type ClaudeRoundTripOutcome = (typeof CLAUDE_ROUND_TRIP_OUTCOMES)[number];

export const CLAUDE_CLI_ENV_ALLOWLIST = [
  "HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY",
  "ALL_PROXY", "NO_PROXY", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME",
  "XDG_DATA_HOME", "XDG_CACHE_HOME",
] as const;
export const DEFAULT_CLAUDE_TIMEOUT_MS = 30_000;
export const MAX_CLAUDE_TIMEOUT_MS = 120_000;
export const DEFAULT_CLAUDE_STDOUT_BYTES = 16 * 1024;
export const DEFAULT_CLAUDE_STDERR_BYTES = 16 * 1024;
export const MAX_CLAUDE_OUTPUT_BYTES = 64 * 1024;
export const CLAUDE_TERMINATION_GRACE_MS = 250;

export interface ClaudeRoundTripRequest {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface ClaudeRoundTripSuccess {
  readonly outcome: "success";
  readonly requestId: string;
  readonly acknowledgement: string;
  readonly durationMs: number;
  readonly exitCode: 0;
}
export interface ClaudeRoundTripFailure {
  readonly outcome: Exclude<ClaudeRoundTripOutcome, "success">;
  readonly requestId: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly message: string;
}
export type ClaudeRoundTripResult = ClaudeRoundTripSuccess | ClaudeRoundTripFailure;

export interface ClaudeSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: ["ignore", "pipe", "pipe"];
}
export type ClaudeSpawn = (file: string, args: readonly string[], options: ClaudeSpawnOptions) => ChildProcess;

export interface ClaudeCodeCliRunnerOptions {
  readonly executable?: string;
  readonly tempParentDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** Explicit non-secret test/runtime additions; arbitrary parent env is never copied. */
  readonly additionalEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly requestIdFactory?: () => string;
  readonly spawnProcess?: ClaudeSpawn;
  readonly terminationGraceMs?: number;
}

interface ClaudeJsonSchema {
  readonly $schema: "http://json-schema.org/draft-07/schema#";
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly ["requestId", "acknowledgement"];
  readonly properties: {
    readonly requestId: { readonly type: "string"; readonly const: string };
    readonly acknowledgement: { readonly type: "string"; readonly minLength: 1; readonly maxLength: 256 };
  };
}

const FAILURE_MESSAGES: Record<Exclude<ClaudeRoundTripOutcome, "success">, string> = {
  claude_not_installed: "Claude Code executable was not found.",
  authentication_required: "Claude Code authentication is required.",
  quota_exhausted: "Claude Code quota was exhausted.",
  timeout: "Claude Code round-trip timed out.",
  cancelled: "Claude Code round-trip was cancelled.",
  invalid_output: "Claude Code returned an invalid or oversized structured response.",
  process_error: "Claude Code process failed.",
  unknown: "Claude Code round-trip ended with an unknown result.",
};
const EXPLICIT_FAILURE_CODES = new Set(["authentication_required", "quota_exhausted"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value));
}
function boundedInteger(value: number | undefined, fallback: number, maximum: number): number | undefined {
  const result = value ?? fallback;
  return Number.isSafeInteger(result) && result > 0 && result <= maximum ? result : undefined;
}
function roundTripSchema(requestId: string): ClaudeJsonSchema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    additionalProperties: false,
    required: ["requestId", "acknowledgement"],
    properties: {
      requestId: { type: "string", const: requestId },
      acknowledgement: { type: "string", minLength: 1, maxLength: 256 },
    },
  };
}
export function buildClaudeArguments(requestId: string): readonly string[] {
  return [
    "--restricted", "-p", "--tools", "", "--disallowedTools", "mcp__*",
    "--permission-prompts", "none", "--disable-slash-commands",
    "--no-session-persistence", "--max-turns", "1", "--output-format", "json",
    "--json-schema", JSON.stringify(roundTripSchema(requestId)),
    `Acknowledge the literal payload "hello world". Use requestId "${requestId}" exactly. Return only the structured response required by the JSON schema.`,
  ];
}
function buildEnvironment(source: NodeJS.ProcessEnv, additional: Readonly<Record<string, string | undefined>> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CLAUDE_CLI_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(additional ?? {})) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
function explicitFailureCode(parsed: unknown, stderr: string): "authentication_required" | "quota_exhausted" | undefined {
  if (isRecord(parsed) && typeof parsed.error_code === "string" && EXPLICIT_FAILURE_CODES.has(parsed.error_code)) {
    return parsed.error_code as "authentication_required" | "quota_exhausted";
  }
  const marker = stderr.match(/\b(CLAUDE_AUTH_REQUIRED|CLAUDE_QUOTA_EXHAUSTED)\b/u)?.[1];
  return marker === "CLAUDE_AUTH_REQUIRED" ? "authentication_required" : marker === "CLAUDE_QUOTA_EXHAUSTED" ? "quota_exhausted" : undefined;
}
function failure(outcome: Exclude<ClaudeRoundTripOutcome, "success">, requestId: string, startedAt: number, exitCode: number | null): ClaudeRoundTripFailure {
  return { outcome, requestId, durationMs: Math.max(0, Date.now() - startedAt), exitCode, message: FAILURE_MESSAGES[outcome] };
}
function validateStructuredOutput(value: unknown, requestId: string): value is { requestId: string; acknowledgement: string } {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !Object.keys(value).every((key) => key === "requestId" || key === "acknowledgement")) return false;
  return value.requestId === requestId && typeof value.acknowledgement === "string" && value.acknowledgement.length > 0 && value.acknowledgement.length <= 256;
}

export class ClaudeCodeCliRunner {
  private readonly executable: string;
  private readonly tempParentDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly additionalEnvironment: Readonly<Record<string, string | undefined>> | undefined;
  private readonly requestIdFactory: () => string;
  private readonly spawnProcess: ClaudeSpawn;
  private readonly terminationGraceMs: number;

  public constructor(options: ClaudeCodeCliRunnerOptions = {}) {
    this.executable = options.executable?.trim() || "claude";
    this.tempParentDirectory = options.tempParentDirectory ?? tmpdir();
    this.environment = options.environment ?? process.env;
    this.additionalEnvironment = options.additionalEnvironment;
    this.requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.spawnProcess = options.spawnProcess ?? ((file, args, spawnOptions) => spawn(file, [...args], spawnOptions));
    this.terminationGraceMs = boundedInteger(options.terminationGraceMs, CLAUDE_TERMINATION_GRACE_MS, 5_000) ?? CLAUDE_TERMINATION_GRACE_MS;
  }

  public async run(request: ClaudeRoundTripRequest = {}): Promise<ClaudeRoundTripResult> {
    const requestId = this.requestIdFactory();
    const startedAt = Date.now();
    const timeoutMs = boundedInteger(request.timeoutMs, DEFAULT_CLAUDE_TIMEOUT_MS, MAX_CLAUDE_TIMEOUT_MS);
    const maxStdoutBytes = boundedInteger(request.maxStdoutBytes, DEFAULT_CLAUDE_STDOUT_BYTES, MAX_CLAUDE_OUTPUT_BYTES);
    const maxStderrBytes = boundedInteger(request.maxStderrBytes, DEFAULT_CLAUDE_STDERR_BYTES, MAX_CLAUDE_OUTPUT_BYTES);
    if (timeoutMs === undefined || maxStdoutBytes === undefined || maxStderrBytes === undefined) return failure("process_error", requestId, startedAt, null);
    if (request.signal?.aborted === true) return failure("cancelled", requestId, startedAt, null);
    let workingDirectory: string;
    try {
      workingDirectory = await mkdtemp(join(this.tempParentDirectory, "pirx-claude-round-trip-"));
    } catch {
      return failure("process_error", requestId, startedAt, null);
    }
    try {
      return await this.execute({ requestId, startedAt, workingDirectory, signal: request.signal, timeoutMs, maxStdoutBytes, maxStderrBytes });
    } finally {
      await rm(workingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async execute(input: {
    readonly requestId: string; readonly startedAt: number; readonly workingDirectory: string;
    readonly signal: AbortSignal | undefined; readonly timeoutMs: number;
    readonly maxStdoutBytes: number; readonly maxStderrBytes: number;
  }): Promise<ClaudeRoundTripResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitExceeded = false;
    let terminationStarted = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    let trigger: "timeout" | "cancelled" | "invalid_output" | undefined;
    let child: ChildProcess;
    const terminate = (): void => {
      if (terminationStarted) return;
      terminationStarted = true;
      try { child.kill("SIGTERM"); } catch { /* already exited */ }
      terminationTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, this.terminationGraceMs);
    };
    try {
      child = this.spawnProcess(this.executable, buildClaudeArguments(input.requestId), {
        cwd: input.workingDirectory,
        env: buildEnvironment(this.environment, this.additionalEnvironment),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      return failure(code === "ENOENT" ? "claude_not_installed" : "process_error", input.requestId, input.startedAt, null);
    }
    const append = (target: "stdout" | "stderr", value: unknown): void => {
      const chunk = asBuffer(value);
      if (target === "stdout") {
        const remaining = input.maxStdoutBytes - stdoutBytes;
        if (chunk.byteLength > remaining) { if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining)); stdoutBytes = input.maxStdoutBytes; outputLimitExceeded = true; }
        else { stdoutChunks.push(chunk); stdoutBytes += chunk.byteLength; }
      } else {
        const remaining = input.maxStderrBytes - stderrBytes;
        if (chunk.byteLength > remaining) { if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining)); stderrBytes = input.maxStderrBytes; outputLimitExceeded = true; }
        else { stderrChunks.push(chunk); stderrBytes += chunk.byteLength; }
      }
      if (outputLimitExceeded && trigger === undefined) { trigger = "invalid_output"; terminate(); }
    };
    child.stdout?.on("data", (value: unknown) => append("stdout", value));
    child.stderr?.on("data", (value: unknown) => append("stderr", value));
    let spawnError: NodeJS.ErrnoException | undefined;
    let exitCode: number | null = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => { if (!settled) { settled = true; resolve(); } };
      child.once("error", (error: Error) => { spawnError = error as NodeJS.ErrnoException; settle(); });
      child.once("close", (code: number | null) => { exitCode = code; settle(); });
      const timeout = setTimeout(() => { if (trigger === undefined) trigger = "timeout"; terminate(); }, input.timeoutMs);
      timeout.unref();
      const onAbort = (): void => { if (trigger === undefined) trigger = "cancelled"; terminate(); };
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => { clearTimeout(timeout); if (terminationTimer !== undefined) clearTimeout(terminationTimer); input.signal?.removeEventListener("abort", onAbort); };
      child.once("close", cleanup);
      child.once("error", cleanup);
    });
    if (trigger !== undefined) return failure(trigger, input.requestId, input.startedAt, exitCode);
    if (spawnError !== undefined) return failure(spawnError.code === "ENOENT" ? "claude_not_installed" : "process_error", input.requestId, input.startedAt, exitCode);
    if (exitCode === null) return failure("unknown", input.requestId, input.startedAt, exitCode);
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); }
    catch { return failure(explicitFailureCode(undefined, stderr) ?? (exitCode !== 0 ? "process_error" : "invalid_output"), input.requestId, input.startedAt, exitCode); }
    const explicit = explicitFailureCode(parsed, stderr);
    if (explicit !== undefined) return failure(explicit, input.requestId, input.startedAt, exitCode);
    if (exitCode !== 0) return failure("process_error", input.requestId, input.startedAt, exitCode);
    if (!isRecord(parsed) || parsed.type !== "result" || parsed.subtype !== "success" || parsed.is_error !== false) return failure("invalid_output", input.requestId, input.startedAt, exitCode);
    if (!validateStructuredOutput(parsed.structured_output, input.requestId)) return failure("invalid_output", input.requestId, input.startedAt, exitCode);
    return { outcome: "success", requestId: input.requestId, acknowledgement: parsed.structured_output.acknowledgement, durationMs: Math.max(0, Date.now() - input.startedAt), exitCode: 0 };
  }
}
