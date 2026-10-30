import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { PRODUCTION_RUNTIME_LIMITS, type ProductionRepositoryConfig } from "./production-runtime.js";
import { HEADLESS_SERVICE_LIMITS } from "./headless-service.js";
import { CODE_WORKER_CAPABILITIES } from "../claude/worker-profile.js";
import type { ReleaseMergeMethod } from "./release-merge.js";

export const HEADLESS_CONFIG_SCHEMA_VERSION = 1 as const;

export interface HeadlessRepositoryConfig extends ProductionRepositoryConfig {
  readonly remoteName: string;
  readonly testCommands: readonly string[];
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
}

export class HeadlessConfigurationError extends Error {
  public readonly code: "missing_configuration" | "invalid_configuration" | "sensitive_configuration" | "read_failure";
  public constructor(code: HeadlessConfigurationError["code"], message: string) { super(message.slice(0, 256)); this.name = "HeadlessConfigurationError"; this.code = code; }
}

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "databasePath", "workerId", "provider", "workerCapabilities", "repositories", "worktreeParent", "leaseDurationMs", "shutdownTimeoutMs", "workerTimeoutMs", "workerOutputBytes", "workerErrorBytes", "maximumConsecutiveResumeFailures", "cycleIntervalMs", "errorIntervalMs", "githubProjectOwner", "githubProjectNumber", "githubApiUrl", "githubTimeoutMs"]);
const REPOSITORY_KEYS = new Set(["repository", "repositoryRoot", "baseBranch", "baseRevision", "remoteName", "testCommands", "delivery"]);
const DELIVERY_KEYS = new Set(["releaseBranch", "featureWorkflowName", "releaseRequiredChecks", "featureRequiredApprovals", "releaseRequiredApprovals", "featureMergeMethod", "releaseMergeMethod", "requireMergeable"]);
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
function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean { return Object.keys(value).every((key) => allowed.has(key)); }
function containsSensitive(value: unknown, key = "root"): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  if (typeof value === "string") return SENSITIVE_VALUE.test(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitive(item));
  if (record(value)) return Object.entries(value).some(([childKey, child]) => containsSensitive(child, childKey));
  return false;
}
function invalid(): never { throw new HeadlessConfigurationError("invalid_configuration", "Headless orchestrator configuration is invalid."); }

export function parseHeadlessOrchestratorConfig(value: unknown): HeadlessOrchestratorConfig {
  if (containsSensitive(value)) throw new HeadlessConfigurationError("sensitive_configuration", "Headless orchestrator configuration must not contain credentials or secret-shaped values.");
  if (!record(value) || !exactKeys(value, TOP_LEVEL_KEYS) || value.schemaVersion !== HEADLESS_CONFIG_SCHEMA_VERSION) return invalid();
  if (!text(value.databasePath) || !isAbsolute(value.databasePath) || !text(value.workerId, PRODUCTION_RUNTIME_LIMITS.workerId) || value.provider !== "claude-code") return invalid();
  if (!Array.isArray(value.workerCapabilities) || value.workerCapabilities.length === 0 || value.workerCapabilities.length > CODE_WORKER_CAPABILITIES.length || value.workerCapabilities.some((item) => !text(item, 256) || !CODE_CAPABILITIES.has(item))) return invalid();
  if (!Array.isArray(value.repositories) || value.repositories.length === 0 || value.repositories.length > 32) return invalid();
  const repositories: HeadlessRepositoryConfig[] = [];
  for (const item of value.repositories) {
    if (!record(item) || !exactKeys(item, REPOSITORY_KEYS) || !text(item.repository, 512) || !REPOSITORY.test(item.repository) || !text(item.repositoryRoot) || !isAbsolute(item.repositoryRoot) || UNSAFE_PATH.test(item.repositoryRoot) || !text(item.baseBranch, 512) || !BRANCH.test(item.baseBranch) || item.baseBranch.includes("..") || !text(item.baseRevision, 64) || !REVISION.test(item.baseRevision) || !text(item.remoteName, 128) || !REMOTE.test(item.remoteName) || !Array.isArray(item.testCommands) || item.testCommands.length > 16 || item.testCommands.some((command) => !text(command, 256) || !TEST_COMMAND.test(command)) || !record(item.delivery) || !exactKeys(item.delivery, DELIVERY_KEYS)) return invalid();
    const delivery = item.delivery;
    if (!text(delivery.releaseBranch, 512) || !BRANCH.test(delivery.releaseBranch) || delivery.releaseBranch.includes("..") || delivery.releaseBranch === item.baseBranch || !text(delivery.featureWorkflowName, 256) || !Array.isArray(delivery.releaseRequiredChecks) || delivery.releaseRequiredChecks.length === 0 || delivery.releaseRequiredChecks.length > 32 || delivery.releaseRequiredChecks.some((check) => !text(check, 256)) || new Set(delivery.releaseRequiredChecks).size !== delivery.releaseRequiredChecks.length || !integer(delivery.featureRequiredApprovals, 0, 100) || !integer(delivery.releaseRequiredApprovals, 0, 100) || delivery.featureMergeMethod !== "merge" || !["squash", "merge", "rebase"].includes(String(delivery.releaseMergeMethod)) || typeof delivery.requireMergeable !== "boolean") return invalid();
    repositories.push(Object.freeze({
      repository: item.repository, repositoryRoot: resolve(item.repositoryRoot), baseBranch: item.baseBranch, baseRevision: item.baseRevision, remoteName: item.remoteName,
      testCommands: Object.freeze([...item.testCommands] as string[]),
      delivery: Object.freeze({ releaseBranch: delivery.releaseBranch, featureWorkflowName: delivery.featureWorkflowName, releaseRequiredChecks: Object.freeze([...delivery.releaseRequiredChecks] as string[]), featureRequiredApprovals: delivery.featureRequiredApprovals, releaseRequiredApprovals: delivery.releaseRequiredApprovals, featureMergeMethod: "merge", releaseMergeMethod: delivery.releaseMergeMethod as ReleaseMergeMethod, requireMergeable: delivery.requireMergeable }),
    }));
  }
  if (new Set(repositories.map((item) => item.repository)).size !== repositories.length) return invalid();
  if (!text(value.worktreeParent) || !isAbsolute(value.worktreeParent) || UNSAFE_PATH.test(value.worktreeParent)) return invalid();
  if (value.workerCapabilities.includes("tests.run") && repositories.some((item) => item.testCommands.length === 0)) return invalid();
  if (!text(value.githubProjectOwner, 100) || !/^[A-Za-z0-9_.-]+$/u.test(value.githubProjectOwner) || !integer(value.githubProjectNumber, 1, 1_000_000) || !text(value.githubApiUrl) || !integer(value.githubTimeoutMs, 1, 120_000)) return invalid();
  let githubApiUrl: string;
  try { const parsed = new URL(value.githubApiUrl); if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return invalid(); githubApiUrl = parsed.toString().replace(/\/+$/u, ""); } catch { return invalid(); }
  if (!integer(value.leaseDurationMs, 1, PRODUCTION_RUNTIME_LIMITS.leaseDurationMs) || !integer(value.shutdownTimeoutMs, 1, PRODUCTION_RUNTIME_LIMITS.shutdownTimeoutMs) || !integer(value.workerTimeoutMs, 1, PRODUCTION_RUNTIME_LIMITS.workerTimeoutMs) || !integer(value.workerOutputBytes, 1, PRODUCTION_RUNTIME_LIMITS.workerOutputBytes) || !integer(value.workerErrorBytes, 1, PRODUCTION_RUNTIME_LIMITS.workerOutputBytes) || !integer(value.maximumConsecutiveResumeFailures, 1, 20) || !integer(value.cycleIntervalMs, 30_000, HEADLESS_SERVICE_LIMITS.maximumIntervalMs) || !integer(value.errorIntervalMs, 30_000, HEADLESS_SERVICE_LIMITS.maximumIntervalMs)) return invalid();
  return Object.freeze({
    schemaVersion: HEADLESS_CONFIG_SCHEMA_VERSION,
    databasePath: resolve(value.databasePath), workerId: value.workerId.trim(), provider: value.provider.trim(),
    workerCapabilities: Object.freeze([...new Set(value.workerCapabilities.map((item) => (item as string).trim()))].sort()),
    repositories: Object.freeze(repositories), worktreeParent: resolve(value.worktreeParent), leaseDurationMs: value.leaseDurationMs,
    shutdownTimeoutMs: value.shutdownTimeoutMs, workerTimeoutMs: value.workerTimeoutMs, workerOutputBytes: value.workerOutputBytes,
    workerErrorBytes: value.workerErrorBytes, maximumConsecutiveResumeFailures: value.maximumConsecutiveResumeFailures,
    cycleIntervalMs: value.cycleIntervalMs, errorIntervalMs: value.errorIntervalMs,
    githubProjectOwner: value.githubProjectOwner, githubProjectNumber: value.githubProjectNumber, githubApiUrl, githubTimeoutMs: value.githubTimeoutMs,
  } as HeadlessOrchestratorConfig);
}

export async function loadHeadlessOrchestratorConfig(environment: NodeJS.ProcessEnv = process.env): Promise<HeadlessOrchestratorConfig> {
  const filename = environment.PIRX_ORCHESTRATOR_CONFIG?.trim();
  if (filename === undefined || filename.length === 0) throw new HeadlessConfigurationError("missing_configuration", "PIRX_ORCHESTRATOR_CONFIG must point to a configuration file.");
  if (!isAbsolute(filename)) throw new HeadlessConfigurationError("invalid_configuration", "PIRX_ORCHESTRATOR_CONFIG must be an absolute path.");
  let content: string;
  try { content = await readFile(filename, "utf8"); } catch { throw new HeadlessConfigurationError("read_failure", "Headless orchestrator configuration could not be read."); }
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new HeadlessConfigurationError("invalid_configuration", "Headless orchestrator configuration is not valid JSON."); }
  return parseHeadlessOrchestratorConfig(parsed);
}
