import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const EXPORT_TABLES = [
  "run_environments",
  "sessions",
  "turns",
  "operations",
  "context_builds",
  "messages",
  "artifacts",
  "action_events",
  "resource_samples",
] as const;

export interface RetentionReport {
  readonly cutoff: string;
  readonly resourceSamples: number;
}

function plainRecord(value: unknown): Record<string, unknown> {
  return { ...(value as Record<string, unknown>) };
}

function assertIntegrity(database: DatabaseSync): void {
  const row = database.prepare("PRAGMA integrity_check").get() as {
    integrity_check: string;
  };
  if (row.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${row.integrity_check}`);
  }
}

export async function backupDatabase(
  sourceFilename: string,
  destinationFilename: string,
): Promise<number> {
  const source = new DatabaseSync(sourceFilename, { readOnly: true });
  try {
    assertIntegrity(source);
    await mkdir(dirname(destinationFilename), { recursive: true, mode: 0o700 });
    return await backup(source, destinationFilename);
  } finally {
    source.close();
  }
}

export async function restoreDatabase(
  backupFilename: string,
  destinationFilename: string,
): Promise<void> {
  const source = new DatabaseSync(backupFilename, { readOnly: true });
  try {
    assertIntegrity(source);
  } finally {
    source.close();
  }
  await mkdir(dirname(destinationFilename), { recursive: true, mode: 0o700 });
  await copyFile(backupFilename, destinationFilename);
}

export async function exportDatabaseJsonl(
  sourceFilename: string,
  destinationFilename: string,
): Promise<number> {
  const source = new DatabaseSync(sourceFilename, { readOnly: true });
  try {
    assertIntegrity(source);
    const lines: string[] = [];
    for (const table of EXPORT_TABLES) {
      const rows = source.prepare(`SELECT * FROM ${table}`).all();
      for (const row of rows) {
        lines.push(JSON.stringify({ table, record: plainRecord(row) }));
      }
    }
    await mkdir(dirname(destinationFilename), { recursive: true, mode: 0o700 });
    await writeFile(
      destinationFilename,
      lines.length === 0 ? "" : `${lines.join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return lines.length;
  } finally {
    source.close();
  }
}

export function retentionDryRun(
  sourceFilename: string,
  cutoff: string,
): RetentionReport {
  const source = new DatabaseSync(sourceFilename, { readOnly: true });
  try {
    const row = source
      .prepare("SELECT COUNT(*) AS count FROM resource_samples WHERE sampled_at < ?")
      .get(cutoff) as { count: number };
    return { cutoff, resourceSamples: row.count };
  } finally {
    source.close();
  }
}

export function pruneResourceSamples(
  sourceFilename: string,
  cutoff: string,
): number {
  const database = new DatabaseSync(sourceFilename);
  try {
    const result = database
      .prepare("DELETE FROM resource_samples WHERE sampled_at < ?")
      .run(cutoff);
    return Number(result.changes);
  } finally {
    database.close();
  }
}
