import { DatabaseSync, type StatementSync } from "node:sqlite";

import type { CpuReading } from "./cpu.js";
import type { NvidiaSmiReading } from "./nvidia-smi.js";

export const GPU_STORE_VERSION = 2;

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

  CREATE TABLE IF NOT EXISTS cpu_samples (
    sampled_at INTEGER PRIMARY KEY,
    utilization_percent REAL,
    logical_cores INTEGER NOT NULL,
    load_1m REAL NOT NULL,
    load_5m REAL NOT NULL,
    load_15m REAL NOT NULL,
    total_memory_bytes INTEGER NOT NULL,
    free_memory_bytes INTEGER NOT NULL
  ) WITHOUT ROWID;
`;

export class GpuStore {
  readonly #database: DatabaseSync;
  readonly #filename: string;
  readonly #insertSample: StatementSync;
  readonly #insertProcess: StatementSync;
  readonly #insertCpuSample: StatementSync;
  readonly #deleteProcesses: StatementSync;
  readonly #deleteSamples: StatementSync;
  readonly #deleteCpuSamples: StatementSync;
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
    this.#insertCpuSample = database.prepare(
      "INSERT INTO cpu_samples (sampled_at, utilization_percent, logical_cores, load_1m, load_5m, load_15m, total_memory_bytes, free_memory_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#deleteProcesses = database.prepare("DELETE FROM gpu_processes WHERE sampled_at < ?");
    this.#deleteSamples = database.prepare("DELETE FROM gpu_samples WHERE sampled_at < ?");
    this.#deleteCpuSamples = database.prepare("DELETE FROM cpu_samples WHERE sampled_at < ?");
  }

  static open(filename: string): GpuStore {
    const database = new DatabaseSync(filename);
    try {
      // One sample per second is cheap to lose on power failure, so WAL without a fsync per commit is enough.
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
      const { user_version: version } = database.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version === 0) {
        database.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version = ${GPU_STORE_VERSION}; COMMIT;`);
      } else if (version === 1) {
        database.exec(`BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS cpu_samples (sampled_at INTEGER PRIMARY KEY, utilization_percent REAL, logical_cores INTEGER NOT NULL, load_1m REAL NOT NULL, load_5m REAL NOT NULL, load_15m REAL NOT NULL, total_memory_bytes INTEGER NOT NULL, free_memory_bytes INTEGER NOT NULL) WITHOUT ROWID; PRAGMA user_version = ${GPU_STORE_VERSION}; COMMIT;`);
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

  insertReading(sampledAtMs: number, reading: NvidiaSmiReading, cpu?: CpuReading): void {
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
      if (cpu !== undefined) this.#insertCpuSample.run(sampledAtMs, cpu.utilizationPercent, cpu.logicalCores, cpu.load1m, cpu.load5m, cpu.load15m, cpu.totalMemoryBytes, cpu.freeMemoryBytes);
    });
  }

  pruneBefore(cutoffMs: number): number {
    this.#assertOpen();
    return this.#transaction(() => {
      this.#deleteProcesses.run(cutoffMs);
      const gpu = Number(this.#deleteSamples.run(cutoffMs).changes);
      const cpu = Number(this.#deleteCpuSamples.run(cutoffMs).changes);
      return gpu + cpu;
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
