import { readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { Runner } from "./shell.js";
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
  /** The Task this call is about, for the journal (`owner/repo#N`). */
  readonly task?: (input: z.infer<z.ZodObject<Shape>>) => string | undefined;
  readonly run: (input: z.infer<z.ZodObject<Shape>>, context: CoordinationContext) => Promise<Record<string, unknown>>;
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
  return mutating ? { done: true, note: "Recorded (eval)." } : { found: false, note: `No facts for ${name} with these arguments.` };
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
      if (context.settings.evalFixture !== undefined) result = fromFixture(context.settings.evalFixture, spec.name, input as Record<string, unknown>, spec.mutating);
      else if (spec.mutating && stopped(context.settings)) result = refuse(`The stop switch is on (${context.settings.stopFile} exists). No mutating tool runs until the operator removes it.`);
      else if (spec.mutating && context.settings.dryRun) result = { dryRun: true, wouldRun: spec.name, input };
      else result = await spec.run(input, context);
      ok = result.refused !== true && result.failed === undefined && result.error === undefined;
    } catch (error: unknown) {
      ok = false;
      result = { error: error instanceof Error ? error.message : String(error) };
    }
    context.store.append({ ...(context.settings.tick === undefined ? {} : { tick: context.settings.tick }), ...(task === undefined ? {} : { task }), kind: "tool", name: spec.name, input, output: result, ok });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result, ...(ok ? {} : { isError: true }) };
  });
}

export const repositoryInput = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).describe("owner/name, e.g. PiotrGry/zdrovena-reconciliation");
export const issueInput = z.number().int().positive().describe("Issue number");
