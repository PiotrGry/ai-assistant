import {
  ClaudeCodeCliRunner,
  type ClaudeRoundTripFailure,
  type ClaudeStructuredResult,
} from "./cli-runner.js";
import {
  validateClaudeCodeInput,
  type ClaudeCodeInput,
  type ClaudeInputResult,
} from "../runtime/claude-input.js";
import {
  validateWorkerRequest,
  validateWorkerResult,
  type WorkerPort,
  type WorkerRequest,
  type WorkerResult,
} from "../runtime/worker-contract.js";
import { realpath } from "node:fs/promises";
import {
  buildClaudeCodeWorkerProfile,
  buildWorkerResultSchema,
  type ClaudeCodeRepositoryPolicy,
} from "./worker-profile.js";
import { GitWorkerStateVerifier, type WorkerGitStateVerifier } from "./git-state.js";
import { createWorkerFailureDiagnostic, WorkerFailureError } from "../runtime/worker-diagnostic.js";

export interface ClaudeStructuredRunner {
  runStructured(request: { readonly requestId: string; readonly cwd: string; readonly prompt: string; readonly responseSchema: unknown; readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly maxStdoutBytes?: number; readonly maxStderrBytes?: number; readonly workerProfile?: import("./worker-profile.js").ClaudeCodeWorkerProfile }): Promise<ClaudeStructuredResult>;
}

export interface ClaudeCodeInputSource {
  create(request: WorkerRequest): ClaudeInputResult<ClaudeCodeInput>;
}

export interface ClaudeCodePromptRenderer {
  render(input: ClaudeCodeInput): string;
}

export interface ClaudeCodeAdapterOptions {
  readonly runner?: ClaudeStructuredRunner;
  readonly inputSource: ClaudeCodeInputSource;
  readonly promptRenderer: ClaudeCodePromptRenderer;
  readonly responseSchema?: unknown;
  readonly repositoryPolicy?: ClaudeCodeRepositoryPolicy;
  readonly gitStateVerifier?: WorkerGitStateVerifier;
}

export type ClaudeCodeProcessResult =
  | { readonly outcome: "success"; readonly requestId: string; readonly structuredOutput: unknown; readonly durationMs: number; readonly exitCode: 0 }
  | (ClaudeRoundTripFailure & { readonly outcome: Exclude<ClaudeRoundTripFailure["outcome"], "success"> })
  | { readonly outcome: "invalid_request" | "invalid_input"; readonly requestId: string; readonly message: string; readonly exitCode: null; readonly durationMs: 0; readonly diagnostic: ReturnType<typeof createWorkerFailureDiagnostic> };

const DEFAULT_RESPONSE_SCHEMA = Object.freeze({ type: "object", additionalProperties: true });
const SECRET_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_ -]?key|credential|connection[_ -]?string)/iu;
// Prompt policy text may legitimately mention sensitive-data categories.  At
// this boundary reject secret-shaped values, while keeping the broad contract
// guard for untrusted WorkerResult fields below.
const PROMPT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/iu,
  /\b(?:proxy-)?authorization\s*:\s*[^\r\n]+/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/iu,
  /\b(?:cookie|set-cookie)\s*:\s*[^\r\n]+/iu,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|connection(?:[_ -]?string)?)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/iu,
  /\b(?:ghp_|github_pat_|xox[baprs]-|sk-[A-Za-z0-9_-])[A-Za-z0-9._-]+/u,
];

function containsPromptSecret(value: string): boolean {
  return PROMPT_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function failure(outcome: "invalid_request" | "invalid_input", requestId: string, text: string, code: "binding_mismatch" | "permission_denied" | "adapter_failure" = "binding_mismatch"): ClaudeCodeProcessResult {
  return { outcome, requestId, message: text.slice(0, 256), exitCode: null, durationMs: 0, diagnostic: createWorkerFailureDiagnostic(code) };
}
export class ClaudeCodeProcessAdapter implements WorkerPort {
  readonly #runner: ClaudeStructuredRunner;
  readonly #inputSource: ClaudeCodeInputSource;
  readonly #promptRenderer: ClaudeCodePromptRenderer;
  readonly #responseSchema: unknown;
  readonly #repositoryPolicy: ClaudeCodeRepositoryPolicy | undefined;
  readonly #gitStateVerifier: WorkerGitStateVerifier | undefined;

  public constructor(options: ClaudeCodeAdapterOptions) {
    this.#runner = options.runner ?? new ClaudeCodeCliRunner();
    this.#inputSource = options.inputSource;
    this.#promptRenderer = options.promptRenderer;
    this.#responseSchema = options.responseSchema ?? DEFAULT_RESPONSE_SCHEMA;
    this.#repositoryPolicy = options.repositoryPolicy;
    this.#gitStateVerifier = options.repositoryPolicy === undefined ? undefined : options.gitStateVerifier ?? new GitWorkerStateVerifier();
  }

  public async run(request: unknown, signal: AbortSignal): Promise<ClaudeCodeProcessResult> {
    const startedAt = Date.now();
    const parsedRequest = validateWorkerRequest(request);
    if (!parsedRequest.ok) return failure("invalid_request", "unknown", "Worker request is invalid before Claude process invocation.");
    const value = parsedRequest.value;
    let workerProfile;
    if (this.#repositoryPolicy !== undefined) {
      let canonicalWorktree: string;
      try { canonicalWorktree = await realpath(value.workspace.worktree); } catch { return failure("invalid_input", value.correlationId, "Assigned worker worktree is not accessible."); }
      if (canonicalWorktree !== this.#repositoryPolicy.assignedWorktree) return failure("invalid_input", value.correlationId, "Assigned worker worktree is not the configured canonical worktree.");
      const profile = buildClaudeCodeWorkerProfile(value, this.#repositoryPolicy);
      if (!profile.ok) return failure("invalid_input", value.correlationId, "Worker capability or repository policy is invalid.", "permission_denied");
      workerProfile = profile.value;
    }
    const input = this.#inputSource.create(value);
    if (!input.ok) return failure("invalid_input", value.correlationId, "Claude input could not be built from durable state.", "binding_mismatch");
    if (input.value.taskId !== value.taskId || input.value.attemptId !== value.attemptId || input.value.correlationId !== value.correlationId || input.value.workspace.worktree !== value.workspace.worktree || input.value.workspace.branch !== value.workspace.branch) return failure("invalid_input", value.correlationId, "Claude input is not bound to the assigned worker request.");
    let prompt: string;
    try { prompt = this.#promptRenderer.render(input.value); } catch { return failure("invalid_input", value.correlationId, "Claude prompt rendering failed before process invocation."); }
    if (prompt.length === 0 || Buffer.byteLength(prompt, "utf8") > 64 * 1024 || containsPromptSecret(prompt)) return failure("invalid_input", value.correlationId, "Claude prompt is invalid or contains forbidden sensitive material.", "permission_denied");
    const result = await this.#runner.runStructured({ requestId: value.correlationId, cwd: value.workspace.worktree, prompt, responseSchema: this.#repositoryPolicy === undefined ? this.#responseSchema : buildWorkerResultSchema(value), ...(workerProfile === undefined ? {} : { workerProfile }), signal, timeoutMs: value.limits.timeoutMs, maxStdoutBytes: value.limits.maxOutputBytes, maxStderrBytes: value.limits.maxErrorBytes });
    if (result.outcome !== "success") return result;
    return { outcome: "success", requestId: result.requestId, structuredOutput: result.structuredOutput, durationMs: Math.max(0, Date.now() - startedAt), exitCode: 0 };
  }

  public async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const processResult = await this.run(request, signal);
    if (processResult.outcome !== "success") throw new WorkerFailureError(processResult.diagnostic);
    const result = validateWorkerResult(processResult.structuredOutput, request);
    if (!result.ok) throw new WorkerFailureError(createWorkerFailureDiagnostic(result.violations.some((item) => item.code === "binding_mismatch") ? "binding_mismatch" : "worker_contract_mismatch"));
    if (SECRET_PATTERN.test(JSON.stringify(result.value))) throw new WorkerFailureError(createWorkerFailureDiagnostic("worker_contract_mismatch"));
    if (result.ok && result.value.outcome === "CODE_PUSHED" && this.#repositoryPolicy !== undefined && this.#gitStateVerifier !== undefined) {
      const verified = await this.#gitStateVerifier.verify(request, result.value, this.#repositoryPolicy);
      if (!verified.ok) throw new WorkerFailureError(createWorkerFailureDiagnostic("git_state_mismatch"));
    }
    return result.value;
  }
}

export function createClaudeCodeProcessAdapter(options: ClaudeCodeAdapterOptions): ClaudeCodeProcessAdapter { return new ClaudeCodeProcessAdapter(options); }
