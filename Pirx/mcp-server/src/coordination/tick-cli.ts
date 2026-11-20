#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releaseGuard, takeGuard, tickGuardPath } from "./proc.js";
import { CoordinationStore, defaultStoragePath } from "./store.js";

/**
 * One coordination tick (docs/control-center-refactor.md, T6): wake the local model with
 * the trigger, give it only the coordination tools, journal its decision, unload the model.
 *
 *   node dist/coordination/tick-cli.js --trigger "worker exited: owner/repo#1" [--dry-run] [--eval case.json] [--storage file]
 */

export interface TickOptions {
  readonly trigger: string;
  readonly dryRun?: boolean;
  readonly evalFixture?: string;
  /** Replaces the tick prompt, e.g. an operator question for a chat-path eval. */
  readonly prompt?: string;
  readonly storage?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface TickResult {
  readonly tick: string;
  readonly exitCode: number | null;
  readonly answer: string;
  readonly toolCalls: number;
  readonly durationMs: number;
  /** The tick ended with a decision, not an error, a limit or an empty answer. */
  readonly succeeded: boolean;
  /** Another tick held the guard; this one did nothing. */
  readonly skipped?: boolean;
}

/** A tick succeeded when the agent exited cleanly and gave an answer that is not a limit or failure notice. */
export function tickSucceeded(exitCode: number | null, answer: string): boolean {
  return exitCode === 0 && answer.trim().length > 0 && !/^(Osiągnięto limit|Nie udało się zakończyć)/u.test(answer.trim());
}

const here = dirname(fileURLToPath(import.meta.url));
const pirxRoot = resolve(here, "..", "..", "..");

/** The commit this runtime was built from: the runtime-<sha> directory name, or git in a checkout. */
export function runtimeCommit(): string | null {
  const fromDir = /runtime-([0-9a-f]{7,40})/u.exec(pirxRoot)?.[1];
  if (fromDir !== undefined) return fromDir;
  const head = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: pirxRoot, encoding: "utf8" });
  return head.status === 0 ? head.stdout.trim() : null;
}

export function extractAnswer(output: string): string {
  const start = output.lastIndexOf("\nPirx: ");
  if (start < 0) return output.trim().slice(-2000);
  const rest = output.slice(start + 7);
  const end = rest.search(/\n(?:Metryki:|Kontekst:|Sesja zakończona)/u);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export async function loadedModels(baseUrl: string): Promise<string[]> {
  try {
    const loaded = await (await fetch(`${baseUrl}/api/ps`)).json() as { models?: { name: string }[] };
    return (loaded.models ?? []).map((model) => model.name);
  } catch { return []; /* Ollama down: nothing is loaded */ }
}

/**
 * Frees the GPU after a tick, but only of models the tick loaded itself. A model that was already
 * loaded (an open chat) stays, so the chat's next answer does not wait for a reload.
 */
export async function unloadModels(baseUrl: string, keep: readonly string[] = []): Promise<void> {
  for (const name of await loadedModels(baseUrl)) {
    if (keep.includes(name)) continue;
    try { await fetch(`${baseUrl}/api/generate`, { method: "POST", body: JSON.stringify({ model: name, keep_alive: 0 }) }); } catch { /* gone */ }
  }
}

export async function runTick(options: TickOptions): Promise<TickResult> {
  const environment = options.environment ?? process.env;
  const tick = `tick-${new Date().toISOString()}`;
  const storage = options.storage ?? defaultStoragePath(environment);
  // One tick at a time, however it was started (watcher, `pnpm tick`, a second manual run).
  const guard = tickGuardPath(storage);
  if (!takeGuard(guard)) return { tick, exitCode: null, answer: "Another tick is running.", toolCalls: 0, durationMs: 0, succeeded: false, skipped: true };
  try { return await runGuardedTick(options, environment, tick, storage); } finally { releaseGuard(guard); }
}

async function runGuardedTick(options: TickOptions, environment: NodeJS.ProcessEnv, tick: string, storage: string): Promise<TickResult> {
  const prompt = options.prompt ?? `${readFileSync(join(pirxRoot, "agent", "prompts", "tick.md"), "utf8")}\n\nCzas: ${new Date().toISOString()}\nZdarzenia, które Cię obudziły:\n${options.trigger}\n`;
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PIRX_TOOL_PROFILE: "coordination",
    PIRX_TICK_ID: tick,
    PIRX_STORAGE_FILE: storage,
    // Keep the model loaded for the whole tick (keep_alive 0 would reload it for every call), then unload it at the end.
    OLLAMA_KEEP_ALIVE: environment.PIRX_TICK_KEEP_ALIVE ?? "15m",
    // One model call in a tick can take over 2 min: the context holds real facts and part of the model runs on the CPU (live tick 2026-11-20 14:37).
    PIRX_LLM_TIMEOUT_MS: environment.PIRX_LLM_TIMEOUT_MS ?? "300000",
    PIRX_MAX_TOOL_CALLS: environment.PIRX_MAX_TOOL_CALLS ?? "25",
    PIRX_MAX_TOOL_ITERATIONS: environment.PIRX_MAX_TOOL_ITERATIONS ?? "30",
    PIRX_MAX_TURN_DURATION_MS: environment.PIRX_MAX_TURN_DURATION_MS ?? "1200000",
    PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS: environment.PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS ?? "60000",
    PIRX_MAX_OUTPUT_TOKENS: environment.PIRX_MAX_OUTPUT_TOKENS ?? "2048",
    PIRX_MAX_MUTATIONS_PER_TOOL: environment.PIRX_MAX_MUTATIONS_PER_TOOL ?? "2",
    ...(options.dryRun === true ? { PIRX_COORDINATION_DRY_RUN: "1" } : {}),
    ...(options.evalFixture === undefined ? {} : { PIRX_COORDINATION_EVAL: options.evalFixture }),
  };
  const startedAt = Date.now();
  const ollama = environment.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const loadedBefore = await loadedModels(ollama);
  const output = await new Promise<{ code: number | null; text: string }>((resolveRun) => {
    const child = spawn(process.execPath, ["--enable-source-maps", join(pirxRoot, "agent", "dist", "index.js"), "--once"], { cwd: pirxRoot, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.on("close", (code) => resolveRun({ code, text }));
    child.stdin.end(prompt);
  });
  const answer = extractAnswer(output.text);
  if (environment.PIRX_TICK_UNLOAD !== "0") await unloadModels(ollama, loadedBefore);
  const store = new CoordinationStore(storage);
  try {
    const toolCalls = store.journal({ tick, kind: "tool", limit: 500 }).length;
    const succeeded = tickSucceeded(output.code, answer);
    store.append({ tick, kind: "tick", name: "tick", input: { trigger: options.trigger, model: environment.OLLAMA_MODEL ?? null, runtime: pirxRoot, commit: runtimeCommit(), ...(options.dryRun === true ? { dryRun: true } : {}), ...(options.evalFixture === undefined ? {} : { eval: options.evalFixture }) }, output: { answer, toolCalls, exitCode: output.code, durationMs: Date.now() - startedAt, ...(succeeded ? {} : { outputTail: output.text.slice(-3000) }) }, ok: succeeded });
    return { tick, exitCode: output.code, answer, toolCalls, durationMs: Date.now() - startedAt, succeeded };
  } finally { store.close(); }
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runTick({
    trigger: argument("--trigger") ?? "Ręczny tick operatora.",
    dryRun: process.argv.includes("--dry-run"),
    ...(argument("--eval") === undefined ? {} : { evalFixture: resolve(argument("--eval")!) }),
    ...(argument("--storage") === undefined ? {} : { storage: resolve(argument("--storage")!) }),
  });
  process.stdout.write(`${result.tick} (${Math.round(result.durationMs / 1000)} s, ${result.toolCalls} tool calls, exit ${result.exitCode})\n${result.answer}\n`);
  process.exit(result.exitCode === 0 ? 0 : 1);
}
