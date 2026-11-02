import { cpus, freemem, loadavg, totalmem, type CpuInfo } from "node:os";

export interface CpuCounterSnapshot {
  readonly logicalCores: number;
  readonly idleMilliseconds: number;
  readonly totalMilliseconds: number;
  readonly loadAverage: readonly [number, number, number];
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
}

export interface CpuReading {
  readonly utilizationPercent: number | null;
  readonly logicalCores: number;
  readonly load1m: number;
  readonly load5m: number;
  readonly load15m: number;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
}

export type CpuSnapshotReader = () => CpuCounterSnapshot;

function finiteNonNegative(value: number): boolean { return Number.isFinite(value) && value >= 0; }

function totalCpuTimes(values: readonly CpuInfo[]): { idle: number; total: number } {
  let idle = 0; let total = 0;
  for (const cpu of values) {
    const times = cpu.times;
    const items = [times.user, times.nice, times.sys, times.idle, times.irq];
    if (!items.every(finiteNonNegative)) throw new Error("Operating-system CPU counters are invalid.");
    idle += times.idle;
    total += items.reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

export function readCpuCounterSnapshot(): CpuCounterSnapshot {
  const values = cpus();
  if (values.length === 0) throw new Error("Operating-system CPU counters are unavailable.");
  const times = totalCpuTimes(values);
  const loads = loadavg();
  const memoryTotal = totalmem(); const memoryFree = freemem();
  if (![...loads, memoryTotal, memoryFree].every(finiteNonNegative) || memoryFree > memoryTotal) throw new Error("Operating-system CPU metadata is invalid.");
  return { logicalCores: values.length, idleMilliseconds: times.idle, totalMilliseconds: times.total, loadAverage: [loads[0]!, loads[1]!, loads[2]!], totalMemoryBytes: memoryTotal, freeMemoryBytes: memoryFree };
}

export function calculateCpuUtilization(previous: CpuCounterSnapshot | undefined, current: CpuCounterSnapshot): number | null {
  if (previous === undefined || previous.logicalCores !== current.logicalCores) return null;
  const totalDelta = current.totalMilliseconds - previous.totalMilliseconds;
  const idleDelta = current.idleMilliseconds - previous.idleMilliseconds;
  if (!Number.isFinite(totalDelta) || !Number.isFinite(idleDelta) || totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  const value = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Number(Math.min(100, Math.max(0, value)).toFixed(3));
}

export class CpuReader {
  readonly #readSnapshot: CpuSnapshotReader;
  #previous: CpuCounterSnapshot | undefined;
  public constructor(readSnapshot: CpuSnapshotReader = readCpuCounterSnapshot) { this.#readSnapshot = readSnapshot; }
  public read(): CpuReading {
    const current = this.#readSnapshot();
    if (!Number.isSafeInteger(current.logicalCores) || current.logicalCores <= 0 || !finiteNonNegative(current.idleMilliseconds) || !finiteNonNegative(current.totalMilliseconds) || current.idleMilliseconds > current.totalMilliseconds || current.loadAverage.length !== 3 || !current.loadAverage.every(finiteNonNegative) || !Number.isSafeInteger(current.totalMemoryBytes) || !Number.isSafeInteger(current.freeMemoryBytes) || current.totalMemoryBytes <= 0 || current.freeMemoryBytes < 0 || current.freeMemoryBytes > current.totalMemoryBytes) throw new Error("CPU counter snapshot is invalid.");
    const utilizationPercent = calculateCpuUtilization(this.#previous, current);
    this.#previous = current;
    return { utilizationPercent, logicalCores: current.logicalCores, load1m: current.loadAverage[0], load5m: current.loadAverage[1], load15m: current.loadAverage[2], totalMemoryBytes: current.totalMemoryBytes, freeMemoryBytes: current.freeMemoryBytes };
  }
}
