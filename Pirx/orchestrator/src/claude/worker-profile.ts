import { isAbsolute, resolve } from "node:path";

import { CAPABILITY_VOCABULARY, type Capability } from "../runtime/capabilities.js";
import type { WorkerRequest } from "../runtime/worker-contract.js";

export const CLAUDE_CODE_WORKER_PROFILE_SCHEMA_VERSION = 1 as const;
export const CLAUDE_CODE_WORKER_PROFILE_LIMITS = Object.freeze({
  maxTurns: 32,
  maxTestCommands: 16,
  maxCommandCharacters: 256,
  maxPathCharacters: 2_048,
  maxRemoteCharacters: 128,
  maxCommitMessageCharacters: 256,
} as const);

export const CODE_WORKER_CAPABILITIES = Object.freeze([
  "repository.read",
  "repository.write",
  "tests.run",
  "git.commit",
  "git.push_assigned_branch",
] as const);
export type CodeWorkerCapability = (typeof CODE_WORKER_CAPABILITIES)[number];

export interface ClaudeCodeRepositoryPolicy {
  readonly repositoryRoot: string;
  readonly assignedWorktree: string;
  readonly remoteName: string;
  readonly testCommands: readonly string[];
  readonly commitMessage?: string;
  readonly maxTurns?: number;
}

export interface ClaudeCodeWorkerProfile {
  readonly schemaVersion: typeof CLAUDE_CODE_WORKER_PROFILE_SCHEMA_VERSION;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly permissionMode: "dontAsk";
  readonly maxTurns: number;
  readonly remoteName: string;
  readonly assignedBranch: string;
  readonly testCommands: readonly string[];
}

export type ClaudeCodeWorkerProfileResult =
  | { readonly ok: true; readonly value: ClaudeCodeWorkerProfile }
  | { readonly ok: false; readonly message: string };

const CODE_CAPABILITY_SET = new Set<string>(CODE_WORKER_CAPABILITIES);
const KNOWN_CAPABILITY_SET = new Set<string>(CAPABILITY_VOCABULARY);
const SHELL_META = /[\u0000-\u001f\u007f;&|<>`$(){}[\]\\!#*?~'"\n\r]/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_COMMAND = /^(?:pnpm|npm|yarn|bun|node|npx|python|python3|pytest|cargo|go|make)(?: [A-Za-z0-9_./:@=+,-]+)*$/u;

function failure(message: string): ClaudeCodeWorkerProfileResult { return { ok: false, message: message.slice(0, 256) }; }
function boundedPath(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxPathCharacters && isAbsolute(value) && !SHELL_META.test(value); }
function safeCommand(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxCommandCharacters && SAFE_COMMAND.test(value); }
function safeCommitMessage(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxCommitMessageCharacters && !SHELL_META.test(value) && !/[\u0000-\u001f\u007f]/u.test(value); }
function capabilities(request: WorkerRequest): ClaudeCodeWorkerProfileResult | readonly CodeWorkerCapability[] {
  const granted = request.capabilityGrant.grantedCapabilities;
  for (const value of granted) {
    if (typeof value !== "string" || !KNOWN_CAPABILITY_SET.has(value)) return failure("Worker grant contains an unknown capability.");
    if (!CODE_CAPABILITY_SET.has(value)) return failure("Worker grant contains a capability outside the code-worker profile.");
  }
  const required = request.capabilityGrant.requiredCapabilities;
  for (const value of required) if (typeof value !== "string" || !CODE_CAPABILITY_SET.has(value)) return failure("Task requires a capability outside the code-worker profile.");
  return Object.freeze([...new Set(granted.filter((value): value is CodeWorkerCapability => CODE_CAPABILITY_SET.has(value)))].sort() as CodeWorkerCapability[]);
}
function allow(rule: string, output: string[]): void { if (!output.includes(rule)) output.push(rule); }

export function buildClaudeCodeWorkerProfile(request: WorkerRequest, policy: ClaudeCodeRepositoryPolicy): ClaudeCodeWorkerProfileResult {
  const parsedCapabilities = capabilities(request);
  if ("ok" in parsedCapabilities) return parsedCapabilities;
  if (!boundedPath(policy.repositoryRoot) || !boundedPath(policy.assignedWorktree)) return failure("Repository and assigned worktree must be absolute safe paths.");
  const repositoryRoot = resolve(policy.repositoryRoot);
  const assignedWorktree = resolve(policy.assignedWorktree);
  if (repositoryRoot === assignedWorktree) return failure("Assigned worktree must be distinct from the primary repository root.");
  if (request.workspace.worktree !== assignedWorktree || request.workspace.branch.length === 0 || !BRANCH.test(request.workspace.branch)) return failure("Worker workspace does not match the configured assigned worktree or branch policy.");
  if (request.workspace.branch.includes("..") || request.workspace.branch.startsWith("/") || request.workspace.branch.endsWith("/")) return failure("Assigned branch is unsafe.");
  if (!REMOTE.test(policy.remoteName)) return failure("Configured Git remote is unsafe.");
  if (!Array.isArray(policy.testCommands) || policy.testCommands.length > CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxTestCommands || policy.testCommands.some((command) => !safeCommand(command))) return failure("Repository test policy contains an unsafe or oversized command.");
  if (policy.maxTurns !== undefined && (!Number.isSafeInteger(policy.maxTurns) || policy.maxTurns <= 1 || policy.maxTurns > CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxTurns)) return failure("Code-worker turn bound is invalid.");
  const commitMessage = policy.commitMessage ?? "Pirx: apply assigned repair";
  if (!safeCommitMessage(commitMessage)) return failure("Configured commit message is unsafe.");

  const tools: string[] = [];
  const allowed: string[] = [];
  const denied = [
    "Agent", "AskUserQuestion", "WebFetch", "WebSearch", "NotebookEdit", "Task", "mcp__*",
    "Bash(rm *)", "Bash(sh *)", "Bash(bash *)", "Bash(zsh *)", "Bash(curl *)", "Bash(wget *)",
    "Bash(git reset *)", "Bash(git clean *)", "Bash(git checkout *)", "Bash(git switch *)",
    "Bash(git branch -D *)", "Bash(git branch --delete *)", "Bash(git remote *)", "Bash(git config *)",
    "Bash(git push --force *)", "Bash(git push -f *)", "Bash(git push --delete *)", "Bash(git push --mirror *)",
  ];
  if (parsedCapabilities.includes("repository.read")) {
    for (const tool of ["Read", "Glob", "Grep"]) { tools.push(tool); allow(tool, allowed); }
  }
  if (parsedCapabilities.includes("repository.write")) {
    for (const tool of ["Edit", "Write"]) { tools.push(tool); allow(tool, allowed); }
  }
  const bashNeeded = parsedCapabilities.some((value) => value === "tests.run" || value === "git.commit" || value === "git.push_assigned_branch");
  if (bashNeeded) {
    tools.push("Bash");
    if (parsedCapabilities.includes("tests.run")) for (const command of policy.testCommands) allow(`Bash(${command})`, allowed);
    if (parsedCapabilities.includes("git.commit")) {
      for (const command of ["git status --short --branch", "git diff --stat", "git diff", "git add -A"]) allow(`Bash(${command})`, allowed);
      allow(`Bash(git commit -m \"${commitMessage}\")`, allowed);
    }
    if (parsedCapabilities.includes("git.push_assigned_branch")) allow(`Bash(git push ${policy.remoteName} HEAD:refs/heads/${request.workspace.branch})`, allowed);
  }
  for (const tool of ["Read", "Write", "Edit", "Glob", "Grep"]) if (!tools.includes(tool)) denied.push(tool);
  if (!bashNeeded) denied.push("Bash");
  return { ok: true, value: Object.freeze({
    schemaVersion: CLAUDE_CODE_WORKER_PROFILE_SCHEMA_VERSION,
    cwd: assignedWorktree,
    tools: Object.freeze(tools),
    allowedTools: Object.freeze(allowed),
    disallowedTools: Object.freeze([...new Set(denied)]),
    permissionMode: "dontAsk",
    maxTurns: policy.maxTurns ?? 16,
    remoteName: policy.remoteName,
    assignedBranch: request.workspace.branch,
    testCommands: Object.freeze([...policy.testCommands]),
  }) };
}

export function buildWorkerResultSchema(request: WorkerRequest): unknown {
  const baseProperties = {
    kind: { type: "string", const: "worker_result" },
    schemaVersion: { type: "integer", const: 1 },
    taskId: { type: "string", const: request.taskId },
    attemptId: { type: "string", const: request.attemptId },
    correlationId: { type: "string", const: request.correlationId },
  } as const;
  const diagnostic = { type: "object", additionalProperties: false, required: ["schemaVersion", "code", "message"], properties: { schemaVersion: { type: "integer", const: 1 }, code: { enum: ["spawn_failure", "process_failure", "timeout", "cancellation", "authentication", "quota_exhausted", "malformed_cli_envelope", "missing_structured_output", "invalid_structured_output", "worker_contract_mismatch", "binding_mismatch", "capability_denied", "permission_denied", "git_state_mismatch", "adapter_failure"] }, message: { type: "string", minLength: 1, maxLength: 256 }, exitCode: { type: "integer", minimum: 0, maximum: 255 }, durationMs: { type: "integer", minimum: 0, maximum: 300000 } } } as const;
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["kind", "schemaVersion", "taskId", "attemptId", "correlationId", "outcome"],
    properties: { ...baseProperties, outcome: { enum: ["CODE_PUSHED", "BLOCKED", "FAILED", "QUOTA_EXHAUSTED", "CANCELLED", "UNKNOWN"] }, branch: { type: "string", const: request.workspace.branch }, finalCommit: { type: "string", pattern: "^[0-9a-fA-F]{4,64}$" }, reason: { type: "string", minLength: 1, maxLength: 1_000 }, diagnostic },
  });
}
