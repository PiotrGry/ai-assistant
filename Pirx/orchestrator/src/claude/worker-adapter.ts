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

export interface ClaudeStructuredRunner {
  runStructured(request: { readonly requestId: string; readonly cwd: string; readonly prompt: string; readonly responseSchema: unknown; readonly signal?: AbortSignal; readonly timeoutMs?: number; readonly maxStdoutBytes?: number; readonly maxStderrBytes?: number }): Promise<ClaudeStructuredResult>;
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
}

export type ClaudeCodeProcessResult =
  | { readonly outcome: "success"; readonly requestId: string; readonly structuredOutput: unknown; readonly durationMs: number; readonly exitCode: 0 }
  | (ClaudeRoundTripFailure & { readonly outcome: Exclude<ClaudeRoundTripFailure["outcome"], "success"> })
  | { readonly outcome: "invalid_request" | "invalid_input"; readonly requestId: string; readonly message: string; readonly exitCode: null; readonly durationMs: 0 };

const DEFAULT_RESPONSE_SCHEMA = Object.freeze({ type: "object", additionalProperties: true });
const SECRET_PATTERN = /(token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_ -]?key|credential|connection[_ -]?string)/iu;

function failure(outcome: "invalid_request" | "invalid_input", requestId: string, text: string): ClaudeCodeProcessResult {
  return { outcome, requestId, message: text.slice(0, 256), exitCode: null, durationMs: 0 };
}
export class ClaudeCodeProcessAdapter implements WorkerPort {
  readonly #runner: ClaudeStructuredRunner;
  readonly #inputSource: ClaudeCodeInputSource;
  readonly #promptRenderer: ClaudeCodePromptRenderer;
  readonly #responseSchema: unknown;

  public constructor(options: ClaudeCodeAdapterOptions) {
    this.#runner = options.runner ?? new ClaudeCodeCliRunner();
    this.#inputSource = options.inputSource;
    this.#promptRenderer = options.promptRenderer;
    this.#responseSchema = options.responseSchema ?? DEFAULT_RESPONSE_SCHEMA;
  }

  public async run(request: unknown, signal: AbortSignal): Promise<ClaudeCodeProcessResult> {
    const startedAt = Date.now();
    const parsedRequest = validateWorkerRequest(request);
    if (!parsedRequest.ok) return failure("invalid_request", "unknown", "Worker request is invalid before Claude process invocation.");
    const value = parsedRequest.value;
    const input = this.#inputSource.create(value);
    if (!input.ok) return failure("invalid_input", value.correlationId, "Claude input could not be built from durable state.");
    if (input.value.taskId !== value.taskId || input.value.attemptId !== value.attemptId || input.value.correlationId !== value.correlationId || input.value.workspace.worktree !== value.workspace.worktree || input.value.workspace.branch !== value.workspace.branch) return failure("invalid_input", value.correlationId, "Claude input is not bound to the assigned worker request.");
    let prompt: string;
    try { prompt = this.#promptRenderer.render(input.value); } catch { return failure("invalid_input", value.correlationId, "Claude prompt rendering failed before process invocation."); }
    if (prompt.length === 0 || Buffer.byteLength(prompt, "utf8") > 64 * 1024 || SECRET_PATTERN.test(prompt)) return failure("invalid_input", value.correlationId, "Claude prompt is invalid or contains forbidden sensitive material.");
    const result = await this.#runner.runStructured({ requestId: value.correlationId, cwd: value.workspace.worktree, prompt, responseSchema: this.#responseSchema, signal, timeoutMs: value.limits.timeoutMs, maxStdoutBytes: value.limits.maxOutputBytes, maxStderrBytes: value.limits.maxErrorBytes });
    if (result.outcome !== "success") return result;
    return { outcome: "success", requestId: result.requestId, structuredOutput: result.structuredOutput, durationMs: Math.max(0, Date.now() - startedAt), exitCode: 0 };
  }

  public async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const processResult = await this.run(request, signal);
    if (processResult.outcome !== "success") throw new Error("Claude process did not produce a worker result.");
    const result = validateWorkerResult(processResult.structuredOutput, request);
    if (result.ok && !SECRET_PATTERN.test(JSON.stringify(result.value))) return result.value;
    throw new Error("Claude process returned an invalid worker result.");
  }
}

export function createClaudeCodeProcessAdapter(options: ClaudeCodeAdapterOptions): ClaudeCodeProcessAdapter { return new ClaudeCodeProcessAdapter(options); }
