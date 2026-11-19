import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { taskKey, type JournalEntry } from "./store.js";
import { defineTool, issueInput, repositoryInput, type CoordinationContext } from "./toolkit.js";

const optionalTask = { repository: repositoryInput.optional(), issue: issueInput.optional() };
function keyOf(input: { repository?: string | undefined; issue?: number | undefined }): string | undefined {
  return input.repository !== undefined && input.issue !== undefined ? taskKey(input.repository, input.issue) : undefined;
}

function brief(entry: JournalEntry): Record<string, unknown> {
  return { seq: entry.seq, at: entry.at, kind: entry.kind, name: entry.name, ok: entry.ok, ...(entry.tick === undefined ? {} : { tick: entry.tick }), ...(entry.task === undefined ? {} : { task: entry.task }), ...(entry.input === undefined ? {} : { input: entry.input }), ...(entry.output === undefined ? {} : { output: entry.output }) };
}

export function registerJournalTools(server: McpServer, context: CoordinationContext): void {
  defineTool(server, context, {
    name: "journal_read",
    description: "Read Pirx's journal: earlier decisions, notes, questions and tool calls, newest last. Filter by Task or kind. This is Pirx's memory between ticks.",
    input: { ...optionalTask, kind: z.enum(["tool", "tick", "note", "question", "verdict"]).optional(), limit: z.number().int().min(1).max(200).optional() },
    mutating: false,
    run: async (input, { store }) => {
      const task = keyOf(input);
      const entries = store.journal({ ...(task === undefined ? {} : { task }), ...(input.kind === undefined ? {} : { kind: input.kind }), limit: input.limit ?? 30 });
      return entries.length === 0 ? { entries: [], note: "The journal has no matching entries." } : { entries: entries.map(brief) };
    },
  });

  defineTool(server, context, {
    name: "journal_note",
    description: "Write a note to Pirx's journal for later ticks, e.g. 'zdrovena#541 waits for the operator's dev-store test'. Optionally tied to one Task.",
    input: { ...optionalTask, text: z.string().min(1) },
    mutating: false,
    task: keyOf,
    run: async (input, { store, settings }) => {
      const task = keyOf(input);
      const entry = store.append({ ...(settings.tick === undefined ? {} : { tick: settings.tick }), ...(task === undefined ? {} : { task }), kind: "note", name: "note", input: { text: input.text }, ok: true });
      return { recorded: true, seq: entry.seq };
    },
  });

  defineTool(server, context, {
    name: "journal_verdict",
    description: "Record the operator's verdict on an earlier journal entry: 'wrong' marks a bad decision so it joins the eval set; 'right' confirms it. Use when the operator says so in chat.",
    input: { seq: z.number().int().positive(), verdict: z.enum(["wrong", "right"]), note: z.string().optional() },
    mutating: false,
    run: async (input, { store }) => {
      const target = store.journal({ limit: 500 }).find((entry) => entry.seq === input.seq);
      if (target === undefined) return { found: false, note: `No journal entry ${input.seq}.` };
      const entry = store.append({ ...(target.task === undefined ? {} : { task: target.task }), ...(target.tick === undefined ? {} : { tick: target.tick }), kind: "verdict", name: input.verdict, input: { seq: input.seq, ...(input.note === undefined ? {} : { note: input.note }) }, ok: true });
      return { recorded: true, seq: entry.seq, about: brief(target) };
    },
  });

  defineTool(server, context, {
    name: "pirx_explain",
    description: "Timeline of one Task from the journal: each tick with its trigger, the facts Pirx read, the tools it called with results, its decision and reason, and any operator verdicts.",
    input: { repository: repositoryInput, issue: issueInput, limit: z.number().int().min(1).max(500).optional() },
    mutating: false,
    run: async (input, { store }) => {
      const task = taskKey(input.repository, input.issue);
      const own = store.journal({ task, limit: input.limit ?? 200 });
      const ticks = [...new Set(own.map((entry) => entry.tick).filter((tick): tick is string => tick !== undefined))];
      const tickEntries = ticks.flatMap((tick) => store.journal({ tick, kind: "tick", limit: 5 }));
      const all = [...own, ...tickEntries].sort((a, b) => a.seq - b.seq).filter((entry, index, list) => index === 0 || entry.seq !== list[index - 1]!.seq);
      if (all.length === 0) return { task, timeline: [], note: "Pirx has not worked on this Task yet." };
      return { task, current: store.getTask(task) ?? null, timeline: all.map(brief) };
    },
  });
}
