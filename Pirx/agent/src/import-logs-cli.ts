import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { importSessionLogs } from "./import-logs.js";
import { SqliteStore } from "./storage/sqlite.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.storagePath === undefined) {
    throw new Error("Brak ścieżki bazy Pirxa (PIRX_STORAGE_FILE).");
  }
  const directory = resolve(process.argv[2] ?? config.logDir);
  await mkdir(dirname(config.storagePath), { recursive: true, mode: 0o700 });
  const store = SqliteStore.open({ filename: config.storagePath });
  try {
    const report = await importSessionLogs(store, directory);
    console.log(`Katalog logów: ${directory}`);
    console.log(`Baza: ${config.storagePath}`);
    console.log(`Zaimportowane pliki: ${report.importedFiles.length}, tury: ${report.importedTurns}`);
    for (const skipped of report.skippedFiles) {
      console.log(`Pominięty plik ${skipped.file}: ${skipped.reason}`);
    }
    for (const skipped of report.skippedLines) {
      console.log(`Pominięta linia ${skipped.file}:${skipped.line}: ${skipped.reason}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Import logów nie powiódł się: ${detail}\n`);
  process.exitCode = 1;
});
