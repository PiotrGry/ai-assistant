import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AgentConfig, SystemPrompt } from "./config.js";
import type { TurnMetrics } from "./agent.js";

function sessionId(date: Date): string {
  return date.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

export class SessionLogger {
  readonly transcriptFile: string;
  readonly metricsFile: string;
  #lastMetrics: TurnMetrics | undefined;

  private constructor(transcriptFile: string, metricsFile: string) {
    this.transcriptFile = transcriptFile;
    this.metricsFile = metricsFile;
  }

  static async create(config: AgentConfig, prompt: SystemPrompt): Promise<SessionLogger> {
    await mkdir(config.logDir, { recursive: true, mode: 0o700 });
    await chmod(config.logDir, 0o700).catch(() => undefined);

    const id = sessionId(new Date());
    const logger = new SessionLogger(
      resolve(config.logDir, `session_${id}.md`),
      resolve(config.logDir, `session_${id}.jsonl`),
    );
    const header = [
      "# Rozmowa z Adą",
      "",
      `- Model: \`${config.model}\``,
      `- Kontekst: \`${config.numCtx}\``,
      `- System prompt: \`${config.promptFile}\` (sha256: \`${prompt.sha256}\`)`,
      `- Start: \`${new Date().toISOString()}\``,
      "",
    ].join("\n");

    await writeFile(logger.transcriptFile, header, { encoding: "utf8", mode: 0o600 });
    await writeFile(logger.metricsFile, "", { encoding: "utf8", mode: 0o600 });
    return logger;
  }

  get lastMetrics(): TurnMetrics | undefined {
    return this.#lastMetrics;
  }

  async saveTurn(prompt: string, response: string, metrics: TurnMetrics): Promise<void> {
    const transcript = `## Ty\n\n${prompt}\n\n## Ada\n\n${response}\n\n`;
    await Promise.all([
      appendFile(this.transcriptFile, transcript, "utf8"),
      appendFile(this.metricsFile, `${JSON.stringify(metrics)}\n`, "utf8"),
    ]);
    this.#lastMetrics = metrics;
  }

  async notePromptReload(prompt: SystemPrompt): Promise<void> {
    await appendFile(
      this.transcriptFile,
      `> System prompt wczytany ponownie (sha256: \`${prompt.sha256}\`). Historia wyczyszczona.\n\n`,
      "utf8",
    );
  }
}
