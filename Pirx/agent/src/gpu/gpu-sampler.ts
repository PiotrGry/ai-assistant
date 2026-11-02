import { readNvidiaSmi, type NvidiaSmiReading } from "./nvidia-smi.js";
import { CpuReader, type CpuReading } from "./cpu.js";

export interface GpuReadingSink {
  insertReading(sampledAtMs: number, reading: NvidiaSmiReading, cpu?: CpuReading): void;
  pruneBefore(cutoffMs: number): number;
}

export interface GpuSamplerOptions {
  readonly intervalMs?: number;
  readonly retentionMs?: number;
  readonly pruneEveryMs?: number;
  readonly read?: () => Promise<NvidiaSmiReading>;
  readonly readCpu?: () => CpuReading | Promise<CpuReading>;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
  readonly onSample?: () => void;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_PRUNE_EVERY_MS = 60 * 60 * 1_000;

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer: ${value}`);
  }
  return value;
}

function invoke<T>(read: () => T | Promise<T>): Promise<T> {
  try { return Promise.resolve(read()); }
  catch (error: unknown) { return Promise.reject(error); }
}

export class GpuSampler {
  readonly #sink: GpuReadingSink;
  readonly #intervalMs: number;
  readonly #retentionMs: number;
  readonly #pruneEveryMs: number;
  readonly #read: () => Promise<NvidiaSmiReading>;
  readonly #readCpu: () => CpuReading | Promise<CpuReading>;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #onSample: () => void;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #lastPruneAt: number | undefined;

  constructor(sink: GpuReadingSink, options: GpuSamplerOptions = {}) {
    this.#sink = sink;
    this.#intervalMs = positiveInteger("GPU sampling interval", options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#retentionMs = positiveInteger("GPU retention", options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.#pruneEveryMs = positiveInteger("GPU prune interval", options.pruneEveryMs ?? DEFAULT_PRUNE_EVERY_MS);
    this.#read = options.read ?? (() => readNvidiaSmi());
    const cpuReader = new CpuReader();
    this.#readCpu = options.readCpu ?? (() => cpuReader.read());
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
    this.#onSample = options.onSample ?? (() => undefined);
  }

  // The interval timer is intentionally not unref'd: it is what keeps the sampler process alive.
  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#prune();
    this.#timer = setInterval(() => {
      void this.sampleNow();
    }, this.#intervalMs);
    void this.sampleNow();
  }

  sampleNow(): Promise<void> {
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }
    this.#inFlight = this.#sample().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#inFlight;
  }

  async #sample(): Promise<void> {
    const sampledAt = this.#now();
    const [gpu, cpu] = await Promise.allSettled([
      invoke(this.#read),
      invoke(this.#readCpu),
    ]);
    if (gpu.status === "rejected") this.#onError(gpu.reason);
    if (cpu.status === "rejected") this.#onError(cpu.reason);
    if (gpu.status === "rejected" && cpu.status === "rejected") return;
    try {
      this.#sink.insertReading(sampledAt, gpu.status === "fulfilled" ? gpu.value : { gpus: [], processes: [] }, cpu.status === "fulfilled" ? cpu.value : undefined);
    } catch (error: unknown) {
      this.#onError(error);
      return;
    }
    if (gpu.status === "fulfilled" && cpu.status === "fulfilled") this.#onSample();
    if (this.#lastPruneAt === undefined || this.#now() - this.#lastPruneAt >= this.#pruneEveryMs) {
      this.#prune();
    }
  }

  #prune(): void {
    const now = this.#now();
    this.#lastPruneAt = now;
    try {
      this.#sink.pruneBefore(now - this.#retentionMs);
    } catch (error: unknown) {
      this.#onError(error);
    }
  }
}
