import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import type { AttemptId, TaskId } from "./task-domain.js";

export const WORKSPACE_PROVISION_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_PROVISION_LIMITS = Object.freeze({
  id: 128,
  branch: 512,
  revision: 64,
  repositoryRoot: 2_048,
  worktreeParent: 2_048,
  timeoutMs: 120_000,
  stdoutBytes: 16_384,
  stderrBytes: 16_384,
} as const);

export type WorkspaceProvisionOutcome = "created" | "existing_compatible" | "conflict" | "invalid_repository" | "invalid_revision" | "git_failure" | "cancelled" | "timeout" | "unknown";

export interface WorkspaceProvisionRequest {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repositoryRoot: string;
  readonly assignedBranch: string;
  readonly expectedBaseRevision: string;
  readonly worktreeParent: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface WorkspaceBinding {
  readonly schemaVersion: typeof WORKSPACE_PROVISION_SCHEMA_VERSION;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly repositoryRoot: string;
  readonly assignedBranch: string;
  readonly expectedBaseRevision: string;
  readonly worktreePath: string;
}

export interface WorkspaceProvisionResult {
  readonly outcome: WorkspaceProvisionOutcome;
  readonly message: string;
  readonly binding?: WorkspaceBinding;
  readonly errorCode?: "invalid_input" | "not_a_repository" | "invalid_revision" | "conflict" | "git_failure" | "cancelled" | "timeout" | "unknown";
}

interface GitResult { readonly outcome: "success" | "git_failure" | "cancelled" | "timeout" | "unknown"; readonly stdout: string; readonly stderr: string; readonly exitCode: number | null; }
interface GitRunnerOptions { readonly executable?: string; readonly environment?: NodeJS.ProcessEnv; }

function text(value: unknown, max: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value); }
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }
function validBranch(value: unknown): value is string {
  return text(value, WORKSPACE_PROVISION_LIMITS.branch) && !value.startsWith("-") && !value.includes("..") && !/[~^:?*[\\\s]/u.test(value) && !value.endsWith("/") && !value.endsWith(".");
}
function validRevision(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{4,64}$/iu.test(value); }
function boundedTimeout(value: number | undefined): number | undefined { const result = value ?? 30_000; return Number.isSafeInteger(result) && result > 0 && result <= WORKSPACE_PROVISION_LIMITS.timeoutMs ? result : undefined; }
function sanitized(value: string): string { return value.replace(/(?:bearer\s+|authorization\s*:\s*|password\s*=|token\s*=|secret\s*=)[^\s\r\n]+/giu, "[REDACTED]").slice(0, 512); }
function result(outcome: WorkspaceProvisionOutcome, message: string, errorCode?: WorkspaceProvisionResult["errorCode"], binding?: WorkspaceBinding): WorkspaceProvisionResult { return { outcome, message: sanitized(message), ...(errorCode === undefined ? {} : { errorCode }), ...(binding === undefined ? {} : { binding }) }; }
function env(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = ["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT"] as const;
  return Object.fromEntries(keys.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]!]]));
}
function existingPathError(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }

export class GitWorkspaceCommandRunner {
  readonly #executable: string;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: GitRunnerOptions = {}) { this.#executable = options.executable?.trim() || "git"; this.#environment = options.environment ?? process.env; }

  run(args: readonly string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<GitResult> {
    return new Promise((resolveResult) => {
      if (signal?.aborted === true) { resolveResult({ outcome: "cancelled", stdout: "", stderr: "", exitCode: null }); return; }
      let child: ChildProcess;
      try { child = spawn(this.#executable, [...args], { cwd, env: env(this.#environment), shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
      catch { resolveResult({ outcome: "unknown", stdout: "", stderr: "", exitCode: null }); return; }
      let stdout = ""; let stderr = ""; let trigger: "cancelled" | "timeout" | "output" | undefined; let exitCode: number | null = null; let settled = false; let timer: NodeJS.Timeout | undefined;
      const finish = (outcome: GitResult["outcome"]) => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener("abort", abort); resolveResult({ outcome, stdout, stderr, exitCode }); };
      const kill = () => { try { child.kill("SIGTERM"); } catch { /* child already exited */ } };
      const abort = () => { trigger = "cancelled"; kill(); };
      const append = (target: "stdout" | "stderr", value: unknown) => { const next = target === "stdout" ? stdout + String(value) : stderr + String(value); if (Buffer.byteLength(next, "utf8") > (target === "stdout" ? WORKSPACE_PROVISION_LIMITS.stdoutBytes : WORKSPACE_PROVISION_LIMITS.stderrBytes)) { trigger = "output"; kill(); return; } if (target === "stdout") stdout = next; else stderr = next; };
      child.stdout?.on("data", (value: unknown) => append("stdout", value)); child.stderr?.on("data", (value: unknown) => append("stderr", value));
      child.once("error", () => finish("unknown")); child.once("close", (code) => { exitCode = code; finish(trigger === "output" ? "git_failure" : trigger ?? (code === 0 ? "success" : "git_failure")); });
      timer = setTimeout(() => { trigger = "timeout"; kill(); }, timeoutMs); timer.unref(); signal?.addEventListener("abort", abort, { once: true });
    });
  }
}

function validateRequest(request: WorkspaceProvisionRequest): WorkspaceProvisionResult | undefined {
  if (!id(request.taskId) || !id(request.attemptId)) return result("conflict", "Task or Attempt identity is invalid.", "invalid_input");
  if (!isAbsolute(request.repositoryRoot) || !text(request.repositoryRoot, WORKSPACE_PROVISION_LIMITS.repositoryRoot)) return result("invalid_repository", "Repository root must be an absolute bounded path.", "invalid_input");
  if (!validBranch(request.assignedBranch)) return result("conflict", "Assigned branch is not a valid Git branch name.", "invalid_input");
  if (!validRevision(request.expectedBaseRevision)) return result("invalid_revision", "Expected base revision must be a hexadecimal Git revision.", "invalid_revision");
  if (!isAbsolute(request.worktreeParent) || !text(request.worktreeParent, WORKSPACE_PROVISION_LIMITS.worktreeParent)) return result("conflict", "Worktree parent must be an absolute bounded path.", "invalid_input");
  const repositoryRoot = resolve(request.repositoryRoot); const worktreeParent = resolve(request.worktreeParent);
  if (worktreeParent === repositoryRoot || worktreeParent.startsWith(`${repositoryRoot}${sep}`)) return result("conflict", "Worktree parent must not be inside the primary checkout.", "conflict");
  if (boundedTimeout(request.timeoutMs) === undefined) return result("conflict", "Workspace provisioning timeout is outside its bounded limit.", "invalid_input");
  return undefined;
}

export class WorkspaceProvisioner {
  readonly #git: GitWorkspaceCommandRunner;
  readonly #bindings = new Map<string, WorkspaceBinding>();
  readonly #pathBindings = new Map<string, string>();
  readonly #locks = new Map<string, Promise<WorkspaceProvisionResult>>();

  constructor(git = new GitWorkspaceCommandRunner()) { this.#git = git; }

  provision(request: WorkspaceProvisionRequest): Promise<WorkspaceProvisionResult> {
    const invalid = validateRequest(request); if (invalid !== undefined) return Promise.resolve(invalid);
    const repositoryRoot = resolve(request.repositoryRoot); const worktreePath = resolve(request.worktreeParent, `pirx-${request.taskId}-${request.attemptId}`); const key = `${repositoryRoot}\u0000${request.taskId}\u0000${request.attemptId}\u0000${request.assignedBranch}\u0000${request.expectedBaseRevision}`; const previous = this.#locks.get(worktreePath) ?? Promise.resolve<WorkspaceProvisionResult>(result("unknown", "unused"));
    const current = previous.catch(() => result("unknown", "Previous workspace claim failed.", "unknown")).then(() => this.#provision(request, repositoryRoot, worktreePath, key));
    this.#locks.set(worktreePath, current);
    void current.finally(() => { if (this.#locks.get(worktreePath) === current) this.#locks.delete(worktreePath); });
    return current;
  }

  async #provision(request: WorkspaceProvisionRequest, repositoryRoot: string, worktreePath: string, key: string): Promise<WorkspaceProvisionResult> {
    const known = this.#bindings.get(key); if (known !== undefined) return result("existing_compatible", "The assigned workspace was already provisioned for this Task and Attempt.", undefined, known);
    const pathOwner = this.#pathBindings.get(worktreePath); if (pathOwner !== undefined && pathOwner !== key) return result("conflict", "The deterministic worktree path is owned by another Task or Attempt.", "conflict");
    let root: string;
    try { root = await realpath(repositoryRoot); const info = await stat(root); if (!info.isDirectory()) return result("invalid_repository", "Repository root is not a directory.", "not_a_repository"); }
    catch { return result("invalid_repository", "Repository root does not exist or is not accessible.", "not_a_repository"); }
    const timeoutMs = boundedTimeout(request.timeoutMs)!; const repositoryCheck = await this.#git.run(["rev-parse", "--show-toplevel"], root, timeoutMs, request.signal);
    if (repositoryCheck.outcome === "cancelled") return result("cancelled", "Workspace provisioning was cancelled.", "cancelled"); if (repositoryCheck.outcome === "timeout") return result("timeout", "Repository validation timed out.", "timeout"); if (repositoryCheck.outcome !== "success" || resolve(repositoryCheck.stdout.trim()) !== root) return result("invalid_repository", "The path is not a valid Git repository root.", "not_a_repository");
    const baseCheck = await this.#git.run(["rev-parse", "--verify", "--quiet", `${request.expectedBaseRevision}^{commit}`], root, timeoutMs, request.signal);
    if (baseCheck.outcome === "cancelled") return result("cancelled", "Workspace provisioning was cancelled.", "cancelled"); if (baseCheck.outcome === "timeout") return result("timeout", "Base revision validation timed out.", "timeout"); if (baseCheck.outcome !== "success" || baseCheck.stdout.trim() === "") return result("invalid_revision", "Expected base revision was not found in the repository.", "invalid_revision");
    try { await stat(worktreePath); return result("conflict", "A worktree already exists at the deterministic destination without a matching in-memory claim.", "conflict"); }
    catch (error: unknown) { if (!existingPathError(error)) return result("conflict", "The worktree destination cannot be inspected.", "conflict"); }
    const branchCheck = await this.#git.run(["show-ref", "--verify", "--quiet", `refs/heads/${request.assignedBranch}`], root, timeoutMs, request.signal);
    if (branchCheck.outcome === "cancelled") return result("cancelled", "Workspace provisioning was cancelled.", "cancelled"); if (branchCheck.outcome === "timeout") return result("timeout", "Assigned branch validation timed out.", "timeout"); if (branchCheck.outcome === "success") return result("conflict", "Assigned branch already exists without a matching workspace claim.", "conflict"); if (branchCheck.outcome === "unknown") return result("unknown", "Assigned branch validation returned an unknown result.", "unknown");
    const createdBranch = await this.#git.run(["branch", request.assignedBranch, request.expectedBaseRevision], root, timeoutMs, request.signal);
    if (createdBranch.outcome !== "success") return result(createdBranch.outcome, "Assigned branch could not be created.", createdBranch.outcome === "git_failure" ? "git_failure" : createdBranch.outcome);
    const worktree = await this.#git.run(["worktree", "add", worktreePath, request.assignedBranch], root, timeoutMs, request.signal);
    if (worktree.outcome !== "success") return result(worktree.outcome, "Assigned worktree could not be created.", worktree.outcome === "git_failure" ? "git_failure" : worktree.outcome);
    const head = await this.#git.run(["-C", worktreePath, "rev-parse", "HEAD"], root, timeoutMs, request.signal); const branch = await this.#git.run(["-C", worktreePath, "symbolic-ref", "--short", "HEAD"], root, timeoutMs, request.signal);
    if (head.outcome !== "success" || branch.outcome !== "success" || head.stdout.trim() !== baseCheck.stdout.trim() || branch.stdout.trim() !== request.assignedBranch) return result("unknown", "Created worktree identity could not be verified.", "unknown");
    const binding: WorkspaceBinding = Object.freeze({ schemaVersion: WORKSPACE_PROVISION_SCHEMA_VERSION, taskId: request.taskId, attemptId: request.attemptId, repositoryRoot: root, assignedBranch: request.assignedBranch, expectedBaseRevision: baseCheck.stdout.trim(), worktreePath });
    this.#bindings.set(key, binding); this.#pathBindings.set(worktreePath, key);
    return result("created", "Assigned branch and dedicated worktree were provisioned.", undefined, binding);
  }
}
