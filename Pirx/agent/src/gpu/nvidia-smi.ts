import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GPU_QUERY_ARGS: readonly string[] = [
  "--query-gpu=index,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw,power.limit,fan.speed,pstate",
  "--format=csv,noheader,nounits",
];

export const GPU_PROCESS_QUERY_ARGS: readonly string[] = [
  "--query-compute-apps=pid,process_name,used_memory",
  "--format=csv,noheader,nounits",
];

export interface GpuSample {
  readonly index: number;
  readonly utilizationPercent: number | null;
  readonly memoryUtilizationPercent: number | null;
  readonly vramUsedMb: number | null;
  readonly vramTotalMb: number | null;
  readonly temperatureC: number | null;
  readonly powerW: number | null;
  readonly powerLimitW: number | null;
  readonly fanPercent: number | null;
  readonly pstate: string | null;
}

export interface GpuProcess {
  readonly pid: number;
  readonly name: string;
  readonly vramMb: number | null;
}

export interface NvidiaSmiReading {
  readonly gpus: readonly GpuSample[];
  readonly processes: readonly GpuProcess[];
}

export type NvidiaSmiRunner = (args: readonly string[]) => Promise<string>;

const FIELD_SEPARATOR = ", ";
const GPU_FIELD_COUNT = 10;

function rows(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// nvidia-smi reports unavailable values as bracketed text such as "[N/A]" or "[Not Supported]".
function unavailable(value: string): boolean {
  return value.length === 0 || value.startsWith("[");
}

function measurement(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (unavailable(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function identifier(value: string | undefined, kind: string, line: string): number {
  const parsed = measurement(value);
  if (parsed === null || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`nvidia-smi ${kind} row has no valid ${kind === "GPU" ? "index" : "pid"}: ${line}`);
  }
  return parsed;
}

export function parseGpuCsv(stdout: string): GpuSample[] {
  return rows(stdout).map((line) => {
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length !== GPU_FIELD_COUNT) {
      throw new Error(`nvidia-smi GPU row has ${fields.length} fields, expected ${GPU_FIELD_COUNT}: ${line}`);
    }
    const pstate = fields[9]?.trim() ?? "";
    return {
      index: identifier(fields[0], "GPU", line),
      utilizationPercent: measurement(fields[1]),
      memoryUtilizationPercent: measurement(fields[2]),
      vramUsedMb: measurement(fields[3]),
      vramTotalMb: measurement(fields[4]),
      temperatureC: measurement(fields[5]),
      powerW: measurement(fields[6]),
      powerLimitW: measurement(fields[7]),
      fanPercent: measurement(fields[8]),
      pstate: unavailable(pstate) ? null : pstate,
    };
  });
}

export function parseProcessCsv(stdout: string): GpuProcess[] {
  return rows(stdout).map((line) => {
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length < 3) {
      throw new Error(`nvidia-smi process row has ${fields.length} fields, expected at least 3: ${line}`);
    }
    return {
      pid: identifier(fields[0], "process", line),
      name: fields.slice(1, -1).join(FIELD_SEPARATOR),
      vramMb: measurement(fields.at(-1)),
    };
  });
}

async function execNvidiaSmi(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("nvidia-smi", [...args], { encoding: "utf8", timeout: 3_000 });
  return stdout;
}

export async function readNvidiaSmi(run: NvidiaSmiRunner = execNvidiaSmi): Promise<NvidiaSmiReading> {
  const gpus = parseGpuCsv(await run(GPU_QUERY_ARGS));
  const processes = parseProcessCsv(await run(GPU_PROCESS_QUERY_ARGS));
  return { gpus, processes };
}
