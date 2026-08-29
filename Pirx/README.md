# Pirx w TypeScript

Docelowy runtime lokalnej asystentki składa się z dwóch procesów:

- `agent` — rozmowa z Ollamą, pętla wywołań narzędzi i logi sesji,
- `mcp-server` — narzędzia udostępniane agentowi przez MCP po `stdio`.

Pythonowy katalog `pirx-mcp` pozostaje referencją na czas migracji.

## Wymagania

- Node.js 22 lub nowszy,
- pnpm 11,
- działająca Ollama z pobranym modelem.

## Pierwsze uruchomienie

```bash
cd Pirx
pnpm install
pnpm check
pnpm start
```

Z katalogu głównego repozytorium można też użyć:

```bash
task pirx:install
task pirx:test
task pirx:start
```

Agent domyślnie używa modelu `hf.co/google/gemma-4-12B-it-qat-q4_0-gguf` i Ollamy pod `http://localhost:11434`. Ustawienia można nadpisać zmiennymi:

- `OLLAMA_MODEL`,
- `OLLAMA_NUM_CTX`,
- `OLLAMA_KEEP_ALIVE`,
- `OLLAMA_BASE_URL`,
- `OLLAMA_TEMPERATURE`,
- `ADA_PROMPT_FILE`.

Logi sesji trafiają do głównego katalogu `logs/` i nie są wersjonowane.

## LazyVim

W `:LazyExtras` włącz `lang.typescript`, zrestartuj Neovim i otwórz dowolny plik z `agent/src` albo `mcp-server/src`. `:LspInfo` powinno wtedy pokazać `vtsls`; serwer językowy sam odczyta tutejszy `tsconfig` i zależności z workspace.
