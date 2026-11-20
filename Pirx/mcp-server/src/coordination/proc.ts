import { readFileSync } from "node:fs";

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
