import { readNvidiaSmi, type NvidiaSmiReading } from "./nvidia-smi.js";

export interface GpuReadingSink {
  insertReading(sampledAtMs: number, reading: NvidiaSmiReading): void;
  pruneBefore(cutoffMs: number): number;
}

export interface GpuSamplerOptions {
  readonly intervalMs?: number;
  readonly retentionMs?: number;
  readonly pruneEveryMs?: number;
  readonly read?: () => Promise<NvidiaSmiReading>;
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

export class GpuSampler {
  readonly #sink: GpuReadingSink;
  readonly #intervalMs: number;
  readonly #retentionMs: number;
  readonly #pruneEveryMs: number;
  readonly #read: () => Promise<NvidiaSmiReading>;
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
    try {
      const reading = await this.#read();
      this.#sink.insertReading(sampledAt, reading);
    } catch (error: unknown) {
      this.#onError(error);
      return;
    }
    this.#onSample();
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
