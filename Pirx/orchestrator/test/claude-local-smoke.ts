import { ClaudeCodeCliRunner } from "../src/index.js";

if (process.env.PIRX_CLAUDE_LOCAL_SMOKE !== "1") {
  throw new Error("Set PIRX_CLAUDE_LOCAL_SMOKE=1 to run the opt-in local smoke.");
}

const result = await new ClaudeCodeCliRunner().run({ timeoutMs: 30_000, maxStdoutBytes: 4_096, maxStderrBytes: 4_096 });
console.log(JSON.stringify({ outcome: result.outcome, requestId: result.requestId, durationMs: result.durationMs, exitCode: result.exitCode, ...(result.outcome === "success" ? { acknowledgement: result.acknowledgement } : { message: result.message }) }));
