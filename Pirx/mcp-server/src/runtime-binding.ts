import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { RuntimeStorageError } from "@pirx/orchestrator";

export type RuntimeBindingCheck = () => void;

/** Verify the database actually held open by the managed process, not just a second valid config file. */
export function assertProcessDatabase(filename: string, pid: number, procRoot = "/proc"): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RuntimeStorageError("invalid_configuration", "Managed daemon has no verifiable process identity.");
  try {
    const expected = statSync(filename);
    for (const fd of readdirSync(`${procRoot}/${pid}/fd`)) {
      try {
        const actual = statSync(`${procRoot}/${pid}/fd/${fd}`);
        if (actual.dev === expected.dev && actual.ino === expected.ino) return;
      } catch { /* descriptors may close during inspection */ }
    }
  } catch {
    throw new RuntimeStorageError("invalid_configuration", "Cannot verify the managed daemon's runtime database. Check process access and runtime configuration.");
  }
  throw new RuntimeStorageError("invalid_configuration", "Runtime mismatch: the managed daemon does not have the configured SQLite database open. Align chat and service PIRX_ORCHESTRATOR_CONFIG, then restart the affected process.");
}

export function managedRuntimeBinding(filename: string | undefined, environment: NodeJS.ProcessEnv): RuntimeBindingCheck {
  return () => {
    if (environment.PIRX_ORCHESTRATOR_SERVICE_ENABLED !== "true") return;
    if (process.platform !== "linux" || filename === undefined) throw new RuntimeStorageError("invalid_configuration", "Managed runtime verification requires Linux and a configured SQLite database.");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (environment[key] !== undefined) env[key] = environment[key];
    let pid: number;
    try {
      const value = execFileSync("/usr/bin/systemctl", ["--user", "show", "--property=MainPID", "--value", "pirx-orchestrator.service"], { env, timeout: 2_000, maxBuffer: 1_024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (!/^\d+$/u.test(value)) throw new Error("invalid PID");
      pid = Number(value);
    } catch {
      throw new RuntimeStorageError("invalid_configuration", "Cannot verify pirx-orchestrator.service identity. Check the user service manager; no runtime action was performed.");
    }
    // A stopped service has no competing live runtime; history remains available.
    if (pid === 0) return;
    assertProcessDatabase(filename, pid);
  };
}
