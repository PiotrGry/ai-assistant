import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { PRODUCTION_RUNTIME_LIMITS, type ProductionRepositoryConfig } from "./production-runtime.js";
import { HEADLESS_SERVICE_LIMITS } from "./headless-service.js";
import { CLAUDE_CODE_WORKER_PROFILE_LIMITS, CLAUDE_MODEL_PATTERN, CODE_WORKER_CAPABILITIES } from "../claude/worker-profile.js";
import type { ReleaseMergeMethod } from "./release-merge.js";
import type { PostMergeCheck, PostMergePolicy } from "./post-merge-watch.js";

export const HEADLESS_CONFIG_SCHEMA_VERSION = 1 as const;

export interface HeadlessRepositoryConfig extends ProductionRepositoryConfig {
  readonly remoteName: string;
  readonly testCommands: readonly string[];
  /** Claude turn bound per Attempt; the worker profile default applies when absent. */
  readonly maxTurns?: number;
  /** Total time per Attempt; the worker profile default applies when absent. */
  readonly attemptTimeLimitMs?: number;
  /** Claude model for the worker; the account's Claude Code default applies when absent. */
  readonly model?: string;
  readonly delivery: HeadlessDeliveryPolicyConfig;
}

export interface HeadlessDeliveryPolicyConfig {
  readonly releaseBranch: string;
  readonly featureWorkflowName: string;
  readonly releaseRequiredChecks: readonly string[];
  readonly featureRequiredApprovals: number;
  readonly releaseRequiredApprovals: number;
  readonly featureMergeMethod: "merge";
  readonly releaseMergeMethod: ReleaseMergeMethod;
  readonly requireMergeable: boolean;
  /** Set for a repository that releases on its own: the Task ends at the base merge once this pipeline passed. */
  readonly postMerge?: PostMergePolicy;
}

export interface HeadlessOrchestratorConfig {
  readonly schemaVersion: typeof HEADLESS_CONFIG_SCHEMA_VERSION;
  readonly databasePath: string;
  readonly workerId: string;
  readonly provider: string;
  readonly workerCapabilities: readonly string[];
  readonly repositories: readonly HeadlessRepositoryConfig[];
  readonly worktreeParent: string;
  readonly leaseDurationMs: number;
  readonly shutdownTimeoutMs: number;
  readonly workerTimeoutMs: number;
  readonly workerOutputBytes: number;
  readonly workerErrorBytes: number;
  readonly maximumConsecutiveResumeFailures: number;
  readonly cycleIntervalMs: number;
  readonly errorIntervalMs: number;
  readonly githubProjectOwner: string;
  readonly githubProjectNumber: number;
  readonly githubApiUrl: string;
  readonly githubTimeoutMs: number;
  readonly hostPowerOff?: { readonly enabled: true; readonly method: "linux-systemctl"; readonly acceptanceTimeoutMs: number };
}

export class HeadlessConfigurationError extends Error {
  public readonly code: "missing_configuration" | "invalid_configuration" | "sensitive_configuration" | "read_failure";
  public constructor(code: HeadlessConfigurationError["code"], message: string) { super(message.slice(0, 512)); this.name = "HeadlessConfigurationError"; this.code = code; }
}

export interface HeadlessOrchestratorConfigSelection {
  readonly filename: string;
  readonly source: "explicit_profile" | "default_profile";
}

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "databasePath", "workerId", "provider", "workerCapabilities", "repositories", "worktreeParent", "leaseDurationMs", "shutdownTimeoutMs", "workerTimeoutMs", "workerOutputBytes", "workerErrorBytes", "maximumConsecutiveResumeFailures", "cycleIntervalMs", "errorIntervalMs", "githubProjectOwner", "githubProjectNumber", "githubApiUrl", "githubTimeoutMs", "hostPowerOff"]);
const REPOSITORY_KEYS = new Set(["repository", "repositoryRoot", "baseBranch", "baseRevision", "remoteName", "testCommands", "maxTurns", "attemptTimeLimitMs", "model", "delivery"]);
const DELIVERY_KEYS = new Set(["releaseBranch", "featureWorkflowName", "releaseRequiredChecks", "featureRequiredApprovals", "releaseRequiredApprovals", "featureMergeMethod", "releaseMergeMethod", "requireMergeable", "postMerge"]);
const POST_MERGE_KEYS = new Set(["checks", "mustReach", "optionalGraceMinutes", "timeoutMinutes"]);
const POST_MERGE_CHECK_KEYS = new Set(["workflow", "branch", "optional"]);
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,250}\.ya?ml$/u;
const SENSITIVE_KEY = /^(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|private[_-]?key|credential|connection[_-]?string)$/iu;
const SENSITIVE_VALUE = /(?:-----BEGIN [^-]*PRIVATE KEY-----|\bbearer\s+[A-Za-z0-9._~+/=-]+|\b(?:ghp_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9._-]+)/iu;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/u;
const REVISION = /^[0-9a-f]{4,64}$/iu;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TEST_COMMAND = /^(?:pnpm|npm|yarn|bun|node|npx|python|python3|pytest|uv|cargo|go|make)(?: [A-Za-z0-9_./:@=+,-]+)*$/u;
const UNSAFE_PATH = /[\u0000-\u001f\u007f;&|<>`$(){}[\]\\!#*?~'"]/u;
const CODE_CAPABILITIES = new Set<string>(CODE_WORKER_CAPABILITIES);

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, maximum = 2_048): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= maximum && SAFE_TEXT.test(value); }
function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum; }
function containsSensitive(value: unknown, key = "root"): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  if (typeof value === "string") return SENSITIVE_VALUE.test(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitive(item));
  if (record(value)) return Object.entries(value).some(([childKey, child]) => containsSensitive(child, childKey));
  return false;
}
/** Rejects the profile and names the first field that is wrong. Never echoes a value: only field names and the rule. */
function invalid(field: string, rule: string): never { throw new HeadlessConfigurationError("invalid_configuration", `Headless orchestrator configuration is invalid: ${field} ${rule}.`); }
function need(condition: boolean, field: string, rule: string): asserts condition { if (!condition) invalid(field, rule); }
function unknownKey(value: Record<string, unknown>, allowed: ReadonlySet<string>): string | undefined {
  const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
  return key === undefined ? undefined : /^[A-Za-z0-9_.-]{1,64}$/u.test(key) ? `"${key}"` : "an unnamed key";
}
function needKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  const key = unknownKey(value, allowed);
  if (key !== undefined) invalid(where, `has the unknown key ${key}`);
}
function sensitivePath(value: unknown, path = "the profile", key = "root"): string | undefined {
  if (SENSITIVE_KEY.test(key)) return path;
  if (typeof value === "string") return SENSITIVE_VALUE.test(value) ? path : undefined;
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) { const found = sensitivePath(item, `${path}[${index}]`); if (found !== undefined) return found; } return undefined; }
  if (record(value)) { for (const [childKey, child] of Object.entries(value)) { const found = sensitivePath(child, /^[A-Za-z0-9_.-]{1,64}$/u.test(childKey) ? (path === "the profile" ? childKey : `${path}.${childKey}`) : `${path}.<key>`, childKey); if (found !== undefined) return found; } }
  return undefined;
}
const between = (minimum: number, maximum: number): string => `must be a whole number from ${minimum} to ${maximum}`;

export function parseHeadlessOrchestratorConfig(value: unknown): HeadlessOrchestratorConfig {
  if (containsSensitive(value)) throw new HeadlessConfigurationError("sensitive_configuration", `Headless orchestrator configuration must not contain credentials or secret-shaped values: remove ${sensitivePath(value) ?? "the secret"}.`);
  need(record(value), "the profile", "must be a JSON object");
  needKnownKeys(value, TOP_LEVEL_KEYS, "the profile");
  need(value.schemaVersion === HEADLESS_CONFIG_SCHEMA_VERSION, "schemaVersion", `must be ${HEADLESS_CONFIG_SCHEMA_VERSION}`);
  need(text(value.databasePath) && isAbsolute(value.databasePath), "databasePath", "must be an absolute path");
  need(text(value.workerId, PRODUCTION_RUNTIME_LIMITS.workerId), "workerId", `must be text of at most ${PRODUCTION_RUNTIME_LIMITS.workerId} characters`);
  need(value.provider === "claude-code", "provider", 'must be "claude-code"');
  const capabilities = value.workerCapabilities;
  need(Array.isArray(capabilities) && capabilities.length > 0 && capabilities.length <= CODE_WORKER_CAPABILITIES.length && capabilities.every((item) => text(item, 256) && CODE_CAPABILITIES.has(item)), "workerCapabilities", `must be a non-empty list drawn from: ${CODE_WORKER_CAPABILITIES.join(", ")}`);
  need(Array.isArray(value.repositories) && value.repositories.length > 0 && value.repositories.length <= 32, "repositories", "must list 1 to 32 repositories");
  const repositories: HeadlessRepositoryConfig[] = [];
  for (const [index, item] of value.repositories.entries()) {
    const at = `repositories[${index}]`;
    need(record(item), at, "must be a JSON object");
    needKnownKeys(item, REPOSITORY_KEYS, at);
    need(text(item.repository, 512) && REPOSITORY.test(item.repository), `${at}.repository`, 'must look like "owner/name"');
    need(text(item.repositoryRoot) && isAbsolute(item.repositoryRoot) && !UNSAFE_PATH.test(item.repositoryRoot), `${at}.repositoryRoot`, "must be an absolute path without shell or glob characters");
    need(text(item.baseBranch, 512) && BRANCH.test(item.baseBranch) && !item.baseBranch.includes(".."), `${at}.baseBranch`, "must be a branch name");
    need(text(item.baseRevision, 64) && REVISION.test(item.baseRevision), `${at}.baseRevision`, "must be a commit hash of 4 to 64 hexadecimal characters");
    need(text(item.remoteName, 128) && REMOTE.test(item.remoteName), `${at}.remoteName`, 'must be a git remote name such as "origin"');
    need(Array.isArray(item.testCommands) && item.testCommands.length <= 16, `${at}.testCommands`, "must be a list of at most 16 commands");
    for (const [commandIndex, command] of item.testCommands.entries()) need(text(command, 256) && TEST_COMMAND.test(command), `${at}.testCommands[${commandIndex}]`, "must start with pnpm, npm, yarn, bun, node, npx, python, python3, pytest, uv, cargo, go or make and use plain arguments without quotes or shell operators");
    need(item.maxTurns === undefined || integer(item.maxTurns, 2, CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxTurns), `${at}.maxTurns`, between(2, CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxTurns));
    need(item.attemptTimeLimitMs === undefined || integer(item.attemptTimeLimitMs, CLAUDE_CODE_WORKER_PROFILE_LIMITS.minimumAttemptTimeLimitMs, CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxAttemptTimeLimitMs), `${at}.attemptTimeLimitMs`, between(CLAUDE_CODE_WORKER_PROFILE_LIMITS.minimumAttemptTimeLimitMs, CLAUDE_CODE_WORKER_PROFILE_LIMITS.maxAttemptTimeLimitMs));
    need(item.model === undefined || (typeof item.model === "string" && CLAUDE_MODEL_PATTERN.test(item.model)), `${at}.model`, 'must be a Claude model ID such as "claude-opus-5-5"');
    const delivery = item.delivery;
    need(record(delivery), `${at}.delivery`, "must be a JSON object");
    needKnownKeys(delivery, DELIVERY_KEYS, `${at}.delivery`);
    need(text(delivery.releaseBranch, 512) && BRANCH.test(delivery.releaseBranch) && !delivery.releaseBranch.includes(".."), `${at}.delivery.releaseBranch`, "must be a branch name");
    need(delivery.releaseBranch !== item.baseBranch, `${at}.delivery.releaseBranch`, "must differ from baseBranch");
    need(text(delivery.featureWorkflowName, 256), `${at}.delivery.featureWorkflowName`, "must be the name of the CI workflow");
    const checks = delivery.releaseRequiredChecks;
    need(Array.isArray(checks) && checks.length > 0 && checks.length <= 32 && checks.every((check) => text(check, 256)) && new Set(checks).size === checks.length, `${at}.delivery.releaseRequiredChecks`, "must list 1 to 32 distinct check names");
    need(integer(delivery.featureRequiredApprovals, 0, 100), `${at}.delivery.featureRequiredApprovals`, between(0, 100));
    need(integer(delivery.releaseRequiredApprovals, 0, 100), `${at}.delivery.releaseRequiredApprovals`, between(0, 100));
    need(delivery.featureMergeMethod === "merge", `${at}.delivery.featureMergeMethod`, 'must be "merge"');
    need(["squash", "merge", "rebase"].includes(String(delivery.releaseMergeMethod)), `${at}.delivery.releaseMergeMethod`, 'must be "squash", "merge" or "rebase"');
    need(typeof delivery.requireMergeable === "boolean", `${at}.delivery.requireMergeable`, "must be true or false");
    let postMerge: PostMergePolicy | undefined;
    if (delivery.postMerge !== undefined) {
      const value = delivery.postMerge; const where = `${at}.delivery.postMerge`;
      need(record(value), where, "must be a JSON object");
      if (record(value)) {
        needKnownKeys(value, POST_MERGE_KEYS, where);
        const branch = (name: unknown): name is string => text(name, 512) && BRANCH.test(name) && !name.includes("..");
        const checkList = Array.isArray(value.checks) ? value.checks : [];
        need(Array.isArray(value.checks) && checkList.length > 0 && checkList.length <= 16, `${where}.checks`, "must list 1 to 16 workflow checks");
        const parsed: PostMergeCheck[] = [];
        checkList.forEach((check, index) => {
          need(record(check), `${where}.checks[${index}]`, "must be a JSON object");
          if (!record(check)) return;
          needKnownKeys(check, POST_MERGE_CHECK_KEYS, `${where}.checks[${index}]`);
          need(typeof check.workflow === "string" && WORKFLOW_FILE.test(check.workflow), `${where}.checks[${index}].workflow`, "must be a workflow file name such as release-validation.yml");
          need(branch(check.branch), `${where}.checks[${index}].branch`, "must be a branch name");
          need(check.optional === undefined || typeof check.optional === "boolean", `${where}.checks[${index}].optional`, "must be true or false");
          parsed.push(Object.freeze({ workflow: check.workflow as string, branch: check.branch as string, ...(check.optional === true ? { optional: true } : {}) }));
        });
        const reach = value.mustReach ?? [];
        need(Array.isArray(reach) && reach.length <= 8 && reach.every(branch), `${where}.mustReach`, "must list up to 8 branch names");
        need(value.optionalGraceMinutes === undefined || integer(value.optionalGraceMinutes, 1, 240), `${where}.optionalGraceMinutes`, between(1, 240));
        need(value.timeoutMinutes === undefined || integer(value.timeoutMinutes, 10, 1_440), `${where}.timeoutMinutes`, between(10, 1_440));
        postMerge = Object.freeze({ checks: Object.freeze(parsed), mustReach: Object.freeze([...(Array.isArray(reach) ? reach : [])] as string[]), optionalGraceMinutes: (value.optionalGraceMinutes as number | undefined) ?? 15, timeoutMinutes: (value.timeoutMinutes as number | undefined) ?? 180 });
      }
    }
    repositories.push(Object.freeze({
      repository: item.repository, repositoryRoot: resolve(item.repositoryRoot), baseBranch: item.baseBranch, baseRevision: item.baseRevision, remoteName: item.remoteName,
      testCommands: Object.freeze([...item.testCommands] as string[]),
      ...(item.maxTurns === undefined ? {} : { maxTurns: item.maxTurns as number }),
      ...(item.attemptTimeLimitMs === undefined ? {} : { attemptTimeLimitMs: item.attemptTimeLimitMs as number }),
      ...(item.model === undefined ? {} : { model: item.model as string }),
      delivery: Object.freeze({ releaseBranch: delivery.releaseBranch, featureWorkflowName: delivery.featureWorkflowName, releaseRequiredChecks: Object.freeze([...checks] as string[]), featureRequiredApprovals: delivery.featureRequiredApprovals, releaseRequiredApprovals: delivery.releaseRequiredApprovals, featureMergeMethod: "merge", releaseMergeMethod: delivery.releaseMergeMethod as ReleaseMergeMethod, requireMergeable: delivery.requireMergeable, ...(postMerge === undefined ? {} : { postMerge }) }),
    }));
  }
  need(new Set(repositories.map((item) => item.repository)).size === repositories.length, "repositories", "must not list the same repository twice");
  need(text(value.worktreeParent) && isAbsolute(value.worktreeParent) && !UNSAFE_PATH.test(value.worktreeParent), "worktreeParent", "must be an absolute path without shell or glob characters");
  const withoutTests = repositories.findIndex((item) => item.testCommands.length === 0);
  need(!capabilities.includes("tests.run") || withoutTests === -1, `repositories[${withoutTests}].testCommands`, 'must name at least one command while workerCapabilities includes "tests.run"');
  need(text(value.githubProjectOwner, 100) && /^[A-Za-z0-9_.-]+$/u.test(value.githubProjectOwner), "githubProjectOwner", "must be a GitHub user or organization name");
  need(integer(value.githubProjectNumber, 1, 1_000_000), "githubProjectNumber", between(1, 1_000_000));
  need(text(value.githubApiUrl), "githubApiUrl", "must be a URL");
  need(integer(value.githubTimeoutMs, 1, 120_000), "githubTimeoutMs", between(1, 120_000));
  let githubApiUrl: string;
  try { const parsed = new URL(value.githubApiUrl); need((parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "", "githubApiUrl", "must be an http(s) URL without credentials, query or fragment"); githubApiUrl = parsed.toString().replace(/\/+$/u, ""); }
  catch (error: unknown) { if (error instanceof HeadlessConfigurationError) throw error; return invalid("githubApiUrl", "must be a URL"); }
  need(integer(value.leaseDurationMs, 1, PRODUCTION_RUNTIME_LIMITS.leaseDurationMs), "leaseDurationMs", between(1, PRODUCTION_RUNTIME_LIMITS.leaseDurationMs));
  need(integer(value.shutdownTimeoutMs, 1, PRODUCTION_RUNTIME_LIMITS.shutdownTimeoutMs), "shutdownTimeoutMs", between(1, PRODUCTION_RUNTIME_LIMITS.shutdownTimeoutMs));
  need(integer(value.workerTimeoutMs, 1, PRODUCTION_RUNTIME_LIMITS.workerTimeoutMs), "workerTimeoutMs", between(1, PRODUCTION_RUNTIME_LIMITS.workerTimeoutMs));
  need(integer(value.workerOutputBytes, 1, PRODUCTION_RUNTIME_LIMITS.workerOutputBytes), "workerOutputBytes", between(1, PRODUCTION_RUNTIME_LIMITS.workerOutputBytes));
  need(integer(value.workerErrorBytes, 1, PRODUCTION_RUNTIME_LIMITS.workerOutputBytes), "workerErrorBytes", between(1, PRODUCTION_RUNTIME_LIMITS.workerOutputBytes));
  need(integer(value.maximumConsecutiveResumeFailures, 1, 20), "maximumConsecutiveResumeFailures", between(1, 20));
  need(integer(value.cycleIntervalMs, 30_000, HEADLESS_SERVICE_LIMITS.maximumIntervalMs), "cycleIntervalMs", between(30_000, HEADLESS_SERVICE_LIMITS.maximumIntervalMs));
  need(integer(value.errorIntervalMs, 30_000, HEADLESS_SERVICE_LIMITS.maximumIntervalMs), "errorIntervalMs", between(30_000, HEADLESS_SERVICE_LIMITS.maximumIntervalMs));
  let hostPowerOff: HeadlessOrchestratorConfig["hostPowerOff"];
  if (value.hostPowerOff !== undefined) {
    const power = value.hostPowerOff;
    need(record(power), "hostPowerOff", "must be a JSON object");
    needKnownKeys(power, new Set(["enabled", "method", "acceptanceTimeoutMs"]), "hostPowerOff");
    need(power.enabled === true, "hostPowerOff.enabled", "must be true; remove hostPowerOff to disable it");
    need(power.method === "linux-systemctl", "hostPowerOff.method", 'must be "linux-systemctl"');
    need(integer(power.acceptanceTimeoutMs, 100, 30_000), "hostPowerOff.acceptanceTimeoutMs", between(100, 30_000));
    hostPowerOff = Object.freeze({ enabled: true, method: "linux-systemctl", acceptanceTimeoutMs: power.acceptanceTimeoutMs });
  }
  return Object.freeze({
    schemaVersion: HEADLESS_CONFIG_SCHEMA_VERSION,
    databasePath: resolve(value.databasePath), workerId: value.workerId.trim(), provider: value.provider.trim(),
    workerCapabilities: Object.freeze([...new Set(capabilities.map((item) => (item as string).trim()))].sort()),
    repositories: Object.freeze(repositories), worktreeParent: resolve(value.worktreeParent), leaseDurationMs: value.leaseDurationMs,
    shutdownTimeoutMs: value.shutdownTimeoutMs, workerTimeoutMs: value.workerTimeoutMs, workerOutputBytes: value.workerOutputBytes,
    workerErrorBytes: value.workerErrorBytes, maximumConsecutiveResumeFailures: value.maximumConsecutiveResumeFailures,
    cycleIntervalMs: value.cycleIntervalMs, errorIntervalMs: value.errorIntervalMs,
    githubProjectOwner: value.githubProjectOwner, githubProjectNumber: value.githubProjectNumber, githubApiUrl, githubTimeoutMs: value.githubTimeoutMs,
    ...(hostPowerOff === undefined ? {} : { hostPowerOff }),
  } as HeadlessOrchestratorConfig);
}

export function resolveHeadlessOrchestratorConfigSelection(environment: NodeJS.ProcessEnv = process.env): HeadlessOrchestratorConfigSelection {
  const explicit = environment.PIRX_ORCHESTRATOR_CONFIG;
  const home = environment.HOME?.trim() || homedir();
  const filename = explicit?.trim() ?? resolve(environment.XDG_CONFIG_HOME?.trim() || resolve(home, ".config"), "pirx", "orchestrator.json");
  if (!isAbsolute(filename)) throw new HeadlessConfigurationError("invalid_configuration", "PIRX_ORCHESTRATOR_CONFIG must be an absolute path.");
  return Object.freeze({ filename: resolve(filename), source: explicit === undefined ? "default_profile" : "explicit_profile" });
}

export function readHeadlessOrchestratorConfig(environment: NodeJS.ProcessEnv = process.env): HeadlessOrchestratorConfig | undefined {
  const selection = resolveHeadlessOrchestratorConfigSelection(environment);
  let content: string;
  try { content = readFileSync(selection.filename, "utf8"); }
  catch (error: unknown) {
    if (selection.source === "default_profile" && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    const code = (error as NodeJS.ErrnoException).code;
    throw new HeadlessConfigurationError("read_failure", `Headless orchestrator configuration could not be read${typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? ` (${code})` : ""}: ${selection.filename}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new HeadlessConfigurationError("invalid_configuration", `Headless orchestrator configuration is not valid JSON: ${selection.filename}`); }
  return parseHeadlessOrchestratorConfig(parsed);
}

export async function loadHeadlessOrchestratorConfig(environment: NodeJS.ProcessEnv = process.env): Promise<HeadlessOrchestratorConfig> {
  const config = readHeadlessOrchestratorConfig(environment);
  if (config === undefined) throw new HeadlessConfigurationError("missing_configuration", `No orchestrator profile at ${resolveHeadlessOrchestratorConfigSelection(environment).filename}. Create it or set PIRX_ORCHESTRATOR_CONFIG.`);
  return config;
}
