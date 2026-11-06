import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const START_SCRIPT = join(REPOSITORY_ROOT, "start.sh");

async function fixture(): Promise<{
  readonly directory: string;
  readonly home: string;
  readonly commandFile: string;
  readonly resultFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pirx-legacy-launcher-"));
  const bin = join(directory, "bin");
  const home = join(directory, "home");
  const assistant = join(home, "ai-assistant", "assistant.sh");
  const commandFile = join(directory, "command");
  const resultFile = join(directory, "result");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(dirname(assistant), { recursive: true }),
  ]);
  await writeFile(join(bin, "tmux"), `#!/usr/bin/env bash
set -eu
case "$1" in
  display-message) printf '%%1\\n' ;;
  split-window) printf '%%2\\n' ;;
  send-keys)
    if [[ ! -e "$COMMAND_FILE" ]]; then printf '%s' "$4" >"$COMMAND_FILE"; fi
    ;;
esac
`, "utf8");
  await writeFile(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await writeFile(assistant, `#!/usr/bin/env bash
printf '%s\\n%s\\n' "$OLLAMA_MODEL" "$OLLAMA_NUM_CTX" >"$RESULT_FILE"
`, "utf8");
  await Promise.all([
    chmod(join(bin, "tmux"), 0o700),
    chmod(join(bin, "sleep"), 0o700),
    chmod(assistant, 0o700),
  ]);
  return { directory, home, commandFile, resultFile };
}

test("legacy tmux launcher passes metacharacters literally and validates context before input", async () => {
  const setup = await fixture();
  const marker = join(setup.directory, "must-not-exist");
  const model = `model with spaces; touch ${marker}; $(touch ${marker})`;
  const path = `${join(setup.directory, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`;
  const baseEnvironment = {
    ...process.env,
    HOME: setup.home,
    TMUX: "fixture",
    PATH: path,
    COMMAND_FILE: setup.commandFile,
    RESULT_FILE: setup.resultFile,
  };

  const launched = spawnSync("bash", [START_SCRIPT, model], {
    encoding: "utf8",
    env: { ...baseEnvironment, OLLAMA_NUM_CTX: "32768" },
  });
  assert.equal(launched.status, 0, launched.stderr);
  const command = await readFile(setup.commandFile, "utf8");
  const executed = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
    env: baseEnvironment,
  });
  assert.equal(executed.status, 0, executed.stderr);
  assert.deepEqual((await readFile(setup.resultFile, "utf8")).split("\n"), [model, "32768", ""]);
  assert.equal(existsSync(marker), false);

  await rm(setup.commandFile);
  const rejected = spawnSync("bash", [START_SCRIPT, "safe-model"], {
    encoding: "utf8",
    env: { ...baseEnvironment, OLLAMA_NUM_CTX: "12; touch rejected" },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /dodatnią liczbą całkowitą/u);
  assert.equal(existsSync(setup.commandFile), false);
  assert.equal(existsSync(join(setup.directory, "rejected")), false);
  await rm(setup.directory, { recursive: true, force: true });
});
