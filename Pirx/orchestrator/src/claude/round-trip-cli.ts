import { ClaudeCodeCliRunner } from "./cli-runner.js";

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
async function main(): Promise<void> {
  const timeoutMs = positiveInteger(process.env, "PIRX_CLAUDE_TIMEOUT_MS");
  const maxStdoutBytes = positiveInteger(process.env, "PIRX_CLAUDE_STDOUT_BYTES");
  const maxStderrBytes = positiveInteger(process.env, "PIRX_CLAUDE_STDERR_BYTES");
  const executable = process.env.PIRX_CLAUDE_EXECUTABLE?.trim();
  const result = await new ClaudeCodeCliRunner({ ...(executable === undefined ? {} : { executable }) }).run({
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxStdoutBytes === undefined ? {} : { maxStdoutBytes }),
    ...(maxStderrBytes === undefined ? {} : { maxStderrBytes }),
  });
  console.log(JSON.stringify(result));
  if (result.outcome !== "success") process.exitCode = 1;
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Claude Code round-trip failed.";
  console.error(`Claude Code round-trip failed: ${message}`);
  process.exitCode = 1;
});
