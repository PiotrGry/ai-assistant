import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ProfileSettingDefinition {
  readonly owner: "chat" | "runtime" | "integration" | "observability";
  readonly sensitive: boolean;
  readonly forwardToMcp: boolean;
}

export const TOOL_PROFILES = ["personal", "development", "operations"] as const;
export type ToolProfile = typeof TOOL_PROFILES[number];
export type ToolScope = "common" | "personal" | "development" | "operations";

/** One explicit visibility matrix shared by chat entry points and MCP. */
export const TOOL_PROFILE_SCOPES: Readonly<Record<ToolProfile, ReadonlySet<ToolScope>>> = Object.freeze({
  personal: new Set<ToolScope>(["common", "personal"]),
  development: new Set<ToolScope>(["common", "development"]),
  operations: new Set<ToolScope>(["common", "development", "operations"]),
});

export function resolveToolProfile(environment: NodeJS.ProcessEnv): ToolProfile {
  const value = environment.PIRX_TOOL_PROFILE;
  if (value === undefined) return "personal";
  const profile = value.trim();
  if ((TOOL_PROFILES as readonly string[]).includes(profile)) return profile as ToolProfile;
  throw new Error(`PIRX_TOOL_PROFILE must be one of: ${TOOL_PROFILES.join(", ")}.`);
}

export function toolProfileAllows(profile: ToolProfile, scope: ToolScope): boolean {
  return TOOL_PROFILE_SCOPES[profile].has(scope);
}

const chat = { owner: "chat", sensitive: false, forwardToMcp: false } as const;
const runtime = { owner: "runtime", sensitive: false, forwardToMcp: true } as const;
const integration = { owner: "integration", sensitive: false, forwardToMcp: true } as const;
const privateIntegration = { owner: "integration", sensitive: true, forwardToMcp: true } as const;
const observability = { owner: "observability", sensitive: false, forwardToMcp: true } as const;

/** The supported chat profile contract. Values are still validated by their owning loader. */
export const PROFILE_SETTING_DEFINITIONS = Object.freeze({
  OLLAMA_MODEL: chat,
  OLLAMA_NUM_CTX: chat,
  OLLAMA_BASE_URL: chat,
  OLLAMA_MAX_OUTPUT_TOKENS: chat,
  OLLAMA_TEMPERATURE: chat,
  OLLAMA_KEEP_ALIVE: chat,
  ADA_PROMPT_FILE: { ...chat, sensitive: true },
  PIRX_CONTEXT_SAFETY_MARGIN_TOKENS: chat,
  PIRX_MAX_TOOL_CALLS: chat,
  PIRX_MAX_TOOL_ITERATIONS: chat,
  PIRX_MAX_REPEATED_TOOL_CALLS: chat,
  PIRX_MAX_TURN_DURATION_MS: chat,
  PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS: chat,
  PIRX_MAX_TOOL_RESULT_CHARACTERS: chat,
  PIRX_CONTINUATION_CHECK: chat,
  PIRX_LLM_TIMEOUT_MS: chat,
  PIRX_TOOL_TIMEOUT_MS: chat,
  // The MCP child needs the resolved chat database path to prove it is not
  // opening the orchestrator runtime database. This preserves an existing
  // safety boundary; the path is forwarded, but never logged.
  PIRX_STORAGE_FILE: { ...chat, sensitive: true, forwardToMcp: true },
  PIRX_STORAGE_MODE: chat,
  PIRX_RESOURCE_SAMPLE_INTERVAL_MS: chat,
  PIRX_TOOL_PROFILE: { ...chat, forwardToMcp: true },
  PIRX_ORCHESTRATOR_CONFIG: { ...runtime, sensitive: true },
  PIRX_ORCHESTRATOR_DATABASE: { ...runtime, sensitive: true },
  PIRX_ORCHESTRATOR_SERVICE_ENABLED: runtime,
  PIRX_GPU_DB: { ...observability, sensitive: true },
  PIRX_OBSIDIAN_VAULT: privateIntegration,
  PIRX_GOOGLE_CREDENTIALS_FILE: privateIntegration,
  PIRX_GOOGLE_TOKEN_FILE: privateIntegration,
  PIRX_GOOGLE_CALENDAR_ID: privateIntegration,
  PIRX_GOOGLE_CALENDAR_TIMEZONE: integration,
  PIRX_GOOGLE_TIMEOUT_MS: integration,
  PIRX_GOOGLE_AUTH_TIMEOUT_MS: integration,
  PIRX_GITHUB_API_URL: integration,
  PIRX_GITHUB_TIMEOUT_MS: integration,
  PIRX_GITHUB_OWNER: integration,
  PIRX_GITHUB_REPOSITORY: integration,
  PIRX_GITHUB_PROJECT_OWNER: integration,
  PIRX_GITHUB_PROJECT_NUMBER: integration,
} satisfies Record<string, ProfileSettingDefinition>);

export type ProfileSettingName = keyof typeof PROFILE_SETTING_DEFINITIONS;
export const PROFILE_SETTINGS: ReadonlySet<string> = new Set(Object.keys(PROFILE_SETTING_DEFINITIONS));

const MCP_HOST_KEYS = [
  "HOME", "LANG", "LC_ALL", "LOGNAME", "PATH", "SHELL", "TEMP", "TMPDIR", "TZ", "USER",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", "DBUS_SESSION_BUS_ADDRESS", "GH_CONFIG_DIR",
] as const;
const MCP_OPERATIONAL_KEYS = [
  "PIRX_GITHUB_POC_ISSUE", "PIRX_GITHUB_SHIPMENT_POC", "PIRX_GITHUB_SHIPMENT_POC_STATE_FILE",
  "PIRX_GITHUB_SHIPMENT_CYCLE", "PIRX_GITHUB_FAILURE_HANDOFF_POC", "PIRX_GITHUB_FAILURE_HANDOFF_POC_STATE_FILE",
  "PIRX_CODEX_EXECUTABLE",
] as const;
export const MCP_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  ...MCP_HOST_KEYS,
  ...Object.entries(PROFILE_SETTING_DEFINITIONS).filter(([, definition]) => definition.forwardToMcp).map(([name]) => name),
  ...MCP_OPERATIONAL_KEYS,
]);


export function readProfileDefaults(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const home = environment.HOME?.trim() || homedir();
  const explicit = environment.PIRX_CHAT_CONFIG;
  if (explicit !== undefined && explicit.trim().length === 0) throw new Error("PIRX_CHAT_CONFIG cannot be empty.");
  const filename = explicit?.trim() || resolve(environment.XDG_CONFIG_HOME?.trim() || resolve(home, ".config"), "pirx", "chat.json");
  let text: string;
  try { text = readFileSync(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && explicit === undefined) return {};
    throw new Error(`Nie można odczytać konfiguracji chatu: ${filename}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`Niepoprawny JSON konfiguracji chatu: ${filename}`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Konfiguracja chatu musi być obiektem ustawień.");
  for (const [key, value] of Object.entries(parsed)) {
    if (!PROFILE_SETTINGS.has(key) || typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) throw new Error(`Nieobsługiwane lub niepoprawne ustawienie konfiguracji chatu: ${key}`);
  }
  return Object.freeze({ ...parsed } as Record<string, string>);
}

/** Pure resolution after profile I/O; undefined alone means absent. Explicit invalid values never fall back. */
export function resolveProfileEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const defaults = readProfileDefaults(environment);
  return { ...defaults, ...Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)) };
}

/** Compatibility startup boundary: atomically fill only missing values, after validating the whole profile. */
export function initializeHostEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  const resolved = resolveProfileEnvironment(environment);
  for (const [key, value] of Object.entries(resolved)) if (environment[key] === undefined) environment[key] = value;
}

function positive(environment: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = environment[key] === undefined ? fallback : Number(environment[key]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
  return value;
}

export function resolveModelSettings(environment: NodeJS.ProcessEnv) {
  const model = environment.OLLAMA_MODEL ?? "hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL";
  if (!model.trim() || /[\u0000-\u001f]/u.test(model)) throw new Error("OLLAMA_MODEL must be non-empty text.");
  const rawUrl = environment.OLLAMA_BASE_URL ?? "http://localhost:11434";
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("OLLAMA_BASE_URL must be a valid URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("OLLAMA_BASE_URL must be HTTP(S) without credentials, query or fragment.");
  const temperature = Number(environment.OLLAMA_TEMPERATURE ?? "0.3");
  if (!Number.isFinite(temperature) || environment.OLLAMA_TEMPERATURE?.trim() === "") throw new Error("OLLAMA_TEMPERATURE must be a finite number.");
  return Object.freeze({ model, baseUrl: rawUrl.replace(/\/+$/u, ""), numCtx: positive(environment, "OLLAMA_NUM_CTX", 16384), maxOutputTokens: positive(environment, "OLLAMA_MAX_OUTPUT_TOKENS", 1536), temperature });
}

export function modelSettingsEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  const settings = resolveModelSettings(resolveProfileEnvironment(environment));
  return Object.freeze({
    OLLAMA_MODEL: settings.model,
    OLLAMA_BASE_URL: settings.baseUrl,
    OLLAMA_NUM_CTX: String(settings.numCtx),
    OLLAMA_MAX_OUTPUT_TOKENS: String(settings.maxOutputTokens),
    OLLAMA_TEMPERATURE: String(settings.temperature),
  });
}
