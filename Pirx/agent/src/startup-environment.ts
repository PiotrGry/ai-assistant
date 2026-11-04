import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const SETTINGS = new Set([
  "OLLAMA_MODEL", "OLLAMA_NUM_CTX", "OLLAMA_BASE_URL", "OLLAMA_MAX_OUTPUT_TOKENS", "OLLAMA_TEMPERATURE",
  "PIRX_CONTEXT_SAFETY_MARGIN_TOKENS", "PIRX_MAX_TOOL_CALLS", "PIRX_MAX_TOOL_ITERATIONS", "PIRX_MAX_TURN_DURATION_MS", "PIRX_MAX_TURN_TOOL_RESULT_CHARACTERS",
  "PIRX_ORCHESTRATOR_CONFIG", "PIRX_ORCHESTRATOR_DATABASE", "PIRX_ORCHESTRATOR_SERVICE_ENABLED", "PIRX_GPU_DB",
  "PIRX_OBSIDIAN_VAULT",
  "PIRX_GITHUB_OWNER", "PIRX_GITHUB_REPOSITORY", "PIRX_GITHUB_PROJECT_OWNER", "PIRX_GITHUB_PROJECT_NUMBER",
]);

/** Explicit per-user startup defaults, shared by all chat entry points. Never executes shell files. */
export function initializeHostEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  const filename = environment.PIRX_CHAT_CONFIG?.trim() || resolve(environment.XDG_CONFIG_HOME?.trim() || resolve(homedir(), ".config"), "pirx", "chat.json");
  let text: string;
  try { text = readFileSync(filename, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && environment.PIRX_CHAT_CONFIG === undefined) return;
    throw new Error(`Nie można odczytać konfiguracji chatu: ${filename}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`Niepoprawny JSON konfiguracji chatu: ${filename}`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Konfiguracja chatu musi być obiektem ustawień.");
  const entries = Object.entries(parsed);
  // Validate the entire file before setting any defaults.
  for (const [key, value] of entries) if (!SETTINGS.has(key) || typeof value !== "string" || value.trim().length === 0 || /[\u0000\r\n]/u.test(value)) throw new Error(`Nieobsługiwane lub niepoprawne ustawienie konfiguracji chatu: ${key}`);
  for (const [key, value] of entries) if (environment[key] === undefined) environment[key] = value as string;
}
