import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** One repository Pirx may coordinate. Read from the existing orchestrator config so nothing is configured twice. */
export interface CoordinatedRepository {
  readonly repository: string;
  readonly repositoryRoot: string;
  readonly baseBranch: string;
  readonly remoteName: string;
  /** Branch a change must reach before its Issue may be closed (the repository's own CD target). */
  readonly targetBranch: string;
  readonly testCommands: readonly string[];
  readonly setupCommands: readonly string[];
}

export interface CoordinationSettings {
  readonly repositories: readonly CoordinatedRepository[];
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly worktreeParent: string;
  readonly workerLogDir: string;
  readonly stopFile: string;
  readonly dryRun: boolean;
  readonly evalFixture?: string;
  readonly tick?: string;
  readonly claudeExecutable: string;
  readonly workerModel?: string;
  readonly opusModel: string;
  readonly caps: {
    readonly workerStartsPerTaskPerDay: number;
    readonly ciRerunsPerRun: number;
    readonly askOpusPerTaskPerDay: number;
    readonly workerTimeoutMs: number;
  };
  readonly configurationError?: string;
}

function dataHome(environment: NodeJS.ProcessEnv): string {
  return environment.XDG_DATA_HOME?.trim() || join(environment.HOME ?? homedir(), ".local", "share");
}
function configHome(environment: NodeJS.ProcessEnv): string {
  return environment.XDG_CONFIG_HOME?.trim() || join(environment.HOME ?? homedir(), ".config");
}
function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Pirx's own settings file, ~/.config/pirx/coordination.json (ai-assistant#371). Values here win over
 * the environment; repositories and the Project still come from orchestrator.json until T10.
 *   { "workerModel": "claude-opus-5-5", "opusModel": "claude-opus-5-5",
 *     "caps": { "workerStartsPerTaskPerDay": 3, "ciRerunsPerRun": 2, "askOpusPerTaskPerDay": 3 } }
 */
function readCoordinationFile(environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const path = environment.PIRX_COORDINATION_CONFIG?.trim() || join(configHome(environment), "pirx", "coordination.json");
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return {}; }
  try { return JSON.parse(text) as Record<string, unknown>; } catch (error) { return { error: `${path} is not valid JSON (${(error as Error).message}); its values are ignored.` }; }
}

export function loadCoordinationSettings(environment: NodeJS.ProcessEnv): CoordinationSettings {
  const own = readCoordinationFile(environment);
  const ownCaps = (own.caps ?? {}) as Record<string, unknown>;
  const fromFile = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const capFrom = (value: unknown): string | undefined => (typeof value === "number" ? String(value) : undefined);
  const configPath = environment.PIRX_ORCHESTRATOR_CONFIG?.trim() || join(configHome(environment), "pirx", "orchestrator.json");
  let raw: Record<string, unknown> = {};
  let configurationError: string | undefined;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (error: unknown) {
    configurationError = `Cannot read ${configPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const repositories: CoordinatedRepository[] = [];
  for (const item of Array.isArray(raw.repositories) ? raw.repositories as Record<string, unknown>[] : []) {
    if (typeof item.repository !== "string" || typeof item.repositoryRoot !== "string") continue;
    const delivery = item.delivery as { postMerge?: { mustReach?: unknown } } | undefined;
    const mustReach = Array.isArray(delivery?.postMerge?.mustReach) ? delivery!.postMerge!.mustReach as unknown[] : [];
    const baseBranch = typeof item.baseBranch === "string" ? item.baseBranch : "main";
    repositories.push({
      repository: item.repository,
      repositoryRoot: resolve(item.repositoryRoot),
      baseBranch,
      remoteName: typeof item.remoteName === "string" ? item.remoteName : "origin",
      targetBranch: typeof mustReach[0] === "string" ? mustReach[0] : baseBranch,
      testCommands: Array.isArray(item.testCommands) ? (item.testCommands as unknown[]).filter((v): v is string => typeof v === "string") : [],
      setupCommands: Array.isArray(item.setupCommands) ? (item.setupCommands as unknown[]).filter((v): v is string => typeof v === "string") : [],
    });
  }
  const projectNumber = Number(environment.PIRX_GITHUB_PROJECT_NUMBER ?? raw.githubProjectNumber);
  const projectOwner = (environment.PIRX_GITHUB_PROJECT_OWNER ?? raw.githubProjectOwner) as string | undefined;
  return {
    repositories,
    ...(typeof projectOwner === "string" && projectOwner.length > 0 ? { projectOwner } : {}),
    ...(Number.isSafeInteger(projectNumber) && projectNumber > 0 ? { projectNumber } : {}),
    worktreeParent: environment.PIRX_WORKTREE_PARENT?.trim() || join(dataHome(environment), "pirx", "coordination", "worktrees"),
    workerLogDir: environment.PIRX_WORKER_LOG_DIR?.trim() || join(dataHome(environment), "pirx", "coordination", "worker-logs"),
    stopFile: environment.PIRX_STOP_FILE?.trim() || join(configHome(environment), "pirx", "STOP"),
    dryRun: environment.PIRX_COORDINATION_DRY_RUN === "1" || environment.PIRX_COORDINATION_DRY_RUN === "true",
    ...(environment.PIRX_COORDINATION_EVAL?.trim() ? { evalFixture: environment.PIRX_COORDINATION_EVAL.trim() } : {}),
    ...(environment.PIRX_TICK_ID?.trim() ? { tick: environment.PIRX_TICK_ID.trim() } : {}),
    claudeExecutable: environment.PIRX_CLAUDE_EXECUTABLE?.trim() || "claude",
    ...((fromFile(own.workerModel) ?? environment.PIRX_WORKER_MODEL?.trim()) ? { workerModel: fromFile(own.workerModel) ?? environment.PIRX_WORKER_MODEL!.trim() } : {}),
    opusModel: fromFile(own.opusModel) ?? (environment.PIRX_OPUS_MODEL?.trim() || "claude-opus-5-5"),
    caps: {
      workerStartsPerTaskPerDay: positive(capFrom(ownCaps.workerStartsPerTaskPerDay) ?? environment.PIRX_CAP_WORKER_STARTS, 3),
      ciRerunsPerRun: positive(capFrom(ownCaps.ciRerunsPerRun) ?? environment.PIRX_CAP_CI_RERUNS, 2),
      askOpusPerTaskPerDay: positive(capFrom(ownCaps.askOpusPerTaskPerDay) ?? environment.PIRX_CAP_ASK_OPUS, 3),
      workerTimeoutMs: positive(environment.PIRX_WORKER_TIMEOUT_MS, 3 * 60 * 60 * 1000),
    },
    ...(configurationError === undefined && typeof own.error !== "string" ? {} : { configurationError: [configurationError, own.error].filter((part) => typeof part === "string").join(" ") }),
  };
}

export function findRepository(settings: CoordinationSettings, repository: string): CoordinatedRepository | undefined {
  return settings.repositories.find((item) => item.repository.toLowerCase() === repository.toLowerCase());
}

export function stopped(settings: CoordinationSettings): boolean {
  return existsSync(settings.stopFile);
}

/** Start of the current UTC day, for the per-day caps. */
/**
 * Start of the operator's day (midnight in `timeZone`) as a UTC ISO string, for the per-day caps.
 * UTC midnight is 01:00 or 02:00 in Poland, so caps used to reset in the middle of the night.
 */
export function startOfDay(now: string, timeZone = process.env.PIRX_GOOGLE_CALENDAR_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): string {
  try { new Intl.DateTimeFormat("en-US", { timeZone }); } catch { timeZone = "UTC"; }
  if (timeZone === "") timeZone = "UTC";
  const instant = new Date(now);
  const localDate = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
  const offsetAt = (when: Date): number => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(when).map((part) => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - when.getTime();
  };
  const guess = Date.parse(`${localDate}T00:00:00.000Z`);
  return new Date(guess - offsetAt(new Date(guess - offsetAt(new Date(guess))))).toISOString();
}
