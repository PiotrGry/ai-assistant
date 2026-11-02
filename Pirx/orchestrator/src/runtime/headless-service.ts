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

export interface HeadlessQueueReconciliationPort {
  reconcile(): Promise<{ readonly outcome: string; readonly message?: string }>;
}

export interface HeadlessDeliveryReconciliationPort {
  reconcile(): Promise<{ readonly outcome: string; readonly allowWorkerCycle: boolean; readonly message?: string }>;
}

export interface HeadlessControlPort {
  read(): { readonly outcome: "success"; readonly mode: "running" | "paused" } | { readonly outcome: "error"; readonly message: string } | Promise<{ readonly outcome: "success"; readonly mode: "running" | "paused" } | { readonly outcome: "error"; readonly message: string }>;
  observe(event: HeadlessServiceEvent): void;
  paused(): void;
}

export type HeadlessHostShutdownEvaluation =
  | { readonly outcome: "idle" }
  | { readonly outcome: "armed"; readonly requestOperationId: string }
  | { readonly outcome: "triggered"; readonly requestOperationId: string }
  | { readonly outcome: "error"; readonly message: string };

export interface HeadlessHostShutdownPort {
  evaluate(input: { readonly queueOutcome?: string; readonly deliveryOutcome?: string; readonly cycleOutcome?: string }): HeadlessHostShutdownEvaluation;
  beginDrain(): { readonly outcome: "success" } | { readonly outcome: "error"; readonly message: string };
  powerOffRequested(): { readonly outcome: "success" } | { readonly outcome: "error"; readonly message: string };
  failBeforeClose(reason: string): void;
  powerOffAfterClose(): Promise<{ readonly outcome: "accepted" | "failed"; readonly message: string }>;
}

export interface HeadlessServiceEvent {
  readonly schemaVersion: typeof HEADLESS_SERVICE_SCHEMA_VERSION;
  readonly event: "starting" | "recovered" | "control" | "queue" | "delivery" | "cycle" | "cycle_error" | "host_shutdown" | "stopping" | "stopped";
  readonly outcome: string;
  readonly reason?: string;
}

export interface HeadlessServiceOptions {
  readonly cycleIntervalMs: number;
  readonly errorIntervalMs?: number;
  readonly emit?: (event: HeadlessServiceEvent) => void;
  readonly sleep?: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly queue?: HeadlessQueueReconciliationPort;
  readonly delivery?: HeadlessDeliveryReconciliationPort;
  readonly control?: HeadlessControlPort;
  readonly hostShutdown?: HeadlessHostShutdownPort;
}

export type HeadlessServiceResult =
  | { readonly outcome: "stopped"; readonly exitCode: 0; readonly interrupted: boolean }
  | { readonly outcome: "startup_recovery_failed"; readonly exitCode: 2; readonly reason: string }
  | { readonly outcome: "shutdown_timeout"; readonly exitCode: 3; readonly interrupted: true }
  | { readonly outcome: "host_shutdown_failed"; readonly exitCode: 4; readonly reason: string };

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
  readonly #queue: HeadlessQueueReconciliationPort | undefined;
  readonly #delivery: HeadlessDeliveryReconciliationPort | undefined;
  readonly #control: HeadlessControlPort | undefined;
  readonly #hostShutdown: HeadlessHostShutdownPort | undefined;
  readonly #wake = new AbortController();
  #running = false;
  #stopRequested = false;
  #closed = false;
  #hostShutdownPending = false;
  #stopPromise: Promise<HeadlessServiceResult> | undefined;

  public constructor(runtime: HeadlessRuntimePort, options: HeadlessServiceOptions) {
    if (!validInterval(options.cycleIntervalMs) || !validInterval(options.errorIntervalMs ?? options.cycleIntervalMs)) throw new RangeError("Headless service interval is outside its bounded range.");
    this.#runtime = runtime;
    this.#cycleIntervalMs = options.cycleIntervalMs;
    this.#errorIntervalMs = options.errorIntervalMs ?? options.cycleIntervalMs;
    this.#emit = options.emit ?? (() => undefined);
    this.#sleep = options.sleep ?? defaultSleep;
    this.#queue = options.queue;
    this.#delivery = options.delivery;
    this.#control = options.control;
    this.#hostShutdown = options.hostShutdown;
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
        if (this.#control !== undefined) {
          const control = await this.#control.read();
          if (control.outcome !== "success") {
            delay = this.#errorIntervalMs;
            this.#event("control", "unavailable", control.message);
            if (!this.#stopRequested) await this.#sleep(delay, this.#wake.signal);
            continue;
          }
          if (this.#evaluateHostShutdown({})) return this.stop("host_shutdown_triggered");
          if (control.mode === "paused") {
            this.#control.paused();
            this.#event("control", "paused");
            if (!this.#stopRequested) await this.#sleep(delay, this.#wake.signal);
            continue;
          }
          this.#event("control", "running");
        } else if (this.#evaluateHostShutdown({})) return this.stop("host_shutdown_triggered");
        let queueOutcome: string | undefined;
        if (this.#queue !== undefined) {
          const queue = await this.#queue.reconcile();
          queueOutcome = queue.outcome;
          this.#event("queue", queue.outcome, queue.message);
          if (queue.outcome !== "synchronized") {
            delay = this.#errorIntervalMs;
            if (!this.#stopRequested) await this.#sleep(delay, this.#wake.signal);
            continue;
          }
        }
        let deliveryOutcome: string | undefined;
        if (this.#delivery !== undefined) {
          const delivery = await this.#delivery.reconcile();
          deliveryOutcome = delivery.outcome;
          this.#event("delivery", delivery.outcome, delivery.message);
          if (!delivery.allowWorkerCycle) {
            if (["rate_limited", "reconciliation_required"].includes(delivery.outcome)) delay = this.#errorIntervalMs;
            if (!this.#stopRequested) await this.#sleep(delay, this.#wake.signal);
            continue;
          }
        }
        const result = await this.#runtime.cycle();
        this.#event("cycle", result.outcome, "reason" in result ? result.reason : undefined);
        if (this.#evaluateHostShutdown({ ...(queueOutcome === undefined ? {} : { queueOutcome }), ...(deliveryOutcome === undefined ? {} : { deliveryOutcome }), cycleOutcome: result.outcome })) return this.stop("host_shutdown_triggered");
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
    let hostFailure: string | undefined;
    if (this.#hostShutdownPending) {
      const drain = this.#hostShutdown?.beginDrain();
      if (drain === undefined || drain.outcome === "error") {
        hostFailure = drain?.message ?? "Host shutdown coordinator is unavailable.";
        this.#hostShutdownPending = false;
      } else this.#event("host_shutdown", "draining");
    }
    const result = await this.#runtime.shutdown();
    this.#running = false;
    if (result.outcome === "timeout") {
      if (this.#hostShutdownPending) this.#hostShutdown?.failBeforeClose("runtime_drain_timeout");
      this.#event("stopped", "shutdown_timeout");
      return { outcome: "shutdown_timeout", exitCode: 3, interrupted: true };
    }
    if (this.#hostShutdownPending) {
      const requested = this.#hostShutdown?.powerOffRequested();
      if (requested === undefined || requested.outcome === "error") {
        hostFailure = requested?.message ?? "Host shutdown coordinator is unavailable.";
        this.#hostShutdown?.failBeforeClose("poweroff_request_persistence_failed");
        this.#hostShutdownPending = false;
      } else this.#event("host_shutdown", "poweroff_requested");
    }
    this.#event("stopped", "success");
    this.#closeOnce();
    if (this.#hostShutdownPending) {
      const powered = await this.#hostShutdown!.powerOffAfterClose();
      this.#emit(Object.freeze({ schemaVersion: HEADLESS_SERVICE_SCHEMA_VERSION, event: "host_shutdown", outcome: powered.outcome, reason: boundedReason(powered.message) }));
      if (powered.outcome === "failed") return { outcome: "host_shutdown_failed", exitCode: 4, reason: boundedReason(powered.message) };
    }
    if (hostFailure !== undefined) return { outcome: "host_shutdown_failed", exitCode: 4, reason: boundedReason(hostFailure) };
    return { outcome: "stopped", exitCode: 0, interrupted: result.interrupted };
  }

  #evaluateHostShutdown(input: { readonly queueOutcome?: string; readonly deliveryOutcome?: string; readonly cycleOutcome?: string }): boolean {
    if (this.#hostShutdown === undefined) return false;
    const value = this.#hostShutdown.evaluate(input);
    if (value.outcome === "error") { this.#event("host_shutdown", "blocked", value.message); return false; }
    if (value.outcome !== "triggered") return false;
    this.#hostShutdownPending = true;
    this.#event("host_shutdown", "triggered", value.requestOperationId);
    return true;
  }

  #closeOnce(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#runtime.close();
  }

  #event(event: HeadlessServiceEvent["event"], outcome: string, reason?: unknown): void {
    const value = Object.freeze({ schemaVersion: HEADLESS_SERVICE_SCHEMA_VERSION, event, outcome: boundedReason(outcome), ...(reason === undefined ? {} : { reason: boundedReason(reason) }) });
    try { this.#control?.observe(value); } catch { /* status publication cannot crash orchestration */ }
    this.#emit(value);
  }
}
