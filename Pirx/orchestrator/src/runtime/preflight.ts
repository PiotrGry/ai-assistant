import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { MINIMUM_CLAUDE_CODE_WORKER_VERSION } from "../claude/cli-runner.js";
import { diagnosticContext } from "./diagnostic-context.js";
import type { HeadlessOrchestratorConfig } from "./headless-config.js";

// Checks everything a Task needs before the first Task needs it. The daemon starts without a
// usable repository checkout, worktree directory, Claude binary or sandbox tools and fails only
// when an Attempt reaches them; `headless-cli.js --check` reports all of them at once instead.

export interface PreflightFinding {
  /** Stable name of the check, for example `repository:owner/name:baseRevision`. */
  readonly check: string;
  readonly outcome: "ok" | "problem";
  /** What was found and, for a problem, what to do about it. Bounded and redacted. */
  readonly detail: string;
}

export interface PreflightCommandResult { readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly code?: string }
export type PreflightCommandRunner = (command: string, args: readonly string[], cwd?: string) => Promise<PreflightCommandResult>;

export interface PreflightOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** Injectable for tests; production runs the real executables without a shell. */
  readonly run?: PreflightCommandRunner;
  /** Opens the runtime database the way the daemon does; throws with the reason when it cannot. */
  readonly openDatabase: () => void;
  /** Resolves GitHub credentials the way the daemon does; throws with the reason when it cannot. */
  readonly githubCredentials: () => void;
  /** Reads the Project Queue once. Omitted when the caller cannot reach GitHub. */
  readonly readQueue?: () => Promise<{ readonly ok: boolean; readonly detail: string }>;
  /** Where the worker's advisor entry point is expected; defaults to the path the Claude worker uses. */
  readonly advisorEntry?: string;
}

const COMMAND_TIMEOUT_MS = 10_000;

function bounded(value: unknown): string {
  const text = String(diagnosticContext(typeof value === "string" ? value : value instanceof Error ? value.message : String(value))).replace(/\s+/gu, " ").trim();
  return (text === "" ? "no detail was reported" : text).slice(0, 400);
}

function realRunner(environment: NodeJS.ProcessEnv): PreflightCommandRunner {
  return (command, args, cwd) => new Promise((resolve) => {
    execFile(command, [...args], { cwd, env: environment, shell: false, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null ? undefined : typeof (error as NodeJS.ErrnoException).code === "string" ? (error as NodeJS.ErrnoException).code : undefined;
      resolve({ ok: error === null, stdout: String(stdout), stderr: String(stderr), ...(code === undefined ? {} : { code }) });
    });
  });
}

function missing(result: PreflightCommandResult): boolean { return result.code === "ENOENT"; }

function version(text: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function older(left: readonly [number, number, number], right: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) { if (left[index]! !== right[index]!) return left[index]! < right[index]!; }
  return false;
}

/** Runs every check and returns one finding per check. It changes nothing and never throws. */
export async function runPreflight(config: HeadlessOrchestratorConfig, options: PreflightOptions): Promise<readonly PreflightFinding[]> {
  const environment = options.environment ?? process.env;
  const run = options.run ?? realRunner(environment);
  const findings: PreflightFinding[] = [];
  const ok = (check: string, detail: string): void => { findings.push(Object.freeze({ check, outcome: "ok", detail: bounded(detail) })); };
  const problem = (check: string, detail: string): void => { findings.push(Object.freeze({ check, outcome: "problem", detail: bounded(detail) })); };
  const guarded = async (check: string, body: () => Promise<void> | void): Promise<void> => {
    try { await body(); } catch (error: unknown) { problem(check, `The check itself failed: ${bounded(error)}`); }
  };

  await guarded("database", () => {
    try { options.openDatabase(); ok("database", config.databasePath); }
    catch (error: unknown) { problem("database", `${bounded(error)} Run headless-cli.js --migrate once.`); }
  });

  await guarded("worktreeParent", async () => {
    try {
      if (!(await stat(config.worktreeParent)).isDirectory()) return problem("worktreeParent", `${config.worktreeParent} is not a directory.`);
      await access(config.worktreeParent, constants.W_OK | constants.X_OK);
      ok("worktreeParent", config.worktreeParent);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      problem("worktreeParent", code === "ENOENT" ? `${config.worktreeParent} does not exist. Create the directory.` : `${config.worktreeParent} is not writable (${String(code)}).`);
    }
  });

  await guarded("git", async () => {
    const git = await run("git", ["--version"]);
    if (git.ok) ok("git", git.stdout.trim()); else problem("git", missing(git) ? "git is not on PATH." : `git --version failed: ${git.stderr}`);
  });

  for (const repository of config.repositories) {
    const name = `repository:${repository.repository}`;
    await guarded(name, async () => {
      const inside = await run("git", ["rev-parse", "--is-inside-work-tree"], repository.repositoryRoot);
      if (!inside.ok || inside.stdout.trim() !== "true") {
        return problem(`${name}:repositoryRoot`, inside.code === "ENOENT" ? `${repository.repositoryRoot} does not exist, or git is not on PATH.` : `${repository.repositoryRoot} is not a git checkout.`);
      }
      ok(`${name}:repositoryRoot`, repository.repositoryRoot);
      const revision = await run("git", ["cat-file", "-e", `${repository.baseRevision}^{commit}`], repository.repositoryRoot);
      if (revision.ok) ok(`${name}:baseRevision`, repository.baseRevision);
      else problem(`${name}:baseRevision`, `Commit ${repository.baseRevision} is not in ${repository.repositoryRoot}. Fetch it, or set baseRevision to a commit of ${repository.baseBranch}.`);
      const remote = await run("git", ["remote", "get-url", repository.remoteName], repository.repositoryRoot);
      if (remote.ok) ok(`${name}:remoteName`, repository.remoteName);
      else problem(`${name}:remoteName`, `The checkout has no git remote named ${repository.remoteName}.`);
    });
  }

  await guarded("claude", async () => {
    const claude = await run("claude", ["--version"]);
    if (!claude.ok) return problem("claude", missing(claude) ? "The claude executable is not on the daemon's PATH." : `claude --version failed: ${claude.stderr || claude.stdout}`);
    const found = version(claude.stdout);
    const minimum = version(MINIMUM_CLAUDE_CODE_WORKER_VERSION)!;
    if (found === undefined) return problem("claude", `claude --version printed no version: ${claude.stdout}`);
    if (older(found, minimum)) return problem("claude", `Claude Code ${found.join(".")} is installed; ${MINIMUM_CLAUDE_CODE_WORKER_VERSION} or newer is required. Update Claude Code.`);
    ok("claude", `Claude Code ${found.join(".")}`);
  });

  if ((options.platform ?? process.platform) === "linux") {
    // Claude Code refuses to start an isolated worker on Linux without both tools.
    for (const [tool, args] of [["bwrap", ["--version"]], ["socat", ["-V"]]] as const) {
      await guarded(`sandbox:${tool}`, async () => {
        const result = await run(tool, args);
        if (result.ok) ok(`sandbox:${tool}`, `${tool} is installed`);
        else problem(`sandbox:${tool}`, missing(result) ? `${tool} is not installed. The worker sandbox needs it (Debian/Ubuntu: apt install ${tool === "bwrap" ? "bubblewrap" : "socat"}).` : `${tool} failed: ${result.stderr}`);
      });
    }
  }

  await guarded("advisor", async () => {
    const entry = options.advisorEntry ?? fileURLToPath(new URL("../../../mcp-server/dist/advisor-cli.js", import.meta.url));
    try { await access(entry, constants.R_OK); ok("advisor", entry); }
    catch { problem("advisor", `${entry} is missing. Build the mcp-server package so a worker can ask Pirx a question.`); }
  });

  let credentials = false;
  await guarded("github:credentials", () => {
    try { options.githubCredentials(); credentials = true; ok("github:credentials", "GitHub CLI authentication is available"); }
    catch (error: unknown) { problem("github:credentials", bounded(error)); }
  });

  if (credentials && options.readQueue !== undefined) {
    const readQueue = options.readQueue;
    await guarded("github:project", async () => {
      const queue = await readQueue();
      if (queue.ok) ok("github:project", queue.detail); else problem("github:project", queue.detail);
    });
  }

  return Object.freeze(findings);
}
