import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CODEX_HANDOFF_OUTCOMES = ["success", "authentication_required", "quota_exhausted", "timeout", "cancelled", "invalid_output", "process_error", "unknown"] as const;
export type CodexHandoffOutcome = (typeof CODEX_HANDOFF_OUTCOMES)[number];

export interface CodexHandoffRequest {
  readonly handoffId: string;
  readonly envelope: unknown;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly signal?: AbortSignal;
}

export interface CodexHandoffSuccess { readonly outcome: "success"; readonly requestId: string; readonly acknowledgement: string; readonly durationMs: number; readonly exitCode: 0; }
export interface CodexHandoffFailure { readonly outcome: Exclude<CodexHandoffOutcome, "success">; readonly requestId: string; readonly durationMs: number; readonly exitCode: number | null; readonly message: string; }
export type CodexHandoffResult = CodexHandoffSuccess | CodexHandoffFailure;

export interface CodexSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: ["pipe", "pipe", "pipe"];
}
export type CodexSpawn = (file: string, args: readonly string[], options: CodexSpawnOptions) => ChildProcess;

export interface CodexCliRunnerOptions {
  readonly executable?: string;
  readonly tempParentDirectory?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly requestIdFactory?: () => string;
  readonly spawnProcess?: CodexSpawn;
  readonly terminationGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TERMINATION_GRACE_MS = 250;
const ENV_ALLOWLIST = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "CODEX_HOME", "NO_PROXY", "HTTPS_PROXY", "HTTP_PROXY"] as const;

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function bounded(value: number | undefined, fallback: number, maximum: number): number | undefined { const result = value ?? fallback; return Number.isSafeInteger(result) && result > 0 && result <= maximum ? result : undefined; }
function failure(outcome: Exclude<CodexHandoffOutcome, "success">, requestId: string, startedAt: number, exitCode: number | null, message: string): CodexHandoffFailure { return { outcome, requestId, durationMs: Math.max(0, Date.now() - startedAt), exitCode, message }; }
function buildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv { return Object.fromEntries(ENV_ALLOWLIST.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]!]])); }
function structuredSchema(requestId: string): Record<string, unknown> { return { type: "object", additionalProperties: false, required: ["requestId", "acknowledgement"], properties: { requestId: { type: "string", const: requestId }, acknowledgement: { type: "string", minLength: 1, maxLength: 256 } } }; }
function validReceipt(value: unknown, requestId: string): value is { requestId: string; acknowledgement: string } { return isRecord(value) && Object.keys(value).length === 2 && value.requestId === requestId && typeof value.acknowledgement === "string" && value.acknowledgement.length > 0 && value.acknowledgement.length <= 256; }
function classify(stderr: string): "authentication_required" | "quota_exhausted" | undefined { if (/not authenticated|authentication required|login required|unauthorized|401\b/iu.test(stderr)) return "authentication_required"; if (/quota|rate limit|429\b|limit exceeded/iu.test(stderr)) return "quota_exhausted"; return undefined; }

export function buildCodexHandoffArguments(schemaPath: string, outputPath: string): readonly string[] {
  return ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--output-schema", schemaPath, "--output-last-message", outputPath, "--json", "-"];
}

export class CodexCliRunner {
  readonly #executable: string;
  readonly #tempParentDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #requestIdFactory: () => string;
  readonly #spawnProcess: CodexSpawn;
  readonly #terminationGraceMs: number;

  constructor(options: CodexCliRunnerOptions = {}) {
    this.#executable = options.executable?.trim() || "codex";
    this.#tempParentDirectory = options.tempParentDirectory ?? tmpdir();
    this.#environment = options.environment ?? process.env;
    this.#requestIdFactory = options.requestIdFactory ?? randomUUID;
    this.#spawnProcess = options.spawnProcess ?? ((file, args, spawnOptions) => spawn(file, [...args], spawnOptions));
    this.#terminationGraceMs = bounded(options.terminationGraceMs, TERMINATION_GRACE_MS, 5_000) ?? TERMINATION_GRACE_MS;
  }

  async runHandoff(request: CodexHandoffRequest): Promise<CodexHandoffResult> {
    const requestId = request.handoffId || this.#requestIdFactory();
    const startedAt = Date.now();
    const timeoutMs = bounded(request.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const maxStdoutBytes = bounded(request.maxStdoutBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    const maxStderrBytes = bounded(request.maxStderrBytes, DEFAULT_OUTPUT_BYTES, MAX_OUTPUT_BYTES);
    if (timeoutMs === undefined || maxStdoutBytes === undefined || maxStderrBytes === undefined) return failure("process_error", requestId, startedAt, null, "Codex handoff bounds are invalid.");
    if (request.signal?.aborted === true) return failure("cancelled", requestId, startedAt, null, "Codex handoff was cancelled.");
    let payload: string;
    try { payload = JSON.stringify(request.envelope); } catch { return failure("invalid_output", requestId, startedAt, null, "Codex handoff envelope is not JSON serializable."); }
    if (Buffer.byteLength(payload, "utf8") > MAX_OUTPUT_BYTES) return failure("invalid_output", requestId, startedAt, null, "Codex handoff envelope is too large.");
    let cwd: string;
    try { cwd = await mkdtemp(join(this.#tempParentDirectory, "pirx-codex-handoff-")); } catch { return failure("process_error", requestId, startedAt, null, "Codex handoff workspace could not be created."); }
    const schemaPath = join(cwd, "receipt-schema.json");
    const outputPath = join(cwd, "receipt.json");
    try {
      await writeFile(schemaPath, JSON.stringify(structuredSchema(requestId)), { encoding: "utf8", mode: 0o600 });
      const prompt = `Acknowledge this structured failure handoff. Do not edit files, run commands, use tools, inspect repositories, or continue any session. Return only JSON matching the supplied schema with requestId "${requestId}" and a short acknowledgement. Payload: ${payload}`;
      const child = this.#spawnProcess(this.#executable, buildCodexHandoffArguments(schemaPath, outputPath), { cwd, env: buildEnvironment(this.#environment), shell: false, stdio: ["pipe", "pipe", "pipe"] });
      return await this.#wait(child, prompt, outputPath, requestId, startedAt, timeoutMs, maxStdoutBytes, maxStderrBytes, request.signal);
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      return failure(code === "ENOENT" ? "authentication_required" : "process_error", requestId, startedAt, null, "Codex handoff process failed to start.");
    } finally { await rm(cwd, { recursive: true, force: true }).catch(() => undefined); }
  }

  async #wait(child: ChildProcess, prompt: string, outputPath: string, requestId: string, startedAt: number, timeoutMs: number, maxStdoutBytes: number, maxStderrBytes: number, signal: AbortSignal | undefined): Promise<CodexHandoffResult> {
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let trigger: "timeout" | "cancelled" | "invalid_output" | undefined; let terminating = false; let timer: NodeJS.Timeout | undefined; let exitCode: number | null = null; let spawnError: NodeJS.ErrnoException | undefined;
    const terminate = () => { if (terminating) return; terminating = true; try { child.kill("SIGTERM"); } catch { /* already exited */ } timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } }, this.#terminationGraceMs); };
    const append = (target: "stdout" | "stderr", value: unknown) => { const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value)); if (target === "stdout") { const remaining = maxStdoutBytes - stdout.byteLength; stdout = Buffer.concat([stdout, buffer.subarray(0, Math.max(0, remaining))]); if (buffer.byteLength > remaining && trigger === undefined) { trigger = "invalid_output"; terminate(); } } else { const remaining = maxStderrBytes - stderr.byteLength; stderr = Buffer.concat([stderr, buffer.subarray(0, Math.max(0, remaining))]); if (buffer.byteLength > remaining && trigger === undefined) { trigger = "invalid_output"; terminate(); } } };
    child.stdout?.on("data", (value: unknown) => append("stdout", value)); child.stderr?.on("data", (value: unknown) => append("stderr", value));
    const close = new Promise<void>((resolve) => { let settled = false; const settle = () => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); }; const abort = () => { if (trigger === undefined) trigger = "cancelled"; terminate(); }; timer = setTimeout(() => { if (trigger === undefined) trigger = "timeout"; terminate(); }, timeoutMs); timer.unref(); signal?.addEventListener("abort", abort, { once: true }); child.on("error", (error: Error) => { spawnError ??= error as NodeJS.ErrnoException; }); child.once("close", (code: number | null) => { exitCode = code; settle(); }); });
    child.stdin?.end(prompt);
    await close;
    if (trigger !== undefined) return failure(trigger, requestId, startedAt, exitCode, trigger === "timeout" ? "Codex handoff timed out." : trigger === "cancelled" ? "Codex handoff was cancelled." : "Codex returned oversized output.");
    const errorCode = classify(stderr.toString("utf8"));
    if (errorCode !== undefined) return failure(errorCode, requestId, startedAt, exitCode, errorCode === "quota_exhausted" ? "Codex quota or rate limit was exhausted." : "Codex authentication is required.");
    if (spawnError !== undefined) return failure("process_error", requestId, startedAt, exitCode, "Codex handoff process failed.");
    if (exitCode !== 0) return failure("process_error", requestId, startedAt, exitCode, "Codex returned a process failure.");
    let parsed: unknown;
    try { parsed = JSON.parse((await readFile(outputPath, "utf8")).trim()); } catch { return failure("invalid_output", requestId, startedAt, exitCode, "Codex did not produce a schema-valid receipt."); }
    if (!validReceipt(parsed, requestId)) return failure("invalid_output", requestId, startedAt, exitCode, "Codex did not produce a schema-valid receipt.");
    return { outcome: "success", requestId, acknowledgement: parsed.acknowledgement, durationMs: Math.max(0, Date.now() - startedAt), exitCode: 0 };
  }
}
