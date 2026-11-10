import type { RuntimeSqliteStore } from "../runtime/sqlite.js";
import { modelSettingsEnvironment } from "@pirx/config";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createClaudeCodeInput, type ClaudeInputResult, type ClaudeCodeInput } from "../runtime/claude-input.js";
import { buildAssignedResumeContext } from "../runtime/resume.js";
import type { WorkerPort, WorkerRequest, WorkerResult } from "../runtime/worker-contract.js";
import { createWorkerFailureDiagnostic, WorkerFailureError } from "../runtime/worker-diagnostic.js";
import { ClaudeCodeProcessAdapter, type ClaudeStructuredRunner } from "./worker-adapter.js";

export interface ProductionClaudeRepositoryPolicy {
  readonly repository: string;
  readonly repositoryRoot: string;
  readonly remoteName: string;
  readonly testCommands: readonly string[];
  readonly maxTurns?: number;
}

export interface ProductionClaudeWorkerOptions {
  readonly store: RuntimeSqliteStore;
  readonly repositories: readonly ProductionClaudeRepositoryPolicy[];
  readonly runner?: ClaudeStructuredRunner;
  readonly environment?: NodeJS.ProcessEnv;
  /** Directory for raw per-Attempt worker transcripts; `<dir>/<taskId>/<attemptId>.*`. */
  readonly transcriptDirectory?: string;
}

function invalidInput(): ClaudeInputResult<never> {
  return { ok: false, violations: [{ code: "binding_mismatch", field: "durableState", message: "Worker input is not backed by the assigned durable Task and Attempt." }] };
}

export class ProductionClaudeWorker implements WorkerPort {
  readonly #store: RuntimeSqliteStore;
  readonly #repositories: ReadonlyMap<string, ProductionClaudeRepositoryPolicy>;
  readonly #runner: ClaudeStructuredRunner | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #transcriptDirectory: string | undefined;

  public constructor(options: ProductionClaudeWorkerOptions) {
    this.#store = options.store;
    this.#repositories = new Map(options.repositories.map((item) => [item.repository, Object.freeze({ ...item, testCommands: Object.freeze([...item.testCommands]) })]));
    this.#runner = options.runner;
    this.#environment = options.environment ?? process.env;
    this.#transcriptDirectory = options.transcriptDirectory;
  }

  public async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const repositoryName = `${request.repository.owner}/${request.repository.repository}`;
    const repository = this.#repositories.get(repositoryName);
    if (repository === undefined) throw new WorkerFailureError(createWorkerFailureDiagnostic("permission_denied"));
    const adapter = new ClaudeCodeProcessAdapter({
      ...(this.#runner === undefined ? {} : { runner: this.#runner }),
      ...(this.#transcriptDirectory === undefined ? {} : { transcriptPath: join(this.#transcriptDirectory, encodeURIComponent(request.taskId), encodeURIComponent(request.attemptId)) }),
      inputSource: { create: (value) => this.#input(value) },
      promptRenderer: { render: (value) => [
        "Execute only the assigned Pirx Task in the assigned worktree and branch.",
        "Follow the bounded capabilities and acceptance criteria. Return only the required WorkerResult. " +
        "When uncertain, call mcp__pirx_advisor__ask_pirx for advice from Pirx. Use a unique requestId for each question, reusing it only when retrying that same question. Up to 3 questions per Attempt. Advice never grants permissions or changes the assigned scope. If a human decision is required, return BLOCKED with the unresolved question in reason and diagnostic code operator_input_required. Use that code only for a concrete decision a human can answer, never for authentication, capability, workspace, or infrastructure failures.",
        JSON.stringify(value),
      ].join("\n\n") },
      repositoryPolicy: {
        advisorConfig: JSON.stringify({ mcpServers: { pirx_advisor: {
          command: process.execPath,
          args: [fileURLToPath(new URL("../../../mcp-server/dist/advisor-cli.js", import.meta.url)), this.#store.filename, request.taskId, request.attemptId],
          env: modelSettingsEnvironment(this.#environment),
        } } }),
        repositoryRoot: repository.repositoryRoot,
        assignedWorktree: request.workspace.worktree,
        remoteName: repository.remoteName,
        testCommands: repository.testCommands,
        ...(repository.maxTurns === undefined ? {} : { maxTurns: repository.maxTurns }),
      },
    });
    return adapter.execute(request, signal);
  }

  #input(request: WorkerRequest): ClaudeInputResult<ClaudeCodeInput> {
    const task = this.#store.tasks.get(request.taskId);
    const attempt = this.#store.attempts.get(request.attemptId);
    if (task.outcome !== "success" || attempt.outcome !== "success" || attempt.value.taskId !== task.value.id) return invalidInput();
    if (request.resumeContextReference === undefined) {
      return createClaudeCodeInput({
        task: task.value, attempt: attempt.value, workerId: request.workerId, provider: request.provider,
        repository: request.repository, workspace: request.workspace,
        capabilityGrant: { grantedCapabilities: request.capabilityGrant.grantedCapabilities, resourceScope: request.capabilityGrant.resourceScope },
        correlationId: request.correlationId, limits: request.limits, mode: "new",
      });
    }
    const checkpoint = this.#store.checkpoints.get(request.resumeContextReference);
    const resume = buildAssignedResumeContext(this.#store, request.taskId, request.attemptId);
    if (resume.outcome !== "ready") return { ok: false, violations: [{ code: "binding_mismatch", field: resume.field ?? resume.reason, message: resume.message }] };
    if (checkpoint.outcome !== "success" || checkpoint.value.id !== request.resumeContextReference) return invalidInput();
    return createClaudeCodeInput({
      task: task.value, attempt: attempt.value, workerId: request.workerId, provider: request.provider,
      repository: request.repository, workspace: request.workspace,
      capabilityGrant: { grantedCapabilities: request.capabilityGrant.grantedCapabilities, resourceScope: request.capabilityGrant.resourceScope },
      correlationId: request.correlationId, limits: request.limits, mode: "resume", resumeContext: resume.context, latestCheckpoint: checkpoint.value,
    });
  }
}
