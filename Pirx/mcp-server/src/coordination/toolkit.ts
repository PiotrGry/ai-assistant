import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Runner } from "./shell.js";
import { guardHeldByOther, tickGuardPath } from "./proc.js";
import { stopped, type CoordinationSettings } from "./settings.js";
import type { CoordinationStore } from "./store.js";

export interface CoordinationContext {
  readonly store: CoordinationStore;
  readonly settings: CoordinationSettings;
  readonly run: Runner;
  readonly environment: NodeJS.ProcessEnv;
}

export interface ToolSpec<Shape extends z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly input: Shape;
  /** Mutating tools obey the stop switch and dry-run mode. */
  readonly mutating: boolean;
  /** Works only on Pirx's own journal, so it runs for real even in eval and dry-run mode. */
  readonly local?: boolean;
  /** The Task this call is about, for the journal (`owner/repo#N`). */
  readonly task?: (input: z.infer<z.ZodObject<Shape>>) => string | undefined;
  readonly run: (input: z.infer<z.ZodObject<Shape>>, context: CoordinationContext) => Promise<Record<string, unknown>>;
}

const MUTATING_COMMANDS: readonly RegExp[] = [
  /^git push\b/u, /^git worktree (?:add|move|remove)\b/u, /^git branch -m\b/u,
  /^gh (?:pr (?:create|update-branch|merge)|issue (?:close|comment|create|reopen|edit)|run rerun|project item-(?:add|edit))\b/u,
];

/** In dry-run, commands that would change git or GitHub are recorded and answered with a plausible success. */
export function dryRunner(run: Runner, intercepted: string[]): Runner {
  return async (file, args, options) => {
    const command = [file, ...args].join(" ");
    if (!MUTATING_COMMANDS.some((pattern) => pattern.test(command))) return run(file, args, options);
    intercepted.push(command);
    const stdout = /^gh project item-add/u.test(command) ? JSON.stringify({ id: "dry-run-item" }) : /^gh (?:pr|issue) create/u.test(command) ? "https://github.com/dry-run/0" : "";
    return { ok: true, code: 0, stdout, stderr: "", command };
  };
}

/** A result the tool returns when it refuses on a hard limit. The model reads `refused` and `reason`. */
export function refuse(reason: string, facts: Record<string, unknown> = {}): Record<string, unknown> {
  return { refused: true, reason, ...facts };
}

interface FixtureCase { readonly match?: Record<string, unknown>; readonly result: Record<string, unknown> }
type Fixture = { readonly tools?: Record<string, Record<string, unknown> | readonly FixtureCase[]> };

let fixtureCache: { path: string; value: Fixture } | undefined;
function fixture(path: string): Fixture {
  if (fixtureCache?.path !== path) fixtureCache = { path, value: JSON.parse(readFileSync(path, "utf8")) as Fixture };
  return fixtureCache.value;
}

function matches(input: Record<string, unknown>, match: Record<string, unknown> | undefined): boolean {
  if (match === undefined) return true;
  return Object.entries(match).every(([key, value]) => JSON.stringify(input[key]) === JSON.stringify(value));
}

/** Eval mode: facts come from the case file, and mutating calls are only recorded. */
function fromFixture(path: string, name: string, input: Record<string, unknown>, mutating: boolean): Record<string, unknown> {
  const entry = fixture(path).tools?.[name];
  if (Array.isArray(entry)) {
    const found = (entry as readonly FixtureCase[]).find((item) => matches(input, item.match));
    if (found !== undefined) return found.result;
  } else if (entry !== undefined) return entry as Record<string, unknown>;
  return mutating ? { done: true, note: "Recorded (eval)." } : { results: [], note: "Nothing found. That is a complete answer; calling again with other arguments will not change it." };
}

/** How often one read tool may run in a single tick. The local model otherwise loops on searches (evals 2026-11-19 and 2026-11-20). */
export const MAX_READS_PER_TOOL_PER_TICK = 6;

function tooManyReads(context: CoordinationContext, name: string): Record<string, unknown> | undefined {
  const tick = context.settings.tick;
  if (tick === undefined) return undefined;
  const calls = context.store.journal({ tick, kind: "tool", limit: 500 }).filter((entry) => entry.name === name).length;
  return calls >= MAX_READS_PER_TOOL_PER_TICK ? refuse(`${name} already ran ${calls} times in this tick. More calls will not add facts: decide with what you have.`) : undefined;
}

/**
 * Wraps tools registered elsewhere (production errors, code health) so that they are journaled
 * and answer from the case file in eval mode, like every coordination tool.
 */
export function journaledServer(server: McpServer, context: CoordinationContext): McpServer {
  return { registerTool: (name: string, config: unknown, handler: (input: unknown, extra: unknown) => Promise<{ structuredContent?: unknown; isError?: boolean }>) =>
    (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => unknown)(name, config, async (input: unknown, extra: unknown) => {
      const tick = context.settings.tick === undefined ? {} : { tick: context.settings.tick };
      const repeated = tooManyReads(context, name);
      if (repeated !== undefined || context.settings.evalFixture !== undefined) {
        const result = repeated ?? fromFixture(context.settings.evalFixture!, name, (input ?? {}) as Record<string, unknown>, false);
        context.store.append({ ...tick, kind: "tool", name, input, output: result, ok: repeated === undefined });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(repeated === undefined ? {} : { isError: true }) };
      }
      const response = await handler(input, extra);
      context.store.append({ ...tick, kind: "tool", name, input, output: response.structuredContent, ok: response.isError !== true });
      return response;
    }) } as unknown as McpServer;
}

export function defineTool<Shape extends z.ZodRawShape>(server: McpServer, context: CoordinationContext, spec: ToolSpec<Shape>): void {
  server.registerTool(spec.name, {
    title: spec.name,
    description: spec.description,
    inputSchema: z.object(spec.input).strict(),
    annotations: { readOnlyHint: !spec.mutating, idempotentHint: !spec.mutating, destructiveHint: spec.mutating, openWorldHint: true },
  }, async (rawInput) => {
    const input = rawInput as z.infer<z.ZodObject<Shape>>;
    const task = spec.task?.(input);
    let result: Record<string, unknown>;
    let ok = true;
    try {
      const repeated = spec.mutating || spec.local === true ? undefined : tooManyReads(context, spec.name);
      if (repeated !== undefined) result = repeated;
      else if (spec.local === true) result = await spec.run(input, context);
      else if (context.settings.evalFixture !== undefined) result = fromFixture(context.settings.evalFixture, spec.name, input as Record<string, unknown>, spec.mutating);
      else if (spec.mutating && context.settings.tick === undefined && guardHeldByOther(tickGuardPath(context.store.path))) result = refuse("A tick is running and may be acting on the same Tasks. Try again when it ends (usually 1–5 minutes); read tools work meanwhile.");
      else if (spec.mutating && stopped(context.settings)) result = refuse(`The stop switch is on (${context.settings.stopFile} exists). No mutating tool runs until the operator removes it.`);
      else if (spec.mutating && context.settings.dryRun) {
        // Dry-run runs the tool's real checks and reads; only commands that change something are intercepted.
        const intercepted: string[] = [];
        result = await spec.run(input, { ...context, run: dryRunner(context.run, intercepted) });
        result = { dryRun: true, ...result, ...(intercepted.length === 0 ? {} : { wouldRun: intercepted }) };
      }
      else result = await spec.run(input, context);
      ok = result.refused !== true && result.failed === undefined && result.error === undefined;
    } catch (error: unknown) {
      ok = false;
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    context.store.append({ ...(context.settings.tick === undefined ? {} : { tick: context.settings.tick }), ...(task === undefined ? {} : { task }), kind: "tool", name: spec.name, input, output: result, ok });
    // A refusal is a definite answer, not a failed call: the chat must not report it as "outcome uncertain".
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(ok || result.refused === true ? {} : { isError: true }) };
  });
}

export const repositoryInput = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).describe("owner/name, e.g. PiotrGry/zdrovena-reconciliation");
export const issueInput = z.number().int().positive().describe("Issue number");
