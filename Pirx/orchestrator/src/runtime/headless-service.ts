import type { SchedulerCycleResult } from "./scheduler.js";

export const HEADLESS_SERVICE_SCHEMA_VERSION = 1 as const;
export const HEADLESS_SERVICE_LIMITS = Object.freeze({
  minimumIntervalMs: 100,
  maximumIntervalMs: 300_000,
  maximumMessageCharacters: 256,
} as const);

export interface HeadlessRuntimePort {
  recover(): Promise<SchedulerCycleResult>;
  cycle(): Promise<SchedulerCycleResult>;
  shutdown(): Promise<{ readonly outcome: "stopped" | "timeout"; readonly interrupted: boolean }>;
  close(): void;
  status(): { readonly active: boolean; readonly stopping: boolean; readonly recovered: boolean };
}

export interface HeadlessServiceEvent {
  readonly schemaVersion: typeof HEADLESS_SERVICE_SCHEMA_VERSION;
  readonly event: "starting" | "recovered" | "cycle" | "cycle_error" | "stopping" | "stopped";
  readonly outcome: string;
  readonly reason?: string;
}

export interface HeadlessServiceOptions {
  readonly cycleIntervalMs: number;
  readonly errorIntervalMs?: number;
  readonly emit?: (event: HeadlessServiceEvent) => void;
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
}

export type HeadlessServiceResult =
  | { readonly outcome: "stopped"; readonly exitCode: 0; readonly interrupted: boolean }
  | { readonly outcome: "startup_recovery_failed"; readonly exitCode: 2; readonly reason: string }
  | { readonly outcome: "shutdown_timeout"; readonly exitCode: 3; readonly interrupted: true };

function boundedReason(value: unknown): string {
  const message = typeof value === "string" ? value : "operation_failed";
  return message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, HEADLESS_SERVICE_LIMITS.maximumMessageCharacters);
}

function defaultSleep(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, durationMs);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function validInterval(value: number): boolean {
  return Number.isSafeInteger(value) && value >= HEADLESS_SERVICE_LIMITS.minimumIntervalMs && value <= HEADLESS_SERVICE_LIMITS.maximumIntervalMs;
}

export class HeadlessOrchestratorService {
  readonly #runtime: HeadlessRuntimePort;
  readonly #cycleIntervalMs: number;
  readonly #errorIntervalMs: number;
  readonly #emit: (event: HeadlessServiceEvent) => void;
  readonly #sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly #wake = new AbortController();
  #running = false;
  #stopRequested = false;
  #closed = false;
  #stopPromise: Promise<HeadlessServiceResult> | undefined;

  public constructor(runtime: HeadlessRuntimePort, options: HeadlessServiceOptions) {
    if (!validInterval(options.cycleIntervalMs) || !validInterval(options.errorIntervalMs ?? options.cycleIntervalMs)) throw new RangeError("Headless service interval is outside its bounded range.");
    this.#runtime = runtime;
    this.#cycleIntervalMs = options.cycleIntervalMs;
    this.#errorIntervalMs = options.errorIntervalMs ?? options.cycleIntervalMs;
    this.#emit = options.emit ?? (() => undefined);
    this.#sleep = options.sleep ?? defaultSleep;
  }

  public get running(): boolean { return this.#running; }
  public get stopping(): boolean { return this.#stopRequested; }

  public async run(): Promise<HeadlessServiceResult> {
    if (this.#running) throw new Error("Headless service is already running.");
    if (this.#stopRequested) return this.stop("stop_before_start");
    this.#running = true;
    this.#event("starting", "recovering");
    let recovery: SchedulerCycleResult;
    try { recovery = await this.#runtime.recover(); }
    catch { return this.#stopRequested ? this.stop("stop_during_recovery") : this.#startupFailure("recovery_threw"); }
    if (this.#stopRequested) return this.stop("stop_during_recovery");
    if (recovery.outcome !== "idle") return this.#startupFailure(recovery.outcome === "reconciliation_required" ? recovery.reason : `unexpected_${recovery.outcome}`);
    this.#event("recovered", "success");

    while (!this.#stopRequested) {
      let delay = this.#cycleIntervalMs;
      try {
        const result = await this.#runtime.cycle();
        this.#event("cycle", result.outcome, "reason" in result ? result.reason : undefined);
      } catch {
        delay = this.#errorIntervalMs;
        this.#event("cycle_error", "contained", "cycle_threw");
      }
      if (!this.#stopRequested) await this.#sleep(delay, this.#wake.signal);
    }
    return this.stop("run_loop_stopped");
  }

  public stop(reason: string): Promise<HeadlessServiceResult> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopRequested = true;
    this.#wake.abort();
    this.#event("stopping", "requested", reason);
    this.#stopPromise = this.#shutdown();
    return this.#stopPromise;
  }

  async #startupFailure(reason: string): Promise<HeadlessServiceResult> {
    this.#stopRequested = true;
    this.#wake.abort();
    this.#closeOnce();
    this.#running = false;
    const normalized = boundedReason(reason);
    this.#event("stopped", "startup_recovery_failed", normalized);
    return { outcome: "startup_recovery_failed", exitCode: 2, reason: normalized };
  }

  async #shutdown(): Promise<HeadlessServiceResult> {
    const result = await this.#runtime.shutdown();
    this.#running = false;
    if (result.outcome === "timeout") {
      this.#event("stopped", "shutdown_timeout");
      return { outcome: "shutdown_timeout", exitCode: 3, interrupted: true };
    }
    this.#closed = true; // ProductionRuntime.shutdown owns storage close on success.
    this.#event("stopped", "success");
    return { outcome: "stopped", exitCode: 0, interrupted: result.interrupted };
  }

  #closeOnce(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#runtime.close();
  }

  #event(event: HeadlessServiceEvent["event"], outcome: string, reason?: unknown): void {
    this.#emit(Object.freeze({ schemaVersion: HEADLESS_SERVICE_SCHEMA_VERSION, event, outcome: boundedReason(outcome), ...(reason === undefined ? {} : { reason: boundedReason(reason) }) }));
  }
}
