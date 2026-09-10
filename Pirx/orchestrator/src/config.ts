export interface GitHubConfig {
  readonly token: string;
  readonly owner: string;
  readonly repository: string;
  readonly projectOwner: string;
  readonly projectNumber: number;
  readonly apiUrl: string;
  readonly timeoutMs: number;
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

export function loadGitHubConfig(env: NodeJS.ProcessEnv = process.env): GitHubConfig {
  const timeoutText = env.PIRX_GITHUB_TIMEOUT_MS?.trim() || "10000";
  return {
    token: required(env, "PIRX_GITHUB_TOKEN"),
    owner: required(env, "PIRX_GITHUB_OWNER"),
    repository: required(env, "PIRX_GITHUB_REPOSITORY"),
    projectOwner: required(env, "PIRX_GITHUB_PROJECT_OWNER"),
    projectNumber: positiveInteger(
      required(env, "PIRX_GITHUB_PROJECT_NUMBER"),
      "PIRX_GITHUB_PROJECT_NUMBER",
    ),
    apiUrl: apiUrl(env.PIRX_GITHUB_API_URL),
    timeoutMs: positiveInteger(timeoutText, "PIRX_GITHUB_TIMEOUT_MS"),
  };
}
