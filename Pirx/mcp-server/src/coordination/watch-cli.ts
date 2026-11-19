#!/usr/bin/env node
import { createHash } from "node:crypto";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pidAlive } from "./facts.js";
import { jsonOf, runCommand, type Runner } from "./shell.js";
import { loadCoordinationSettings, type CoordinationSettings } from "./settings.js";
import { CoordinationStore, defaultStoragePath } from "./store.js";
import { runTick } from "./tick-cli.js";

/**
 * The watcher (docs/control-center-refactor.md, T6). It decides nothing: it notices that
 * something happened (worker exited, CI on a pirx/* PR changed, the queue changed, or the
 * timer elapsed) and wakes one tick with that list. Run it every few minutes from systemd.
 */

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export async function collectEvents(store: CoordinationStore, settings: CoordinationSettings, run: Runner, timerMinutes: number): Promise<string[]> {
  const events: string[] = [];
  const lock = store.lock();
  if (lock !== undefined && !pidAlive(lock.pid) && store.watchValue("worker_report") !== lock.reportPath) {
    events.push(`Worker zakończył pracę nad ${lock.task} (raport: worker_status).`);
    store.setWatchValue("worker_report", lock.reportPath);
  }
  for (const repo of settings.repositories) {
    const prs = jsonOf(await run("gh", ["pr", "list", "-R", repo.repository, "--state", "open", "--json", "number,headRefName,headRefOid,mergeStateStatus,statusCheckRollup"])) as { number: number; headRefName: string; headRefOid: string; mergeStateStatus: string; statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[] }[] | undefined;
    if (prs === undefined) continue;
    const pirx = prs.filter((pr) => pr.headRefName.startsWith("pirx/")).map((pr) => ({ pr: pr.number, head: pr.headRefOid, merge: pr.mergeStateStatus, checks: (pr.statusCheckRollup ?? []).map((check) => check.conclusion ?? check.state ?? check.status ?? "") }));
    const key = `prs:${repo.repository}`; const value = digest(pirx);
    if (store.watchValue(key) !== undefined && store.watchValue(key) !== value) events.push(`Zmienił się stan PR albo CI na gałęziach pirx/* w ${repo.repository}: ${pirx.map((pr) => `#${pr.pr}`).join(", ") || "brak otwartych"}.`);
    store.setWatchValue(key, value);
  }
  if (settings.projectOwner !== undefined && settings.projectNumber !== undefined) {
    const items = jsonOf(await run("gh", ["project", "item-list", String(settings.projectNumber), "--owner", settings.projectOwner, "--format", "json", "--limit", "500"], { timeoutMs: 60_000 })) as { items?: Record<string, unknown>[] } | undefined;
    if (items !== undefined) {
      const queued = (items.items ?? []).filter((item) => item.worker === "Pirx" && item.status !== "Done").map((item) => [(item.content as { repository?: string; number?: number } | undefined)?.repository, (item.content as { number?: number } | undefined)?.number, item.status, item["queue Order"]]);
      const value = digest(queued);
      if (store.watchValue("queue") !== undefined && store.watchValue("queue") !== value) events.push("Zmieniła się kolejka zadań dla Pirxa.");
      store.setWatchValue("queue", value);
    }
  }
  const last = store.journal({ kind: "tick", limit: 1 })[0];
  if (last === undefined || Date.parse(store.now()) - Date.parse(last.at) >= timerMinutes * 60_000) events.push(`Obchód okresowy (minęło ${last === undefined ? "?" : Math.round((Date.parse(store.now()) - Date.parse(last.at)) / 60_000)} min od ostatniego ticka).`);
  return events;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const environment = process.env;
  const settings = loadCoordinationSettings(environment);
  const storage = defaultStoragePath(environment);
  const guard = join(dirname(storage), "pirx-tick.lock");
  let fd: number;
  try { fd = openSync(guard, "wx"); } catch { process.stdout.write("A tick is already running.\n"); process.exit(0); }
  try {
    const store = new CoordinationStore(storage);
    const events = await collectEvents(store, settings, runCommand, Number(environment.PIRX_TICK_TIMER_MINUTES ?? 60));
    store.close();
    if (events.length === 0) { process.stdout.write("No events.\n"); process.exit(0); }
    const result = await runTick({ trigger: events.map((event) => `- ${event}`).join("\n"), dryRun: settings.dryRun, storage });
    process.stdout.write(`${result.tick} (${Math.round(result.durationMs / 1000)} s, ${result.toolCalls} tool calls)\n${result.answer}\n`);
  } finally { closeSync(fd); unlinkSync(guard); }
}
