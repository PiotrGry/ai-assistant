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

Bezpieczniki pętli narzędziowej są konfigurowalne przez:

- `PIRX_MAX_TOOL_ITERATIONS` (domyślnie `8`),
- `PIRX_MAX_REPEATED_TOOL_CALLS` (domyślnie `3`),
- `PIRX_LLM_TIMEOUT_MS` (domyślnie `120000`),
- `PIRX_TOOL_TIMEOUT_MS` (domyślnie `30000`).

Logi sesji trafiają do głównego katalogu `logs/` i nie są wersjonowane.

## Obsidian

Ustaw vault zmienną środowiskową przed uruchomieniem:

```bash
export PIRX_OBSIDIAN_VAULT=/bezwzgledna/sciezka/do/vaulta
```

Serwer udostępnia narzędzia `obsidian_read`, `obsidian_create`,
`obsidian_write`, `obsidian_append`, `obsidian_search`, `obsidian_list`,
`obsidian_move`, `obsidian_delete`, `obsidian_add_link`, `obsidian_links` i
`obsidian_backlinks`. Operacje dotyczą wyłącznie zwykłych plików `.md` wewnątrz
vaulta. Ścieżki absolutne, traversal, ukryte katalogi (w tym `.obsidian`),
symlinki i inne typy plików są odrzucane w warstwie filesystemu.

`obsidian_add_link` zapisuje natywny wikilink `[[Folder/Note]]` (opcjonalnie z
aliasem lub nagłówkiem) i nie dubluje istniejącego celu. `obsidian_links`
parsuje unikalne cele wychodzące. `obsidian_backlinks` skanuje pliki Markdown;
krótkie `[[Note]]` dopasowuje do nazwy pliku, a `[[Folder/Note]]` do pełnej
ścieżki w vaulcie. Obsidian GUI nie jest potrzebny.

## Google Calendar

Integracja używa OAuth 2.0 dla aplikacji typu **Desktop app**, pętli zwrotnej na
`127.0.0.1` i PKCE. Nie używa konta serwisowego ani nie przechowuje sekretów w
repozytorium.

1. W Google Cloud Console włącz Google Calendar API i skonfiguruj ekran zgody.
2. Utwórz OAuth Client ID typu Desktop app i pobierz plik JSON.
3. Zapisz go poza repozytorium (domyślnie
   `~/.config/pirx/google-calendar/credentials.json`) lub ustaw
   `PIRX_GOOGLE_CREDENTIALS_FILE`.
4. Uruchom `pnpm --filter @pirx/mcp-server calendar:authorize`, otwórz pokazany
   URL i zaakceptuj dostęp. Token zostanie zapisany atomowo z uprawnieniami
   `0600` (domyślnie `~/.config/pirx/google-calendar/token.json`).

Konfiguracja:

- `PIRX_GOOGLE_CREDENTIALS_FILE` — plik klienta OAuth,
- `PIRX_GOOGLE_TOKEN_FILE` — lokalny plik tokenu,
- `PIRX_GOOGLE_CALENDAR_ID` — domyślny kalendarz (`primary`),
- `PIRX_GOOGLE_CALENDAR_TIMEZONE` — domyślna strefa IANA (domyślnie systemowa),
- `PIRX_GOOGLE_TIMEOUT_MS` — timeout pojedynczego żądania (domyślnie `10000`),
- `PIRX_GOOGLE_AUTH_TIMEOUT_MS` — czas na ukończenie pierwszej autoryzacji
  (domyślnie `300000`).

Dostępne narzędzia to `calendar_list_calendars`, `calendar_list_events`,
`calendar_get_event`, `calendar_create_event`, `calendar_update_event` i
`calendar_delete_event`. Daty całodniowe mają format `YYYY-MM-DD` (koniec jest
wyłączny), a wydarzenia czasowe wymagają ISO 8601 z `Z` albo jawnym offsetem.
Żądania sieciowe mają timeout i nie są automatycznie ponawiane — szczególnie
tworzenie wydarzeń jest wykonywane najwyżej raz na wywołanie narzędzia.

Brak konfiguracji Obsidiana lub Google nie zatrzymuje MCP: odpowiednie
narzędzie zwróci kontrolowany błąd, a pozostałe pozostaną dostępne.

## LazyVim

W `:LazyExtras` włącz `lang.typescript`, zrestartuj Neovim i otwórz dowolny plik z `agent/src` albo `mcp-server/src`. `:LspInfo` powinno wtedy pokazać `vtsls`; serwer językowy sam odczyta tutejszy `tsconfig` i zależności z workspace.
