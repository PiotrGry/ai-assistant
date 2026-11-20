#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CoordinationStore, type JournalEntry } from "./store.js";
import { runTick, runtimeCommit, tickSucceeded } from "./tick-cli.js";

/**
 * Coordination evals (docs/control-center-refactor.md, T7). Each case replays a real situation:
 * the tools answer from the case file, mutating calls are only recorded, and a pass rule checks
 * which tools the model chose.
 *
 *   node dist/coordination/eval-cli.js [--runs 3] [--case quota-after-commit]
 */

interface Rule { readonly tool: string; readonly [field: string]: unknown }
interface EvalCase { readonly description: string; readonly trigger: string; readonly prompt?: string; readonly pass: { readonly anyOf: readonly Rule[]; readonly forbid: readonly Rule[] } }

export interface RunVerdict { readonly passed: boolean; readonly refused: string[]; readonly reason: string; readonly calls: string[]; readonly usedOpus: boolean; readonly answer: string; readonly durationMs: number }

function matches(entry: JournalEntry, rule: Rule): boolean {
  if (entry.kind !== "tool" || entry.name !== rule.tool) return false;
  const input = (entry.input ?? {}) as Record<string, unknown>;
  return Object.entries(rule).every(([key, value]) => key === "tool" || input[key] === value);
}

export function judge(testCase: EvalCase, entries: readonly JournalEntry[]): { passed: boolean; reason: string } {
  // A forbidden call counts only when it took effect; a call the tool refused changed nothing.
  const forbidden = entries.find((entry) => entry.ok && testCase.pass.forbid.some((rule) => matches(entry, rule)));
  if (forbidden !== undefined) return { passed: false, reason: `called forbidden ${forbidden.name} ${JSON.stringify(forbidden.input)}` };
  if (testCase.pass.anyOf.length === 0) return { passed: true, reason: "no forbidden call" };
  const hit = entries.find((entry) => testCase.pass.anyOf.some((rule) => matches(entry, rule)));
  return hit === undefined ? { passed: false, reason: `none of: ${testCase.pass.anyOf.map((rule) => JSON.stringify(rule)).join(" | ")}` } : { passed: true, reason: `called ${hit.name}` };
}

const here = dirname(fileURLToPath(import.meta.url));
const casesDir = resolve(here, "..", "..", "evals");

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runs = Number(argument("--runs") ?? 3);
  const only = argument("--case");
  const files = readdirSync(casesDir).filter((file) => file.endsWith(".json") && (only === undefined || basename(file, ".json") === only)).sort();
  const model = process.env.OLLAMA_MODEL ?? "(chat.json model)";
  const results: Record<string, RunVerdict[]> = {};
  for (const file of files) {
    const name = basename(file, ".json");
    const testCase = JSON.parse(readFileSync(join(casesDir, file), "utf8")) as EvalCase;
    results[name] = [];
    for (let index = 0; index < runs; index += 1) {
      const scratch = mkdtempSync(join(tmpdir(), "pirx-eval-"));
      const storage = join(scratch, "eval.sqlite");
      try {
        // The case's history becomes the eval journal, so journal_read shows what Pirx did before.
        const seed = new CoordinationStore(storage);
        const history = ((testCase as unknown as { tools?: { journal_read?: { entries?: Partial<JournalEntry>[] } } }).tools?.journal_read?.entries ?? []);
        for (const entry of history) seed.append({ ...(entry.task === undefined ? {} : { task: entry.task }), kind: entry.kind ?? "tool", name: entry.name ?? "note", ...(entry.input === undefined ? {} : { input: entry.input }), ...(entry.output === undefined ? {} : { output: entry.output }), ok: entry.ok ?? true });
        seed.close();
        const tick = await runTick({ trigger: testCase.trigger, ...(testCase.prompt === undefined ? {} : { prompt: testCase.prompt }), evalFixture: join(casesDir, file), storage });
        const store = new CoordinationStore(storage);
        const entries = store.journal({ tick: tick.tick, kind: "tool", limit: 500 });
        store.close();
        // A run that ended without a decision (a limit, a failure notice) fails, whatever tools it called.
        const verdict = tickSucceeded(tick.exitCode, tick.answer) ? judge(testCase, entries) : { passed: false, reason: `no decision: ${tick.answer.slice(0, 80)}` };
        results[name].push({ ...verdict, calls: entries.map((entry) => entry.name), refused: entries.filter((entry) => !entry.ok).map((entry) => entry.name), usedOpus: entries.some((entry) => entry.name === "ask_opus"), answer: tick.answer, durationMs: tick.durationMs });
        process.stdout.write(`${name} run ${index + 1}/${runs}: ${verdict.passed ? "PASS" : "FAIL"} (${verdict.reason}) [${entries.map((entry) => `${entry.name}${entry.ok ? "" : "(refused)"}`).join(", ")}] ${Math.round(tick.durationMs / 1000)} s\n`);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
  }
  const summary = Object.entries(results).map(([name, verdicts]) => ({ name, passed: verdicts.filter((verdict) => verdict.passed).length, runs: verdicts.length, alone: verdicts.filter((verdict) => verdict.passed && !verdict.usedOpus).length, withOpus: verdicts.filter((verdict) => verdict.passed && verdict.usedOpus).length, refusedAttempts: verdicts.reduce((sum, verdict) => sum + verdict.refused.length, 0) }));
  const gate = summary.every((item) => item.passed === item.runs);
  process.stdout.write(`\nModel: ${model}\n${summary.map((item) => `${item.name.padEnd(24)} ${item.passed}/${item.runs}  (alone ${item.alone}, with ask_opus ${item.withOpus}, refused by tools ${item.refusedAttempts})`).join("\n")}\nGate (every case, every run): ${gate ? "PASS" : "FAIL"}\n`);
  const outDir = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "pirx", "evals");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
  writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), model, commit: runtimeCommit(), cases: files.length, only: only ?? null, runs, gate, summary, results }, null, 1));
  process.stdout.write(`Saved ${outFile}\n`);
  process.exit(gate ? 0 : 1);
}
