import assert from "node:assert/strict";
import test from "node:test";

import {
  GPU_PROCESS_QUERY_ARGS,
  GPU_QUERY_ARGS,
  parseGpuCsv,
  parseProcessCsv,
  readNvidiaSmi,
} from "../src/gpu/nvidia-smi.js";

test("parses nvidia-smi GPU rows with units stripped", () => {
  assert.deepEqual(parseGpuCsv("0, 37, 12, 9125, 16376, 61, 212.40, 320.00, 45, P2\n"), [
    {
      index: 0,
      utilizationPercent: 37,
      memoryUtilizationPercent: 12,
      vramUsedMb: 9125,
      vramTotalMb: 16376,
      temperatureC: 61,
      powerW: 212.4,
      powerLimitW: 320,
      fanPercent: 45,
      pstate: "P2",
    },
  ]);
});

test("maps unsupported nvidia-smi values to null and keeps every GPU row", () => {
  const rows = parseGpuCsv(
    "0, 0, 23, 283, 16376, 53, 29.73, 320.00, [N/A], P8\n" +
      "1, [Not Supported], [N/A], 10, 8192, 40, [N/A], [N/A], 30, P0\n",
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.fanPercent, null);
  assert.deepEqual(rows[1], {
    index: 1,
    utilizationPercent: null,
    memoryUtilizationPercent: null,
    vramUsedMb: 10,
    vramTotalMb: 8192,
    temperatureC: 40,
    powerW: null,
    powerLimitW: null,
    fanPercent: 30,
    pstate: "P0",
  });
});

test("rejects a GPU row with an unexpected number of fields", () => {
  assert.throws(() => parseGpuCsv("0, 37, 12\n"), /nvidia-smi GPU row has 3 fields, expected 10/u);
});

test("parses compute processes, including names that contain a comma and space", () => {
  assert.deepEqual(parseProcessCsv(""), []);
  assert.deepEqual(
    parseProcessCsv("4242, /usr/local/bin/ollama, 7890\n77, python3 train.py --tags a, b, [N/A]\n"),
    [
      { pid: 4242, name: "/usr/local/bin/ollama", vramMb: 7890 },
      { pid: 77, name: "python3 train.py --tags a, b", vramMb: null },
    ],
  );
});

test("reads GPU rows and processes with focused nvidia-smi queries", async () => {
  const calls: Array<readonly string[]> = [];
  const reading = await readNvidiaSmi(async (args) => {
    calls.push(args);
    return args === GPU_QUERY_ARGS ? "0, 5, 1, 300, 16376, 50, 30.00, 320.00, 0, P8\n" : "4242, ollama, 7890\n";
  });

  assert.deepEqual(calls, [GPU_QUERY_ARGS, GPU_PROCESS_QUERY_ARGS]);
  assert.equal(reading.gpus[0]?.vramUsedMb, 300);
  assert.deepEqual(reading.processes, [{ pid: 4242, name: "ollama", vramMb: 7890 }]);
  assert.match(GPU_QUERY_ARGS.join(" "), /--query-gpu=index,utilization\.gpu,utilization\.memory,memory\.used,memory\.total,temperature\.gpu,power\.draw,power\.limit,fan\.speed,pstate/u);
  assert.match(GPU_PROCESS_QUERY_ARGS.join(" "), /--query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits/u);
});
