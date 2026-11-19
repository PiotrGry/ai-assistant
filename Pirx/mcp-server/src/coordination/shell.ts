import { spawn } from "node:child_process";

export interface CommandResult {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;
}

/** Runs one command without a shell. Output is kept whole: the model reads raw errors. */
export type Runner = (file: string, args: readonly string[], options?: { readonly cwd?: string; readonly timeoutMs?: number; readonly input?: string; readonly env?: NodeJS.ProcessEnv }) => Promise<CommandResult>;

export const runCommand: Runner = (file, args, options = {}) => new Promise((resolveResult) => {
  const child = spawn(file, [...args], { cwd: options.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: options.env ?? process.env });
  let stdout = ""; let stderr = "";
  const timer = setTimeout(() => { child.kill("SIGTERM"); stderr += `\n[pirx] timed out after ${options.timeoutMs} ms`; }, options.timeoutMs ?? 120_000);
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.on("error", (error) => { clearTimeout(timer); resolveResult({ ok: false, code: null, stdout, stderr: `${stderr}${error.message}`, command: [file, ...args].join(" ") }); });
  child.on("close", (code) => { clearTimeout(timer); resolveResult({ ok: code === 0, code, stdout, stderr, command: [file, ...args].join(" ") }); });
  if (options.input !== undefined) child.stdin.end(options.input); else child.stdin.end();
});

/** Parses JSON output of a successful command, or returns undefined. */
export function jsonOf(result: CommandResult): unknown {
  if (!result.ok) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

/** A failed command as a fact for the model: what ran, its exit code and its own words. */
export function failure(result: CommandResult, hint?: string): Record<string, unknown> {
  return { failed: result.command, exitCode: result.code, stderr: result.stderr.trim(), ...(result.stdout.trim() ? { stdout: result.stdout.trim() } : {}), ...(hint === undefined ? {} : { hint }) };
}
