import { homedir } from "node:os";
import { resolve } from "node:path";

export interface GpuSamplerConfig {
  readonly databasePath: string;
  readonly intervalMs: number;
  readonly retentionMs: number;
}

export interface ErrorReporter {
  error(error: unknown): void;
  sample(): void;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

function positiveInteger(name: string, value: string): number {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} musi być dodatnią liczbą całkowitą (otrzymano: ${value}).`);
  }
  return parsed;
}

export function loadGpuSamplerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): GpuSamplerConfig {
  const explicitPath = environment.PIRX_GPU_DB?.trim();
  const dataHome = environment.XDG_DATA_HOME?.trim() || resolve(home, ".local", "share");
  return {
    databasePath: explicitPath ? resolve(explicitPath) : resolve(dataHome, "pirx", "gpu.sqlite"),
    intervalMs: positiveInteger("PIRX_GPU_INTERVAL_MS", environment.PIRX_GPU_INTERVAL_MS ?? "1000"),
    retentionMs: positiveInteger("PIRX_GPU_RETENTION_DAYS", environment.PIRX_GPU_RETENTION_DAYS ?? "7") * DAY_MS,
  };
}

// A missing nvidia-smi would otherwise write one journal line per second, so repeats are collapsed.
export function createErrorReporter(write: (line: string) => void): ErrorReporter {
  let lastMessage: string | undefined;
  let failures = 0;
  return {
    error(error: unknown): void {
      const message = error instanceof Error ? error.message : String(error);
      failures += 1;
      if (message !== lastMessage) {
        write(`GPU sampler error: ${message}`);
        lastMessage = message;
      }
    },
    sample(): void {
      if (failures > 0) {
        write(`GPU sampler recovered after ${failures} failed samples`);
      }
      failures = 0;
      lastMessage = undefined;
    },
  };
}
