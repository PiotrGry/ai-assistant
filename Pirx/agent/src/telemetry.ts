import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GpuStats {
  readonly utilization_percent: number | null;
  readonly vram_used_mb: number | null;
  readonly vram_total_mb: number | null;
  readonly temperature_c: number | null;
  readonly power_w: number | null;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readGpuStats(): Promise<GpuStats | null> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
      ],
      { encoding: "utf8", timeout: 3_000 },
    );
    const firstLine = stdout.split("\n", 1)[0];
    if (firstLine === undefined || firstLine.trim().length === 0) {
      return null;
    }

    const values = firstLine.split(",");
    return {
      utilization_percent: numberOrNull(values[0]),
      vram_used_mb: numberOrNull(values[1]),
      vram_total_mb: numberOrNull(values[2]),
      temperature_c: numberOrNull(values[3]),
      power_w: numberOrNull(values[4]),
    };
  } catch {
    return null;
  }
}
