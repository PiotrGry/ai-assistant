import { DatabaseSync } from "node:sqlite";
import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

export const RESOURCE_REPORT_SCHEMA_VERSION = 1 as const;
export const RESOURCE_STORE_SCHEMA_VERSION = 2 as const;
export const RESOURCE_REPORT_LIMITS = Object.freeze({ windowMinutesMaximum: 10_080, pointCountMaximum: 240, staleAfterMsMaximum: 3_600_000, gpuIndexMaximum: 63 } as const);

export interface ResourceReportRequest {
  readonly nowMs: number;
  readonly windowMinutes: number;
  readonly pointCount: number;
  readonly staleAfterMs: number;
  readonly gpuIndex: number;
}

interface ResourceSummary { readonly sampleCount: number; readonly averageUtilizationPercent: number | null; readonly peakUtilizationPercent: number | null; }
interface CpuCurrent { readonly sampledAt: string; readonly stale: boolean; readonly utilizationPercent: number | null; readonly logicalCores: number; readonly load1m: number; readonly load5m: number; readonly load15m: number; readonly totalMemoryBytes: number; readonly freeMemoryBytes: number; }
interface GpuCurrent { readonly sampledAt: string; readonly stale: boolean; readonly gpuIndex: number; readonly utilizationPercent: number | null; readonly memoryUtilizationPercent: number | null; readonly vramUsedMb: number | null; readonly vramTotalMb: number | null; readonly temperatureC: number | null; readonly powerW: number | null; }
interface HistoryPoint { readonly sampledAt: string; readonly utilizationPercent: number | null; }

export interface ResourceReport {
  readonly schemaVersion: typeof RESOURCE_REPORT_SCHEMA_VERSION;
  readonly window: { readonly from: string; readonly to: string };
  readonly notices: readonly string[];
  readonly cpu?: { readonly current: CpuCurrent; readonly summary: ResourceSummary; readonly history: readonly HistoryPoint[] };
  readonly gpu?: { readonly current: GpuCurrent; readonly summary: ResourceSummary; readonly history: readonly HistoryPoint[] };
}

export type ResourceReportResult =
  | { readonly outcome: "success"; readonly report: ResourceReport }
  | { readonly outcome: "no_data"; readonly window: { readonly from: string; readonly to: string }; readonly notices: readonly string[] }
  | { readonly outcome: "invalid_request" | "invalid_data" | "schema_mismatch" | "unavailable"; readonly message: string };

export interface ResourceReportPort { report(input: ResourceReportRequest): ResourceReportResult; }

type CpuRow = { sampled_at: unknown; utilization_percent: unknown; logical_cores: unknown; load_1m: unknown; load_5m: unknown; load_15m: unknown; total_memory_bytes: unknown; free_memory_bytes: unknown };
type GpuRow = { sampled_at: unknown; gpu_index: unknown; utilization_percent: unknown; memory_utilization_percent: unknown; vram_used_mb: unknown; vram_total_mb: unknown; temperature_c: unknown; power_w: unknown };
type SummaryRow = { sample_count: unknown; average_utilization_percent: unknown; peak_utilization_percent: unknown };
type HistoryRow = { sampled_at: unknown; utilization_percent: unknown };

function integer(value: unknown, minimum: number, maximum: number): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum; }
function nullableNumber(value: unknown): value is number | null { return value === null || (typeof value === "number" && Number.isFinite(value)); }
function nonNegativeNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function percent(value: unknown): value is number | null { return nullableNumber(value) && (value === null || (value >= 0 && value <= 100)); }
function iso(value: number): string { return new Date(value).toISOString(); }
function summary(row: SummaryRow | undefined): ResourceSummary | undefined {
  if (row === undefined || !integer(row.sample_count, 0, Number.MAX_SAFE_INTEGER) || !percent(row.average_utilization_percent) || !percent(row.peak_utilization_percent)) return undefined;
  return { sampleCount: row.sample_count, averageUtilizationPercent: row.average_utilization_percent, peakUtilizationPercent: row.peak_utilization_percent };
}
function history(rows: readonly HistoryRow[], pointCount: number): readonly HistoryPoint[] | undefined {
  if (rows.length > pointCount) return undefined;
  const values: HistoryPoint[] = [];
  for (const row of rows) {
    if (!integer(row.sampled_at, 0, Number.MAX_SAFE_INTEGER) || !percent(row.utilization_percent)) return undefined;
    values.push({ sampledAt: iso(row.sampled_at), utilizationPercent: row.utilization_percent });
  }
  return values.reverse();
}

export class SqliteResourceReportPort implements ResourceReportPort {
  readonly #filename: string;
  public constructor(filename: string) { this.#filename = filename; }

  public report(input: ResourceReportRequest): ResourceReportResult {
    if (!integer(input.nowMs, 0, 8_640_000_000_000_000) || !integer(input.windowMinutes, 1, RESOURCE_REPORT_LIMITS.windowMinutesMaximum) || !integer(input.pointCount, 1, RESOURCE_REPORT_LIMITS.pointCountMaximum) || !integer(input.staleAfterMs, 1_000, RESOURCE_REPORT_LIMITS.staleAfterMsMaximum) || !integer(input.gpuIndex, 0, RESOURCE_REPORT_LIMITS.gpuIndexMaximum)) return { outcome: "invalid_request", message: "Resource report request is outside bounded limits." };
    const fromMs = input.nowMs - input.windowMinutes * 60_000;
    if (!Number.isSafeInteger(fromMs) || fromMs < 0) return { outcome: "invalid_request", message: "Resource report window is invalid." };
    const window = { from: iso(fromMs), to: iso(input.nowMs) };
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.#filename, { readOnly: true });
      const version = (database.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined)?.user_version;
      if (version !== RESOURCE_STORE_SCHEMA_VERSION) return { outcome: "schema_mismatch", message: "Resource telemetry database schema is unsupported." };
      const bucketMs = Math.max(1, Math.ceil((input.nowMs - fromMs) / input.pointCount));
      const cpuRow = database.prepare("SELECT sampled_at, utilization_percent, logical_cores, load_1m, load_5m, load_15m, total_memory_bytes, free_memory_bytes FROM cpu_samples WHERE sampled_at >= ? AND sampled_at <= ? ORDER BY sampled_at DESC LIMIT 1").get(fromMs, input.nowMs) as CpuRow | undefined;
      const gpuRow = database.prepare("SELECT sampled_at, gpu_index, utilization_percent, memory_utilization_percent, vram_used_mb, vram_total_mb, temperature_c, power_w FROM gpu_samples WHERE sampled_at >= ? AND sampled_at <= ? AND gpu_index = ? ORDER BY sampled_at DESC LIMIT 1").get(fromMs, input.nowMs, input.gpuIndex) as GpuRow | undefined;
      if (cpuRow === undefined && gpuRow === undefined) return { outcome: "no_data", window, notices: ["cpu_unavailable", "gpu_unavailable"] };

      const notices: string[] = [];
      let cpu: ResourceReport["cpu"];
      if (cpuRow === undefined) notices.push("cpu_unavailable");
      else {
        if (!integer(cpuRow.sampled_at, fromMs, input.nowMs) || !percent(cpuRow.utilization_percent) || !integer(cpuRow.logical_cores, 1, 65_536) || !nonNegativeNumber(cpuRow.load_1m) || !nonNegativeNumber(cpuRow.load_5m) || !nonNegativeNumber(cpuRow.load_15m) || !integer(cpuRow.total_memory_bytes, 1, Number.MAX_SAFE_INTEGER) || !integer(cpuRow.free_memory_bytes, 0, cpuRow.total_memory_bytes)) return { outcome: "invalid_data", message: "A CPU telemetry row is malformed." };
        const stale = input.nowMs - cpuRow.sampled_at > input.staleAfterMs; if (stale) notices.push("cpu_stale");
        const cpuSummary = summary(database.prepare("SELECT COUNT(*) AS sample_count, ROUND(AVG(utilization_percent), 3) AS average_utilization_percent, MAX(utilization_percent) AS peak_utilization_percent FROM cpu_samples WHERE sampled_at >= ? AND sampled_at <= ?").get(fromMs, input.nowMs) as SummaryRow | undefined);
        const cpuHistory = history(database.prepare("SELECT (sampled_at / ?) * ? AS sampled_at, ROUND(AVG(utilization_percent), 3) AS utilization_percent FROM cpu_samples WHERE sampled_at >= ? AND sampled_at <= ? GROUP BY 1 ORDER BY 1 DESC LIMIT ?").all(bucketMs, bucketMs, fromMs, input.nowMs, input.pointCount) as HistoryRow[], input.pointCount);
        if (cpuSummary === undefined || cpuHistory === undefined) return { outcome: "invalid_data", message: "CPU telemetry aggregation is malformed." };
        cpu = { current: { sampledAt: iso(cpuRow.sampled_at), stale, utilizationPercent: cpuRow.utilization_percent, logicalCores: cpuRow.logical_cores, load1m: cpuRow.load_1m, load5m: cpuRow.load_5m, load15m: cpuRow.load_15m, totalMemoryBytes: cpuRow.total_memory_bytes, freeMemoryBytes: cpuRow.free_memory_bytes }, summary: cpuSummary, history: cpuHistory };
      }

      let gpu: ResourceReport["gpu"];
      if (gpuRow === undefined) notices.push("gpu_unavailable");
      else {
        if (!integer(gpuRow.sampled_at, fromMs, input.nowMs) || gpuRow.gpu_index !== input.gpuIndex || !percent(gpuRow.utilization_percent) || !percent(gpuRow.memory_utilization_percent) || !nullableNumber(gpuRow.vram_used_mb) || !nullableNumber(gpuRow.vram_total_mb) || !nullableNumber(gpuRow.temperature_c) || !nullableNumber(gpuRow.power_w)) return { outcome: "invalid_data", message: "A GPU telemetry row is malformed." };
        const stale = input.nowMs - gpuRow.sampled_at > input.staleAfterMs; if (stale) notices.push("gpu_stale");
        const gpuSummary = summary(database.prepare("SELECT COUNT(*) AS sample_count, ROUND(AVG(utilization_percent), 3) AS average_utilization_percent, MAX(utilization_percent) AS peak_utilization_percent FROM gpu_samples WHERE sampled_at >= ? AND sampled_at <= ? AND gpu_index = ?").get(fromMs, input.nowMs, input.gpuIndex) as SummaryRow | undefined);
        const gpuHistory = history(database.prepare("SELECT (sampled_at / ?) * ? AS sampled_at, ROUND(AVG(utilization_percent), 3) AS utilization_percent FROM gpu_samples WHERE sampled_at >= ? AND sampled_at <= ? AND gpu_index = ? GROUP BY 1 ORDER BY 1 DESC LIMIT ?").all(bucketMs, bucketMs, fromMs, input.nowMs, input.gpuIndex, input.pointCount) as HistoryRow[], input.pointCount);
        if (gpuSummary === undefined || gpuHistory === undefined) return { outcome: "invalid_data", message: "GPU telemetry aggregation is malformed." };
        gpu = { current: { sampledAt: iso(gpuRow.sampled_at), stale, gpuIndex: gpuRow.gpu_index, utilizationPercent: gpuRow.utilization_percent, memoryUtilizationPercent: gpuRow.memory_utilization_percent, vramUsedMb: gpuRow.vram_used_mb, vramTotalMb: gpuRow.vram_total_mb, temperatureC: gpuRow.temperature_c, powerW: gpuRow.power_w }, summary: gpuSummary, history: gpuHistory };
      }
      return { outcome: "success", report: { schemaVersion: RESOURCE_REPORT_SCHEMA_VERSION, window, notices, ...(cpu === undefined ? {} : { cpu }), ...(gpu === undefined ? {} : { gpu }) } };
    } catch {
      return { outcome: "unavailable", message: "Resource telemetry database is unavailable." };
    } finally { try { database?.close(); } catch { /* preserve bounded result */ } }
  }
}

const reportSchema = z.object({
  schemaVersion: z.literal(1), window: z.object({ from: z.string(), to: z.string() }), notices: z.array(z.string()),
  cpu: z.object({ current: z.object({ sampledAt: z.string(), stale: z.boolean(), utilizationPercent: z.number().nullable(), logicalCores: z.number().int().positive(), load1m: z.number(), load5m: z.number(), load15m: z.number(), totalMemoryBytes: z.number().int().positive(), freeMemoryBytes: z.number().int().nonnegative() }), summary: z.object({ sampleCount: z.number().int().nonnegative(), averageUtilizationPercent: z.number().nullable(), peakUtilizationPercent: z.number().nullable() }), history: z.array(z.object({ sampledAt: z.string(), utilizationPercent: z.number().nullable() })) }).optional(),
  gpu: z.object({ current: z.object({ sampledAt: z.string(), stale: z.boolean(), gpuIndex: z.number().int().nonnegative(), utilizationPercent: z.number().nullable(), memoryUtilizationPercent: z.number().nullable(), vramUsedMb: z.number().nullable(), vramTotalMb: z.number().nullable(), temperatureC: z.number().nullable(), powerW: z.number().nullable() }), summary: z.object({ sampleCount: z.number().int().nonnegative(), averageUtilizationPercent: z.number().nullable(), peakUtilizationPercent: z.number().nullable() }), history: z.array(z.object({ sampledAt: z.string(), utilizationPercent: z.number().nullable() })) }).optional(),
});
const outputSchema = z.union([
  z.object({ outcome: z.literal("success"), report: reportSchema }),
  z.object({ outcome: z.literal("no_data"), window: z.object({ from: z.string(), to: z.string() }), notices: z.array(z.string()) }),
  z.object({ outcome: z.enum(["invalid_request", "invalid_data", "schema_mismatch", "unavailable"]), message: z.string() }),
]);
function structured(value: unknown, isError = false) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) }; }

export function registerResourceTools(server: McpServer, options: { readonly port: ResourceReportPort; readonly now?: () => number }): void {
  const now = options.now ?? Date.now;
  server.registerTool("pirx_resource_report", {
    title: "Read local CPU and GPU report",
    description: "Read one bounded CPU/GPU utilization report from local durable samples. This does not start sampling, mutate the host, or return process lists and paths.",
    inputSchema: z.object({ windowMinutes: z.number().int().min(1).max(10_080).optional(), pointCount: z.number().int().min(1).max(240).optional(), staleAfterMs: z.number().int().min(1_000).max(3_600_000).optional(), gpuIndex: z.number().int().min(0).max(63).optional() }).strict(),
    outputSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => {
    const value = options.port.report({ nowMs: now(), windowMinutes: input.windowMinutes ?? 60, pointCount: input.pointCount ?? 60, staleAfterMs: input.staleAfterMs ?? 5_000, gpuIndex: input.gpuIndex ?? 0 });
    return structured(value, value.outcome !== "success" && value.outcome !== "no_data");
  });
}
