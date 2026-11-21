#!/usr/bin/env node
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AWAITING_DELIVERY } from "./actions.js";
import { issueOfBranch, projectItems } from "./facts.js";
import { guardHeldByOther, pidAlive, tickGuardPath } from "./proc.js";

export { issueOfBranch } from "./facts.js";

export { takeGuard } from "./proc.js";
import { jsonOf, runCommand, type Runner } from "./shell.js";
import { loadCoordinationSettings, type CoordinationSettings } from "./settings.js";
import { CoordinationStore, defaultStoragePath, taskKey } from "./store.js";
import { runTick } from "./tick-cli.js";

/**
 * The watcher (docs/control-center-refactor.md, T6). It decides nothing: it notices that
 * something happened (worker exited, CI on a pirx/* PR changed, the queue changed, or the
 * timer elapsed) and wakes one tick with that list. Run it every few minutes from systemd.
 */


export const IDLE_NUDGE_MINUTES = 15;
export const PROJECT_WATCH_MINUTES = 14;

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** Overall state of a pull request, so one CI run with many checks is one change, not many. */
export function prState(pr: { mergeStateStatus?: string; statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[] }): string {
  const checks = (pr.statusCheckRollup ?? []).map((check) => String(check.conclusion ?? check.state ?? check.status ?? "").toUpperCase());
  const ci = checks.some((value) => ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(value)) ? "red"
    : checks.some((value) => ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "WAITING", "REQUESTED"].includes(value)) ? "pending" : "green";
  return `${ci}/${String(pr.mergeStateStatus ?? "UNKNOWN").toLowerCase()}`;
}

export interface CollectedEvents {
  readonly events: string[];
  /** Stores the cursors of these events. Call it only after a tick handled them. */
  commit(): void;
}

export const MAX_FAILED_TICKS_PER_EVENT = 3;

export async function collectEvents(store: CoordinationStore, settings: CoordinationSettings, run: Runner, timerMinutes: number): Promise<CollectedEvents> {
  const events: string[] = [];
  const pending: [string, string][] = [];
  const lock = store.lock();
  const working = lock !== undefined && pidAlive(lock.pid, lock.pidStart);
  if (lock !== undefined && !working && store.watchValue("worker_report") !== lock.reportPath) {
    events.push(`Worker zakończył pracę nad ${lock.task} (raport: worker_status).`);
    pending.push(["worker_report", lock.reportPath]);
  }
  for (const repo of settings.repositories) {
    // Tasks parked until their change reaches the target branch: wake a tick when that branch moves.
    const awaiting = store.listTasks("parked").filter((task) => task.repository.toLowerCase() === repo.repository.toLowerCase() && (task.note ?? "").startsWith(AWAITING_DELIVERY));
    if (awaiting.length > 0) {
      const remote = await run("git", ["ls-remote", repo.remoteName, `refs/heads/${repo.targetBranch}`], { cwd: repo.repositoryRoot, timeoutMs: 60_000 });
      const head = remote.ok ? remote.stdout.trim().split(/\s+/u)[0] : undefined;
      if (head) {
        const key = `target:${repo.repository}`;
        const before = store.watchValue(key);
        if (before !== undefined && before !== head) events.push(`Gałąź ${repo.targetBranch} w ${repo.repository} przesunęła się. Zadania czekające na wydanie: ${awaiting.map((task) => `#${task.issue}`).join(", ")}. Spróbuj task_close dla każdego.`);
        pending.push([key, head]);
      }
    }
    const prs = jsonOf(await run("gh", ["pr", "list", "-R", repo.repository, "--state", "open", "--json", "number,headRefName,headRefOid,mergeStateStatus,statusCheckRollup"])) as { number: number; headRefName: string; headRefOid: string; mergeStateStatus: string; statusCheckRollup?: { conclusion?: string; status?: string; state?: string }[] }[] | undefined;
    if (prs === undefined) continue;
    const pirx = prs.filter((pr) => pr.headRefName.startsWith("pirx/")).map((pr) => ({ pr: pr.number, branch: pr.headRefName, issue: issueOfBranch(pr.headRefName), head: pr.headRefOid, state: prState(pr) }));
    const key = `prs:${repo.repository}`; const value = digest(pirx.map((pr) => [pr.pr, pr.head, pr.state]));
    if (store.watchValue(key) !== undefined && store.watchValue(key) !== value) events.push(`Zmienił się stan PR w ${repo.repository}: ${pirx.map((pr) => `PR #${pr.pr} (${pr.issue === undefined ? "zadanie nieznane" : `zadanie #${pr.issue}`}, gałąź ${pr.branch}, CI/merge: ${pr.state})`).join(", ") || "brak otwartych PR z gałęzi pirx/*"}.`);
    pending.push([key, value]);
  }
  if (settings.projectOwner !== undefined && settings.projectNumber !== undefined) {
    // The watcher reads the Project at most every PROJECT_WATCH_MINUTES; queue changes are rarely urgent, and the tick's own reads reuse this copy.
    const items = jsonOf(await projectItems(run, store, settings, PROJECT_WATCH_MINUTES * 60_000)) as { items?: Record<string, unknown>[] } | undefined;
    if (items !== undefined) {
      const coordinated = new Set(settings.repositories.map((repo) => repo.repository.toLowerCase()));
      const all = (items.items ?? []).filter((item) => item.worker === "Pirx" && item.status !== "Done");
      // Work Pirx can pick up now: in a coordinated repository and not parked waiting for someone.
      const startable = all.filter((item) => {
        const content = item.content as { repository?: string; number?: number } | undefined;
        if (content?.repository === undefined || content.number === undefined || !coordinated.has(content.repository.toLowerCase())) return false;
        return store.getTask(taskKey(content.repository, content.number))?.state !== "parked";
      });
      const queued = all.map((item) => [(item.content as { repository?: string; number?: number } | undefined)?.repository, (item.content as { number?: number } | undefined)?.number, item.status, item["queue Order"]]);
      const value = digest(queued);
      if (store.watchValue("queue") !== undefined && store.watchValue("queue") !== value) events.push("Zmieniła się kolejka zadań dla Pirxa.");
      pending.push(["queue", value]);
      // Queued work with an idle worker is itself a reason to wake up, at most every IDLE_NUDGE_MINUTES.
      const lastNudge = Date.parse(store.watchValue("idle_nudge") ?? "1970-01-01T00:00:00.000Z");
      if (startable.length > 0 && !working && Date.parse(store.now()) - lastNudge >= IDLE_NUDGE_MINUTES * 60_000) {
        events.push(`W kolejce czeka ${startable.length} zadań dla Pirxa, a worker nie pracuje.`);
        store.setWatchValue("idle_nudge", store.now());
      }
    }
  }
  // The timer counts from the last tick that ended with a decision; failed ticks do not reset it.
  const last = store.journal({ kind: "tick", limit: 50 }).filter((entry) => entry.ok).at(-1);
  if (last === undefined || Date.parse(store.now()) - Date.parse(last.at) >= timerMinutes * 60_000) events.push(`Obchód okresowy (minęło ${last === undefined ? "?" : Math.round((Date.parse(store.now()) - Date.parse(last.at)) / 60_000)} min od ostatniego udanego ticka).`);
  return { events, commit: () => { for (const [name, value] of pending) store.setWatchValue(name, value); } };
}

/** After a tick: commit the cursors when it succeeded, or after too many failures in a row (the events stay visible through the idle nudge and the timer). */
export function settleEvents(store: CoordinationStore, collected: CollectedEvents, succeeded: boolean): void {
  const failures = succeeded ? 0 : Number(store.watchValue("failed_ticks") ?? "0") + 1;
  if (succeeded || failures >= MAX_FAILED_TICKS_PER_EVENT) { collected.commit(); store.setWatchValue("failed_ticks", "0"); }
  else store.setWatchValue("failed_ticks", String(failures));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const environment = process.env;
  const settings = loadCoordinationSettings(environment);
  const storage = defaultStoragePath(environment);
  if (guardHeldByOther(tickGuardPath(storage))) { process.stdout.write("A tick is already running.\n"); process.exit(0); }
  const store = new CoordinationStore(storage);
  const collected = await collectEvents(store, settings, runCommand, Number(environment.PIRX_TICK_TIMER_MINUTES ?? 60));
  let code = 0;
  if (collected.events.length === 0) { collected.commit(); process.stdout.write("No events.\n"); }
  else {
    const result = await runTick({ trigger: collected.events.map((event) => `- ${event}`).join("\n"), dryRun: settings.dryRun, storage });
    if (result.skipped === true) process.stdout.write("A tick is already running.\n");
    else {
      settleEvents(store, collected, result.succeeded);
      process.stdout.write(`${result.tick} (${Math.round(result.durationMs / 1000)} s, ${result.toolCalls} tool calls, ${result.succeeded ? "decided" : "FAILED"})\n${result.answer}\n`);
      code = result.succeeded ? 0 : 1;
    }
  }
  store.close();
  process.exit(code);
}
