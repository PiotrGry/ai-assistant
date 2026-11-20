import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";

import { processStart } from "./proc.js";

import type { WorkerJob } from "./worker.js";

/**
 * Background runner for one worker run, started detached by worker_start/worker_resume.
 * It runs the setup commands, then Claude Code, streams everything to the log, and
 * writes a report Pirx reads: exit code, the worker's own final text, and any usage-limit message.
 */

const USAGE_LIMIT = /\b(?:hit your [\w-]+ limit|usage limit|usage_limit_reached|quota exhausted|limit reached)\b/iu;

const job = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as WorkerJob;
// The launcher waits for this file: the lock must name this process, not the launcher or systemd-run.
writeFileSync(`${process.argv[2]!}.pid`, `${process.pid} ${processStart(process.pid) ?? ""}`.trim());
const log = createWriteStream(job.logPath, { flags: "a" });
const startedAt = new Date().toISOString();
let finished = false;
let lastAssistantTextForSignal = "";

function finish(report: Record<string, unknown>): void {
  if (finished) return;
  finished = true;
  writeFileSync(job.reportPath, JSON.stringify({ task: job.task, sessionId: job.sessionId, startedAt, endedAt: new Date().toISOString(), ...report }, null, 1));
  // The lock stays until the next worker_start/worker_resume clears it, so worker_status
  // can still show this run's report after the process has ended.
  log.end();
}

// A stop from outside (unit stopped, service shutdown, timeout of a parent) still leaves a report.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    try { child?.kill("SIGTERM"); } catch { /* already gone */ }
    finish({ outcome: "killed", signal, workerReport: lastAssistantTextForSignal, note: "The run was stopped from outside before the worker finished. Check the worktree before resuming." });
    process.exit(0);
  });
}
let child: ReturnType<typeof spawn> | undefined;

for (const command of job.setupCommands) {
  log.write(`{"pirx":"setup","command":${JSON.stringify(command)}}\n`);
  const result = spawnSync("bash", ["-lc", command], { cwd: job.cwd, encoding: "utf8", timeout: 30 * 60 * 1000, env: process.env });
  log.write(`${JSON.stringify({ pirx: "setup_result", command, status: result.status, stderr: (result.stderr ?? "").slice(-4000) })}\n`);
  if (result.status !== 0) { finish({ outcome: "setup_failed", command, exitCode: result.status, stderr: result.stderr }); process.exit(0); }
}

const worker = spawn(job.executable, [...job.args], { cwd: job.cwd, env: job.env, stdio: ["ignore", "pipe", "pipe"] });
child = worker;
let resultEvent: Record<string, unknown> | undefined;
let lastAssistantText = "";
let limitMessage: string | undefined;
let buffer = "";
let stderr = "";
worker.stdout.on("data", (chunk: Buffer) => {
  log.write(chunk);
  buffer += chunk.toString("utf8");
  let index: number;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "result") resultEvent = event;
      const message = event.message as { content?: { type?: string; text?: string }[] } | undefined;
      const text = message?.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      if (event.type === "assistant" && text) { lastAssistantText = text; lastAssistantTextForSignal = text; if (USAGE_LIMIT.test(text)) limitMessage = text; }
    } catch { /* not a JSON line */ }
  }
});
worker.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); log.write(`${JSON.stringify({ pirx: "stderr", text: chunk.toString("utf8") })}\n`); });
const timer = setTimeout(() => { log.write(`{"pirx":"timeout"}\n`); worker.kill("SIGTERM"); }, job.timeoutMs);
worker.on("close", (code, signal) => {
  clearTimeout(timer);
  const resultText = typeof resultEvent?.result === "string" ? resultEvent.result : undefined;
  if (resultText !== undefined && USAGE_LIMIT.test(resultText)) limitMessage = resultText;
  finish({
    outcome: limitMessage !== undefined ? "usage_limit" : code === 0 && resultEvent?.is_error !== true ? "finished" : "failed",
    exitCode: code, ...(signal === null ? {} : { signal }),
    workerReport: resultText ?? lastAssistantText,
    ...(limitMessage === undefined ? {} : { usageLimitMessage: limitMessage, note: "The message names when the limit resets. Resume after that time." }),
    ...(resultEvent === undefined ? {} : { numTurns: resultEvent.num_turns, costUsd: resultEvent.total_cost_usd, subtype: resultEvent.subtype }),
    ...(stderr.trim() ? { stderrTail: stderr.slice(-4000) } : {}),
  });
});
worker.on("error", (error) => { clearTimeout(timer); finish({ outcome: "failed", error: error.message }); });
