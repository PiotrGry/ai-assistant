import { randomUUID } from "node:crypto";
import { freemem, hostname, loadavg, totalmem } from "node:os";

import { readGpuStats, type GpuStats } from "./telemetry.js";
import type { ResourceSampleRecord } from "./storage/sqlite.js";

export type { ResourceSampleRecord } from "./storage/sqlite.js";

export interface ResourceSnapshot {
  readonly source: string;
  readonly host?: string;
  readonly gpuIndex?: number;
  readonly payload: Record<string, unknown>;
}

export type ResourceReader = () => Promise<ResourceSnapshot>;

export interface ResourceSamplerSink {
  insertResourceSample(record: ResourceSampleRecord): void;
}

export interface ResourceSamplerOptions {
  readonly intervalMs?: number;
  readonly sessionId?: string;
  readonly read?: ResourceReader;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
}

export interface ResourceSamplerState {
  readonly running: boolean;
  readonly sampling: boolean;
}

function positiveInterval(value: number | undefined): number {
  const interval = value ?? 1_000;
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error(`Resource sampler interval must be a positive safe integer: ${interval}`);
  }
  return interval;
}

async function defaultRead(): Promise<ResourceSnapshot> {
  const gpu: GpuStats | null = await readGpuStats();
  const loads = loadavg();
  return {
    source: "node+nvidia-smi",
    host: hostname(),
    payload: {
      schema_version: 1,
      host: {
        total_memory_bytes: totalmem(),
        free_memory_bytes: freemem(),
        load_1m: Number.isFinite(loads[0]) ? loads[0] : null,
      },
      gpu,
    },
  };
}

export class ResourceSampler {
  readonly #sink: ResourceSamplerSink;
  readonly #intervalMs: number;
  readonly #sessionId: string | undefined;
  readonly #read: ResourceReader;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<void> | undefined;
  #turnId: string | undefined;

  constructor(sink: ResourceSamplerSink, options: ResourceSamplerOptions = {}) {
    this.#sink = sink;
    this.#intervalMs = positiveInterval(options.intervalMs);
    this.#sessionId = options.sessionId;
    this.#read = options.read ?? defaultRead;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
  }

  get state(): ResourceSamplerState {
    return {
      running: this.#timer !== undefined,
      sampling: this.#inFlight !== undefined,
    };
  }

  setTurnId(turnId: string | undefined): void {
    this.#turnId = turnId;
  }

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.sampleNow();
    }, this.#intervalMs);
    this.#timer.unref();
    void this.sampleNow();
  }

  async sampleNow(): Promise<void> {
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }

    const run = this.#readAndStore();
    this.#inFlight = run.finally(() => {
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

  async #readAndStore(): Promise<void> {
    try {
      const snapshot = await this.#read();
      this.#sink.insertResourceSample({
        id: randomUUID(),
        ...(this.#sessionId === undefined ? {} : { sessionId: this.#sessionId }),
        ...(this.#turnId === undefined ? {} : { turnId: this.#turnId }),
        sampledAt: this.#now().toISOString(),
        source: snapshot.source,
        ...(snapshot.host === undefined ? {} : { host: snapshot.host }),
        ...(snapshot.gpuIndex === undefined ? {} : { gpuIndex: snapshot.gpuIndex }),
        payload: snapshot.payload,
      });
    } catch (error: unknown) {
      this.#onError(error);
    }
  }
}
