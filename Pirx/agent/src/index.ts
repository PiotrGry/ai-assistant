import { createInterface, type Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { PirxAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { SessionLogger } from "./logger.js";

const HELP = `Dostępne komendy:
  /help       pokaż pomoc
  /clear      wyczyść pamięć bieżącej rozmowy
  /reload     wczytaj ponownie system prompt
  /stats      pokaż metryki ostatniej odpowiedzi
  /model      pokaż model, kontekst i stan Ollamy
  /unload     usuń model z pamięci
  /exit       zakończ rozmowę

Wiadomość wieloliniową zakończ osobną linią /send.
Komendy zaczynające się od / działają od razu.`;

async function readPrompt(readline: Interface): Promise<string | undefined> {
  console.log("\nTy: wpisz wiadomość. Zakończ osobną linią /send");
  const lines: string[] = [];

  while (true) {
    let line: string;
    try {
      line = await readline.question(lines.length === 0 ? "> " : "… ");
    } catch {
      return undefined;
    }

    if (line === "/send") {
      return lines.join("\n");
    }

    if (lines.length === 0 && line.startsWith("/")) {
      return line;
    }

    lines.push(line);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const agent = await PirxAgent.create(config, {
    onToolCall: (name, arguments_) => {
      console.log(`\n[tool] ${name} ${JSON.stringify(arguments_)}`);
    },
    onMcpUnavailable: (reason) => {
      console.error(`\nUwaga: ${reason}`);
      console.error("Rozmowa będzie kontynuowana bez narzędzi MCP.");
    },
  });
  const logger = await SessionLogger.create(config, agent.systemPrompt);
  const readline = createInterface({ input: stdin, output: stdout });
  readline.on("SIGINT", () => readline.close());

  console.log("\nPirx — lokalna asystentka");
  console.log(`Model: ${config.model}`);
  console.log(`Kontekst: ${config.numCtx}`);
  console.log(`Prompt: ${config.promptFile} (${agent.systemPrompt.sha256})`);
  console.log(`Narzędzia MCP: ${agent.toolNames.join(", ") || "brak"}`);
  console.log("Wpisz /help, aby zobaczyć komendy.");

  try {
    while (true) {
      const prompt = await readPrompt(readline);
      if (prompt === undefined) {
        break;
      }

      switch (prompt.trim()) {
        case "":
          break;
        case "/help":
          console.log(HELP);
          break;
        case "/clear":
          agent.clearHistory();
          console.log("Pamięć bieżącej rozmowy została wyczyszczona.");
          break;
        case "/reload": {
          const reloaded = await agent.reloadSystemPrompt();
          await logger.notePromptReload(reloaded);
          console.log(`System prompt wczytany ponownie (${reloaded.sha256}).`);
          console.log("Pamięć bieżącej rozmowy została wyczyszczona.");
          break;
        }
        case "/stats":
          console.log(
            logger.lastMetrics === undefined
              ? "Nie ma jeszcze żadnych metryk."
              : JSON.stringify(logger.lastMetrics, null, 2),
          );
          break;
        case "/model":
          console.log(`Model: ${config.model}`);
          console.log(`Kontekst: ${config.numCtx}`);
          console.log(`Keep alive: ${config.keepAlive}`);
          console.log(`Temperatura: ${config.temperature}`);
          console.log(JSON.stringify(await agent.modelStatus(), null, 2));
          break;
        case "/unload":
          await agent.unloadModel();
          console.log("Model został usunięty z pamięci.");
          break;
        case "/exit":
        case "/quit":
          return;
        default: {
          try {
            const turn = await agent.chat(prompt);
            console.log(`\nPirx: ${turn.content}\n`);
            await logger.saveTurn(prompt, turn.content, turn.metrics);
            console.log(
              `Metryki: ${turn.metrics.output_tokens} tokenów, ` +
              `${turn.metrics.generation_tokens_per_second.toFixed(1)} tok/s, ` +
              `${turn.metrics.tool_calls} wywołań narzędzi.`,
            );
          } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error);
            console.error(`\nBłąd komunikacji z Ollamą: ${detail}`);
          }
        }
      }
    }
  } finally {
    readline.close();
    await agent.close();
    console.log("\nSesja zakończona.");
    console.log(`Rozmowa: ${logger.transcriptFile}`);
    console.log(`Metryki: ${logger.metricsFile}`);
  }
}

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Nie można uruchomić Pirxa: ${detail}`);
  process.exitCode = 1;
});
