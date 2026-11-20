import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { isRefusal, locateWorkspace, pidAlive, repositoryOrRefusal, workerFacts } from "./facts.js";
import { failure, jsonOf } from "./shell.js";
import { startOfDay, type CoordinatedRepository, type CoordinationSettings } from "./settings.js";
import { taskKey } from "./store.js";
import { defineTool, issueInput, refuse, repositoryInput, type CoordinationContext } from "./toolkit.js";

/** Same isolation the old daemon used: worktree-only file access, OS sandbox, network to github.com only. */
export const WORKER_SETTINGS = Object.freeze({
  permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true },
  sandbox: { enabled: true, allowUnsandboxedCommands: false, failIfUnavailable: true, network: { allowedDomains: ["github.com"] } },
});

export const WORKER_ENV_ALLOWLIST = [
  "HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
] as const;

/** Tools and rules for one worktree. The worker edits, tests and commits; it never pushes or rewrites history. */
export function workerToolArguments(worktree: string, testCommands: readonly string[]): string[] {
  const tools = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "Edit", "Write", "Bash"];
  const allowed = [...tools.filter((tool) => tool !== "Bash"),
    ...testCommands.map((command) => `Bash(${command})`),
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git add:*)", "Bash(git commit -m:*)", "Bash(git rev-parse HEAD)",
    `Bash(git -C ${worktree} status:*)`, `Bash(git -C ${worktree} diff:*)`, `Bash(git -C ${worktree} add:*)`, `Bash(git -C ${worktree} commit -m:*)`];
  const denied = ["Agent", "AskUserQuestion", "NotebookEdit", "Task", "mcp__*",
    "Bash(rm *)", "Bash(sh *)", "Bash(bash *)", "Bash(zsh *)", "Bash(curl *)", "Bash(wget *)",
    "Bash(git reset *)", "Bash(git clean *)", "Bash(git checkout *)", "Bash(git switch *)", "Bash(git rebase *)",
    "Bash(git branch -D *)", "Bash(git branch --delete *)", "Bash(git remote *)", "Bash(git config *)",
    "Bash(git push *)", "Bash(git -C * push *)"];
  return ["--restricted", "--settings", JSON.stringify(WORKER_SETTINGS), "-p", "--tools", tools.join(","),
    "--allowedTools", allowed.join(","), "--disallowedTools", denied.join(","),
    "--permission-mode", "dontAsk", "--disable-slash-commands", "--output-format", "stream-json", "--verbose"];
}

const WORKER_PREFACE = `You are the code worker for Pirx. Pirx coordinates; you only change code in this worktree.
- Work only on the instruction below. Run the repository's tests before you finish.
- Commit your change with git commit -m. Do not push: Pirx pushes and opens the pull request.
- Finish with a short report: what you changed, the commit, the test result, and anything Pirx must know (blocked, unsure, follow-up).

Instruction from Pirx:
`;

export interface WorkerJob {
  readonly task: string;
  readonly cwd: string;
  readonly setupCommands: readonly string[];
  readonly executable: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly env: Record<string, string>;
  readonly logPath: string;
  readonly reportPath: string;
  readonly timeoutMs: number;
  readonly storagePath: string;
  readonly sessionId: string;
}

function workerEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of WORKER_ENV_ALLOWLIST) { const value = environment[name]; if (value !== undefined) env[name] = value; }
  return env;
}

function runnerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "worker-run.js");
}

/** Clears a lock whose process has ended, so the next start can take it. Returns the live lock or undefined. */
function liveLock(context: CoordinationContext): ReturnType<CoordinationContext["store"]["lock"]> {
  const lock = context.store.lock();
  if (lock !== undefined && !pidAlive(lock.pid)) { context.store.release(); return undefined; }
  return lock;
}

function capReached(context: CoordinationContext, task: string): Record<string, unknown> | undefined {
  const since = startOfDay(context.store.now());
  const used = context.store.countCalls("worker_start", since, { task }) + context.store.countCalls("worker_resume", since, { task });
  const cap = context.settings.caps.workerStartsPerTaskPerDay;
  return used >= cap ? refuse(`The worker already ran ${used} times today for ${task}; the cap is ${cap} per Task per day. Ask Opus or the operator, or park the Task.`) : undefined;
}

async function launch(context: CoordinationContext, repo: CoordinatedRepository, task: string, cwd: string, sessionArgs: string[], instruction: string, setup: boolean): Promise<Record<string, unknown>> {
  const stamp = context.store.now().replace(/[:.]/gu, "-");
  const dir = join(context.settings.workerLogDir, task.replace(/[^A-Za-z0-9_.-]+/gu, "_"));
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${stamp}.jsonl`); const reportPath = join(dir, `${stamp}.report.json`);
  const sessionId = sessionArgs[1]!;
  if (context.settings.dryRun) return { wouldStart: true, task, worktree: cwd, sessionId, instruction };
  if (!context.store.acquire({ task, pid: 0, startedAt: context.store.now(), logPath, reportPath })) return refuse("Another worker is running. Only one worker runs at a time.", { worker: workerFacts(context.store) });
  const args = [...workerToolArguments(cwd, repo.testCommands), ...(context.settings.workerModel === undefined ? [] : ["--model", context.settings.workerModel]), ...sessionArgs, `${WORKER_PREFACE}${instruction}`];
  const job: WorkerJob = { task, cwd, setupCommands: setup ? repo.setupCommands : [], executable: context.settings.claudeExecutable, args, prompt: instruction, env: workerEnvironment(context.environment), logPath, reportPath, timeoutMs: context.settings.caps.workerTimeoutMs, storagePath: context.store.path, sessionId };
  const jobPath = join(dir, `${stamp}.job.json`);
  writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
  const child = spawn(process.execPath, [runnerPath(), jobPath], { cwd, detached: true, stdio: "ignore", env: { ...process.env } });
  child.unref();
  if (child.pid === undefined) { context.store.release(); return { error: "The worker process did not start." }; }
  context.store.setLockPid(child.pid);
  return { started: true, task, pid: child.pid, sessionId, worktree: cwd, logPath, reportPath, note: "The worker runs in the background. A tick wakes Pirx when it exits; read worker_status or task_facts then." };
}

/** The operator controls what Pirx may work on through the Project: only Worker=Pirx items that are not Done. */
async function notQueuedForPirx(context: CoordinationContext, repository: string, issue: number): Promise<Record<string, unknown> | undefined> {
  const { settings } = context;
  if (settings.projectOwner === undefined || settings.projectNumber === undefined) return undefined;
  const result = await context.run("gh", ["project", "item-list", String(settings.projectNumber), "--owner", settings.projectOwner, "--format", "json", "--limit", "500"], { timeoutMs: 60_000 });
  const value = jsonOf(result) as { items?: Record<string, unknown>[] } | undefined;
  if (value === undefined) return refuse("Cannot read the Project to check that this Issue is queued for Pirx.", failure(result));
  const item = (value.items ?? []).find((entry) => {
    const content = entry.content as { repository?: string; number?: number } | undefined;
    return content?.repository?.toLowerCase() === repository.toLowerCase() && content.number === issue;
  });
  if (item === undefined) return refuse(`${repository}#${issue} is not on the Project. Only queued work may start; queue it with queue_set (Worker=Pirx) if it should be done.`);
  if (item.worker !== "Pirx" || item.status === "Done") return refuse(`${repository}#${issue} is not queued for Pirx (Worker=${String(item.worker ?? "none")}, Status=${String(item.status ?? "none")}). The operator decides this field; do not work on it.`);
  return undefined;
}

export function registerWorkerTools(server: McpServer, context: CoordinationContext): void {
  defineTool(server, context, {
    name: "worker_start",
    description: "Start the code worker (Claude Code) on a queued Task (Worker=Pirx on the Project) in a new worktree and branch pirx/issue-<N>, from the current base branch. Pirx writes the instruction: what to do and how to know it is done. Refuses while another worker runs, when the Task already has a worktree (use worker_resume or task_restart_clean), or when today's start cap is reached.",
    input: { repository: repositoryInput, issue: issueInput, instruction: z.string().min(1) },
    mutating: true,
    task: (input) => taskKey(input.repository, input.issue),
    run: async (input, context_) => {
      const repo = repositoryOrRefusal(context_.settings, input.repository); if (isRefusal(repo)) return repo;
      const task = taskKey(input.repository, input.issue);
      const live = liveLock(context_); if (live !== undefined) return refuse("Another worker is running. Only one worker runs at a time.", { worker: workerFacts(context_.store) });
      const existing = await locateWorkspace(context_.run, context_.store, repo, input.issue);
      if (existing !== undefined && existsSync(existing.worktree)) return refuse(`${task} already has a worktree (${existing.worktree}, branch ${existing.branch}). Use worker_resume to continue it, or task_restart_clean to start over.`, { workspace: existing });
      const capped = capReached(context_, task); if (capped !== undefined) return capped;
      const unqueued = await notQueuedForPirx(context_, repo.repository, input.issue); if (unqueued !== undefined) return unqueued;
      const branch = `pirx/issue-${input.issue}`;
      const worktree = join(context_.settings.worktreeParent, `${input.repository.replace("/", "-")}-${input.issue}`);
      const fetched = await context_.run("git", ["fetch", "--quiet", repo.remoteName, repo.baseBranch], { cwd: repo.repositoryRoot, timeoutMs: 120_000 });
      if (!fetched.ok) return failure(fetched);
      mkdirSync(context_.settings.worktreeParent, { recursive: true });
      const added = await context_.run("git", ["worktree", "add", "-b", branch, worktree, `${repo.remoteName}/${repo.baseBranch}`], { cwd: repo.repositoryRoot });
      if (!added.ok) return failure(added, "If the branch already exists from an earlier attempt, use task_restart_clean.");
      const sessionId = randomUUID();
      context_.store.upsertTask({ repository: repo.repository, issue: input.issue, branch, worktree, sessionId, state: "active" });
      return launch(context_, repo, task, worktree, ["--session-id", sessionId], input.instruction, true);
    },
  });

  defineTool(server, context, {
    name: "worker_resume",
    description: "Continue the worker on a Task's existing worktree with a new instruction, e.g. after a usage limit, a CI failure or a review. Keeps the worker's earlier session when Pirx recorded one. Works on worktrees the old daemon left too. Refuses while another worker runs or when today's start cap is reached.",
    input: { repository: repositoryInput, issue: issueInput, instruction: z.string().min(1) },
    mutating: true,
    task: (input) => taskKey(input.repository, input.issue),
    run: async (input, context_) => {
      const repo = repositoryOrRefusal(context_.settings, input.repository); if (isRefusal(repo)) return repo;
      const task = taskKey(input.repository, input.issue);
      const live = liveLock(context_); if (live !== undefined) return refuse("Another worker is running. Only one worker runs at a time.", { worker: workerFacts(context_.store) });
      const workspace = await locateWorkspace(context_.run, context_.store, repo, input.issue);
      if (workspace === undefined || !existsSync(workspace.worktree)) return refuse(`${task} has no worktree. Use worker_start.`);
      const capped = capReached(context_, task); if (capped !== undefined) return capped;
      const unqueued = await notQueuedForPirx(context_, repo.repository, input.issue); if (unqueued !== undefined) return unqueued;
      const own = context_.store.getTask(task);
      const previous = own?.sessionId;
      const sessionId = previous ?? randomUUID();
      context_.store.upsertTask({ repository: repo.repository, issue: input.issue, branch: workspace.branch, worktree: workspace.worktree, sessionId, state: "active", ...(own?.note === undefined ? {} : { note: own.note }) });
      return launch(context_, repo, task, workspace.worktree, previous === undefined ? ["--session-id", sessionId] : ["--resume", sessionId], input.instruction, previous === undefined);
    },
  });
}

export type { CoordinationSettings };
