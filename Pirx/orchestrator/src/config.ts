import { execFileSync } from "node:child_process";

export interface GitHubConfig {
  readonly token: string;
  readonly owner: string;
  readonly repository: string;
  readonly projectOwner?: string;
  readonly projectNumber?: number;
  readonly apiUrl: string;
  readonly timeoutMs: number;
}

export interface GitHubConfigOptions {
  /** Injectable only for deterministic tests; production uses `gh auth token`. */
  readonly tokenProvider?: (hostname: string) => string;
}

export class GitHubConfigurationError extends Error {
  readonly code = "configuration" as const;

  constructor(message: string) {
    super(message);
    this.name = "GitHubConfigurationError";
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    throw new GitHubConfigurationError(`Missing required GitHub configuration: ${key}.`);
  }
  return value;
}

function positiveInteger(value: string, key: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new GitHubConfigurationError(`${key} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new GitHubConfigurationError(`${key} must be a positive integer.`);
  }
  return parsed;
}

function apiUrl(value: string | undefined): string {
  const raw = value?.trim() || "https://api.github.com";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GitHubConfigurationError("PIRX_GITHUB_API_URL must be a valid URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new GitHubConfigurationError(
      "PIRX_GITHUB_API_URL must use http or https.",
    );
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new GitHubConfigurationError(
      "PIRX_GITHUB_API_URL must not contain credentials, query parameters, or a fragment.",
    );
  }
  return parsed.toString().replace(/\/+$/u, "");
}

function githubHostname(apiEndpoint: string): string {
  const hostname = new URL(apiEndpoint).hostname;
  return hostname === "api.github.com" ? "github.com" : hostname;
}

function ghAuthToken(hostname: string): string {
  try {
    const token = execFileSync("gh", ["auth", "token", "--hostname", hostname], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16_384,
    }).trim();
    if (token.length === 0 || /[\u0000-\u001f\u007f]/u.test(token)) {
      throw new Error("empty or invalid token");
    }
    return token;
  } catch {
    throw new GitHubConfigurationError(
      `GitHub CLI authentication is unavailable for ${hostname}. Run gh auth login first.`,
    );
  }
}

export function loadGitHubConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: GitHubConfigOptions = {},
): GitHubConfig {
  const timeoutText = env.PIRX_GITHUB_TIMEOUT_MS?.trim() || "10000";
  const apiEndpoint = apiUrl(env.PIRX_GITHUB_API_URL);
  const owner = required(env, "PIRX_GITHUB_OWNER");
  const repository = required(env, "PIRX_GITHUB_REPOSITORY");
  const projectOwner = env.PIRX_GITHUB_PROJECT_OWNER?.trim() || undefined;
  const projectNumberText = env.PIRX_GITHUB_PROJECT_NUMBER?.trim();
  const projectNumber =
    projectNumberText === undefined || projectNumberText.length === 0
      ? undefined
      : positiveInteger(projectNumberText, "PIRX_GITHUB_PROJECT_NUMBER");
  const hostname = githubHostname(apiEndpoint);
  return {
    token: options.tokenProvider?.(hostname) ?? ghAuthToken(hostname),
    owner,
    repository,
    ...(projectOwner === undefined ? {} : { projectOwner }),
    ...(projectNumber === undefined ? {} : { projectNumber }),
    apiUrl: apiEndpoint,
    timeoutMs: positiveInteger(timeoutText, "PIRX_GITHUB_TIMEOUT_MS"),
  };
}
