import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { NvidiaSmiReading } from "./nvidia-smi.js";

export const GPU_STORE_VERSION = 1;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS gpu_samples (
    sampled_at INTEGER NOT NULL,
    gpu_index INTEGER NOT NULL,
    utilization_percent REAL,
    memory_utilization_percent REAL,
    vram_used_mb REAL,
    vram_total_mb REAL,
    temperature_c REAL,
    power_w REAL,
    power_limit_w REAL,
    fan_percent REAL,
    pstate TEXT,
    PRIMARY KEY (sampled_at, gpu_index)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS gpu_processes (
    sampled_at INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    name TEXT NOT NULL,
    vram_used_mb REAL,
    PRIMARY KEY (sampled_at, pid)
  ) WITHOUT ROWID;
`;

export class GpuStore {
  readonly #database: DatabaseSync;
  readonly #filename: string;
  readonly #insertSample: StatementSync;
  readonly #insertProcess: StatementSync;
  readonly #deleteProcesses: StatementSync;
  readonly #deleteSamples: StatementSync;
  #closed = false;

  private constructor(database: DatabaseSync, filename: string) {
    this.#database = database;
    this.#filename = filename;
    this.#insertSample = database.prepare(
      `INSERT INTO gpu_samples
        (sampled_at, gpu_index, utilization_percent, memory_utilization_percent,
         vram_used_mb, vram_total_mb, temperature_c, power_w, power_limit_w,
         fan_percent, pstate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#insertProcess = database.prepare(
      "INSERT INTO gpu_processes (sampled_at, pid, name, vram_used_mb) VALUES (?, ?, ?, ?)",
    );
    this.#deleteProcesses = database.prepare("DELETE FROM gpu_processes WHERE sampled_at < ?");
    this.#deleteSamples = database.prepare("DELETE FROM gpu_samples WHERE sampled_at < ?");
  }

  static open(filename: string): GpuStore {
    const database = new DatabaseSync(filename);
    try {
      // One sample per second is cheap to lose on power failure, so WAL without a fsync per commit is enough.
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      const { user_version: version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version === 0) {
        database.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version = ${GPU_STORE_VERSION}; COMMIT;`);
      } else if (version !== GPU_STORE_VERSION) {
        throw new Error(`Unsupported GPU store version: ${version} (expected ${GPU_STORE_VERSION}).`);
      }
      return new GpuStore(database, filename);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  get filename(): string {
    return this.#filename;
  }

  insertReading(sampledAtMs: number, reading: NvidiaSmiReading): void {
    this.#assertOpen();
    if (!Number.isSafeInteger(sampledAtMs) || sampledAtMs < 0) {
      throw new Error(`GPU sample time must be a non-negative safe integer: ${sampledAtMs}`);
    }
    this.#transaction(() => {
      for (const gpu of reading.gpus) {
        this.#insertSample.run(
          sampledAtMs,
          gpu.index,
          gpu.utilizationPercent,
          gpu.memoryUtilizationPercent,
          gpu.vramUsedMb,
          gpu.vramTotalMb,
          gpu.temperatureC,
          gpu.powerW,
          gpu.powerLimitW,
          gpu.fanPercent,
          gpu.pstate,
        );
      }
      for (const process of reading.processes) {
        this.#insertProcess.run(sampledAtMs, process.pid, process.name, process.vramMb);
      }
    });
  }

  pruneBefore(cutoffMs: number): number {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#deleteProcesses.run(cutoffMs);
      return Number(this.#deleteSamples.run(cutoffMs).changes);
    });
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("GPU store is closed.");
    }
  }
}
