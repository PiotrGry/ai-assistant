import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SqliteStore } from "./storage/sqlite.js";

export interface SkippedImportFile {
  readonly file: string;
  readonly reason: "already_imported" | "no_valid_lines";
}

export interface SkippedImportLine {
  readonly file: string;
  readonly line: number;
  readonly reason: "invalid_json" | "missing_fields";
}

export interface ImportReport {
  readonly importedFiles: readonly string[];
  readonly skippedFiles: readonly SkippedImportFile[];
  readonly importedTurns: number;
  readonly skippedLines: readonly SkippedImportLine[];
}

interface LoggedTurn {
  readonly line: number;
  readonly timestamp: string;
  readonly prompt: string;
  readonly response: string;
  readonly metrics: Record<string, unknown>;
}

const SESSION_FILE = /^session_.+\.jsonl$/u;

// Name-based UUID (version 5 layout) so a re-run maps the same log line to the same row id.
export function importId(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseLines(file: string, text: string, skipped: SkippedImportLine[]): LoggedTurn[] {
  const turns: LoggedTurn[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = index + 1;
    if (raw.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      skipped.push({ file, line, reason: "invalid_json" });
      continue;
    }
    if (!isRecord(value)) {
      skipped.push({ file, line, reason: "missing_fields" });
      continue;
    }
    const { timestamp, prompt, response } = value;
    if (
      typeof timestamp !== "string" ||
      !Number.isFinite(Date.parse(timestamp)) ||
      typeof prompt !== "string" ||
      typeof response !== "string"
    ) {
      skipped.push({ file, line, reason: "missing_fields" });
      continue;
    }
    const metrics = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "prompt" && key !== "response"),
    );
    turns.push({ line, timestamp, prompt, response, metrics });
  }
  return turns;
}

function endedAt(turn: LoggedTurn): string {
  const duration = numberOrNull(turn.metrics.turn_duration_ms) ?? 0;
  return new Date(Date.parse(turn.timestamp) + duration).toISOString();
}

export async function importSessionLogs(store: SqliteStore, directory: string): Promise<ImportReport> {
  const files = (await readdir(directory)).filter((name) => SESSION_FILE.test(name)).sort();
  const importedFiles: string[] = [];
  const skippedFiles: SkippedImportFile[] = [];
  const skippedLines: SkippedImportLine[] = [];
  let importedTurns = 0;

  for (const file of files) {
    const turns = parseLines(file, await readFile(join(directory, file), "utf8"), skippedLines);
    const first = turns[0];
    const last = turns.at(-1);
    if (first === undefined || last === undefined) {
      skippedFiles.push({ file, reason: "no_valid_lines" });
      continue;
    }
    const sessionId = importId(`pirx-import:session:${file}`);
    if (store.sessionExists(sessionId)) {
      skippedFiles.push({ file, reason: "already_imported" });
      continue;
    }
    const environmentId = importId(`pirx-import:environment:${file}`);

    store.transaction(() => {
      store.insertRunEnvironment({
        id: environmentId,
        createdAt: first.timestamp,
        payload: {
          schema_version: 1,
          model: stringOrNull(first.metrics.model),
          num_ctx: numberOrNull(first.metrics.context),
          temperature: numberOrNull(first.metrics.temperature),
          time_zone: stringOrNull(first.metrics.time_zone),
          prompt_file: stringOrNull(first.metrics.system_prompt_file),
          prompt_sha256: stringOrNull(first.metrics.system_prompt_sha256),
          storage_mode: "full_local",
          imported_from: file,
        },
      });
      store.insertSession({ id: sessionId, environmentId, startedAt: first.timestamp, status: "active" });
      for (const turn of turns) {
        const turnId = importId(`pirx-import:turn:${file}:${turn.line}`);
        store.insertTurn({
          id: turnId,
          sessionId,
          sequence: turn.line - 1,
          startedAt: turn.timestamp,
          status: "started",
          userPrompt: turn.prompt,
          payload: { schema_version: 1, storage_mode: "full_local" },
        });
        store.finishTurn(turnId, endedAt(turn), "completed", {
          schema_version: 1,
          storage_mode: "full_local",
          response: turn.response,
          metrics: turn.metrics,
          imported: { source: file, line: turn.line },
        });
      }
      store.finishSession(sessionId, endedAt(last), "completed");
    });

    importedFiles.push(file);
    importedTurns += turns.length;
  }

  return { importedFiles, skippedFiles, importedTurns, skippedLines };
}
