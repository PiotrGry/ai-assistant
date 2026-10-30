import type { RuntimeSqliteStore } from "../runtime/sqlite.js";
import { createClaudeCodeInput, type ClaudeInputResult, type ClaudeCodeInput } from "../runtime/claude-input.js";
import { buildResumeContext } from "../runtime/resume.js";
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
}

function invalidInput(): ClaudeInputResult<never> {
  return { ok: false, violations: [{ code: "binding_mismatch", field: "durableState", message: "Worker input is not backed by the assigned durable Task and Attempt." }] };
}

export class ProductionClaudeWorker implements WorkerPort {
  readonly #store: RuntimeSqliteStore;
  readonly #repositories: ReadonlyMap<string, ProductionClaudeRepositoryPolicy>;
  readonly #runner: ClaudeStructuredRunner | undefined;

  public constructor(options: ProductionClaudeWorkerOptions) {
    this.#store = options.store;
    this.#repositories = new Map(options.repositories.map((item) => [item.repository, Object.freeze({ ...item, testCommands: Object.freeze([...item.testCommands]) })]));
    this.#runner = options.runner;
  }

  public async execute(request: WorkerRequest, signal: AbortSignal): Promise<WorkerResult> {
    const repositoryName = `${request.repository.owner}/${request.repository.repository}`;
    const repository = this.#repositories.get(repositoryName);
    if (repository === undefined) throw new WorkerFailureError(createWorkerFailureDiagnostic("permission_denied"));
    const adapter = new ClaudeCodeProcessAdapter({
      ...(this.#runner === undefined ? {} : { runner: this.#runner }),
      inputSource: { create: (value) => this.#input(value) },
      promptRenderer: { render: (value) => [
        "Execute only the assigned Pirx Task in the assigned worktree and branch.",
        "Follow the bounded capabilities and acceptance criteria. Return only the required WorkerResult.",
        JSON.stringify(value),
      ].join("\n\n") },
      repositoryPolicy: {
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
    const resume = buildResumeContext(this.#store, request.taskId, { check: () => ({ repository: "present", branch: "present", worktree: "present", currentCommit: "present" }) });
    if (checkpoint.outcome !== "success" || resume.outcome !== "ready" || checkpoint.value.id !== request.resumeContextReference) return invalidInput();
    return createClaudeCodeInput({
      task: task.value, attempt: attempt.value, workerId: request.workerId, provider: request.provider,
      repository: request.repository, workspace: request.workspace,
      capabilityGrant: { grantedCapabilities: request.capabilityGrant.grantedCapabilities, resourceScope: request.capabilityGrant.resourceScope },
      correlationId: request.correlationId, limits: request.limits, mode: "resume", resumeContext: resume.context, latestCheckpoint: checkpoint.value,
    });
  }
}
