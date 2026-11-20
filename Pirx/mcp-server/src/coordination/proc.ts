import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Kernel start time of a process (field 22 of /proc/<pid>/stat), or undefined when it does not exist. */
export function processStart(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return undefined; }
}

/**
 * Whether the recorded process still runs. pid 0 and negative pids are never alive (kill(0, 0) would
 * signal our own process group and succeed). With a recorded start time, a reused pid is not alive.
 */
export function pidAlive(pid: number, pidStart?: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const start = processStart(pid);
  if (start !== undefined) return pidStart === undefined || pidStart === start;
  try { process.kill(pid, 0); return pidStart === undefined; } catch { return false; }
}

/** The single-tick guard next to the database: `<pid> <start time>` of the process running a tick. */
export function tickGuardPath(storagePath: string): string {
  return join(dirname(storagePath), "pirx-tick.lock");
}

function readGuard(path: string): { pid: number; start?: string } | undefined {
  try {
    const [pid, start] = readFileSync(path, "utf8").trim().split(" ");
    return { pid: Number(pid), ...(start === undefined || start === "" ? {} : { start }) };
  } catch { return undefined; }
}

/** Whether another live process holds the guard. */
export function guardHeldByOther(path: string): boolean {
  const holder = readGuard(path);
  return holder !== undefined && holder.pid !== process.pid && pidAlive(holder.pid, holder.start);
}

/** Takes the guard for this process. A guard left by a dead or reused process is taken over. */
export function takeGuard(path: string): boolean {
  const mine = `${process.pid} ${processStart(process.pid) ?? ""}`.trim();
  try { writeFileSync(path, mine, { flag: "wx" }); return true; } catch { /* exists */ }
  if (guardHeldByOther(path)) return false;
  rmSync(path, { force: true });
  try { writeFileSync(path, mine, { flag: "wx" }); return true; } catch { return false; }
}

export function releaseGuard(path: string): void {
  const holder = readGuard(path);
  if (holder?.pid === process.pid) rmSync(path, { force: true });
}
