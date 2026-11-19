#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  readonly storage?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface TickResult {
  readonly tick: string;
  readonly exitCode: number | null;
  readonly answer: string;
  readonly toolCalls: number;
  readonly durationMs: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const pirxRoot = resolve(here, "..", "..", "..");

export function extractAnswer(output: string): string {
  const start = output.lastIndexOf("\nPirx: ");
  if (start < 0) return output.trim().slice(-2000);
  const rest = output.slice(start + 7);
  const end = rest.search(/\n(?:Metryki:|Kontekst:|Sesja zakończona)/u);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

export async function runTick(options: TickOptions): Promise<TickResult> {
  const environment = options.environment ?? process.env;
  const tick = `tick-${new Date().toISOString()}`;
  const storage = options.storage ?? defaultStoragePath(environment);
  const prompt = `${readFileSync(join(pirxRoot, "agent", "prompts", "tick.md"), "utf8")}\n\nCzas: ${new Date().toISOString()}\nZdarzenia, które Cię obudziły:\n${options.trigger}\n`;
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    PIRX_TOOL_PROFILE: "coordination",
    PIRX_TICK_ID: tick,
    PIRX_STORAGE_FILE: storage,
    OLLAMA_KEEP_ALIVE: environment.PIRX_TICK_KEEP_ALIVE ?? "0",
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
  const output = await new Promise<{ code: number | null; text: string }>((resolveRun) => {
    const child = spawn(process.execPath, ["--enable-source-maps", join(pirxRoot, "agent", "dist", "index.js"), "--once"], { cwd: pirxRoot, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
    child.on("close", (code) => resolveRun({ code, text }));
    child.stdin.end(prompt);
  });
  const answer = extractAnswer(output.text);
  const store = new CoordinationStore(storage);
  try {
    const toolCalls = store.journal({ tick, kind: "tool", limit: 500 }).length;
    store.append({ tick, kind: "tick", name: "tick", input: { trigger: options.trigger, model: environment.OLLAMA_MODEL ?? null, ...(options.dryRun === true ? { dryRun: true } : {}), ...(options.evalFixture === undefined ? {} : { eval: options.evalFixture }) }, output: { answer, toolCalls, exitCode: output.code, durationMs: Date.now() - startedAt, ...(output.code === 0 ? {} : { outputTail: output.text.slice(-3000) }) }, ok: output.code === 0 });
    return { tick, exitCode: output.code, answer, toolCalls, durationMs: Date.now() - startedAt };
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
