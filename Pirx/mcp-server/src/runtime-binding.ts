import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RuntimeStorageError } from "@pirx/orchestrator";

export type RuntimeBindingCheck = () => void;
type ExecuteSync = (file: string, arguments_: readonly string[], options: Record<string, unknown>) => string;

export interface ManagedRuntimeBindingOptions {
  readonly platform?: string;
  readonly executeSync?: ExecuteSync;
  readonly readFile?: (filename: string) => string;
}

function bindingError(code: string, message: string): RuntimeStorageError {
  return new RuntimeStorageError("invalid_configuration", `${code}: ${message}`);
}

function serviceEnvironmentFile(value: string): string {
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw bindingError("runtime_service_environment_unverifiable", "The managed service must use exactly one EnvironmentFile.");
  const filename = lines[0]!.replace(/\s+\(ignore_errors=(?:yes|no)\)$/u, "").trim();
  if (!isAbsolute(filename) || /[\u0000-\u001f\u007f]/u.test(filename)) throw bindingError("runtime_service_environment_unverifiable", "The managed service EnvironmentFile is invalid.");
  return filename;
}

function configuredProfile(value: string): string {
  const matches = value.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("PIRX_ORCHESTRATOR_CONFIG="));
  if (matches.length !== 1) throw bindingError("runtime_profile_unverifiable", "The managed service EnvironmentFile must define PIRX_ORCHESTRATOR_CONFIG exactly once.");
  let filename = matches[0]!.slice("PIRX_ORCHESTRATOR_CONFIG=".length).trim();
  if ((filename.startsWith('"') && filename.endsWith('"')) || (filename.startsWith("'") && filename.endsWith("'"))) filename = filename.slice(1, -1);
  if (!isAbsolute(filename) || /[\u0000-\u001f\u007f]/u.test(filename)) throw bindingError("runtime_profile_unverifiable", "The managed service PIRX_ORCHESTRATOR_CONFIG is invalid.");
  return filename;
}

export function assertServiceProfile(expectedProfile: string, environmentFile: string): void {
  let expected: ReturnType<typeof statSync>;
  let actual: ReturnType<typeof statSync>;
  try {
    expected = statSync(expectedProfile);
    actual = statSync(configuredProfile(environmentFile));
  } catch (error: unknown) {
    if (error instanceof RuntimeStorageError) throw error;
    throw bindingError("runtime_profile_unverifiable", "The managed service profile identity cannot be verified.");
  }
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw bindingError("runtime_profile_mismatch", "Chat/MCP and pirx-orchestrator.service resolve different orchestrator profiles. Align PIRX_ORCHESTRATOR_CONFIG before runtime access or service start.");
}

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

export function managedRuntimeBinding(filename: string | undefined, environment: NodeJS.ProcessEnv, profileFilename?: string, options: ManagedRuntimeBindingOptions = {}): RuntimeBindingCheck {
  return () => {
    if (environment.PIRX_ORCHESTRATOR_SERVICE_ENABLED !== "true") return;
    if ((options.platform ?? process.platform) !== "linux" || filename === undefined || profileFilename === undefined) throw bindingError("runtime_binding_unverifiable", "Managed runtime verification requires Linux, a configured SQLite database and a verified orchestrator profile.");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["HOME", "USER", "LOGNAME", "PATH", "LANG", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) if (environment[key] !== undefined) env[key] = environment[key];
    const executeSync = options.executeSync ?? ((file, arguments_, commandOptions) => String(execFileSync(file, arguments_, commandOptions)));
    let pid: number;
    try {
      const commandOptions = { env, timeout: 2_000, maxBuffer: 4_096, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
      const environmentFile = serviceEnvironmentFile(executeSync("/usr/bin/systemctl", ["--user", "show", "--property=EnvironmentFiles", "--value", "pirx-orchestrator.service"], commandOptions));
      if (statSync(environmentFile).size > 65_536) throw bindingError("runtime_profile_unverifiable", "The managed service EnvironmentFile exceeds the safe verification limit.");
      const contents = (options.readFile ?? ((path) => readFileSync(path, "utf8")))(environmentFile);
      if (contents.length > 65_536) throw bindingError("runtime_profile_unverifiable", "The managed service EnvironmentFile exceeds the safe verification limit.");
      assertServiceProfile(profileFilename, contents);
      const value = executeSync("/usr/bin/systemctl", ["--user", "show", "--property=MainPID", "--value", "pirx-orchestrator.service"], commandOptions).trim();
      if (!/^\d+$/u.test(value)) throw new Error("invalid PID");
      pid = Number(value);
    } catch (error: unknown) {
      if (error instanceof RuntimeStorageError) throw error;
      throw bindingError("runtime_service_identity_unverifiable", "Cannot verify pirx-orchestrator.service identity. Check the user service manager; no runtime action was performed.");
    }
    // A stopped service is safe only after its persistent profile identity was verified above.
    if (pid === 0) return;
    assertProcessDatabase(filename, pid);
  };
}
