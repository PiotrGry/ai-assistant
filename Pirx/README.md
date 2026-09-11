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

Nowoczesny interfejs terminalowy uruchom osobno:

```bash
pnpm build
pnpm tui
```

W TUI Enter wysyła wiadomość, Shift+Enter dodaje nową linię, Ctrl+O otwiera
listę modeli zainstalowanych w Ollamie, a Ctrl+C kończy sesję. `pnpm start`
pozostaje dotychczasowym interfejsem CLI.

Agent domyślnie używa modelu `gemma4:12b` i Ollamy pod `http://localhost:11434`. Ustawienia można nadpisać zmiennymi:

- `OLLAMA_MODEL`,
- `OLLAMA_NUM_CTX`,
- `OLLAMA_KEEP_ALIVE`,
- `OLLAMA_BASE_URL`,
- `OLLAMA_TEMPERATURE`,
- `OLLAMA_MAX_OUTPUT_TOKENS`,
- `ADA_PROMPT_FILE`.

Context and storage controls:

- `PIRX_CONTEXT_SAFETY_MARGIN_TOKENS` — reserved input margin (default `512`),
- `PIRX_MAX_TOOL_RESULT_CHARACTERS` — deterministic MCP result limit (default `12000`),
- `PIRX_STORAGE_FILE` — SQLite path (default `$XDG_DATA_HOME/pirx/pirx.sqlite` or `~/.local/share/pirx/pirx.sqlite`),
- `PIRX_STORAGE_MODE` — `redacted` (default), `metrics_only`, or `full_local`,
- `PIRX_RESOURCE_SAMPLE_INTERVAL_MS` — resource sampling interval (default `1000`).

The SQLite store uses WAL and `synchronous=FULL`. It records sessions, turns,
operations, context-build references, ordered messages, tool-result artifacts,
action transitions, and resource samples. `redacted` stores hashes and sizes
instead of message/artifact bodies; `metrics_only` skips message and artifact
archival; `full_local` keeps the local bodies. The existing Markdown transcript
and JSONL metrics files remain local files outside Git.

The library exposes `backupDatabase`, `restoreDatabase`,
`exportDatabaseJsonl`, `retentionDryRun`, and `pruneResourceSamples` for
maintenance. Retention only targets old resource samples; action confirmations,
turns, messages, and artifacts are not deleted by that operation. Backups use
SQLite's online backup API and are integrity-checked before restore.

The `/stats` command reports full turn duration, backend prefill/decode values,
the estimated context budget, largest context sections, and observed resource
peaks. GPU values are sampled observations, not guaranteed maxima. Missing
backend fields or unavailable GPU data are reported as unavailable rather than
being converted to zero or inferred from the machine name.

Bezpieczniki pętli narzędziowej są konfigurowalne przez:

- `PIRX_MAX_TOOL_ITERATIONS` (domyślnie `8`),
- `PIRX_MAX_REPEATED_TOOL_CALLS` (domyślnie `3`),
- `PIRX_LLM_TIMEOUT_MS` (domyślnie `120000`),
- `PIRX_TOOL_TIMEOUT_MS` (domyślnie `30000`).

Przed każdym wywołaniem modelu agent dołącza świeżą lokalną datę, godzinę,
offset UTC i nazwę strefy. Używa do tego `PIRX_GOOGLE_CALENDAR_TIMEZONE`
(domyślnie strefa systemowa), dzięki czemu określenia „dzisiaj”, „jutro” i
podobne nie zależą od pamięci modelu. Kontekst czasu jest przejściowy i nie
narasta w historii rozmowy.

Logi sesji trafiają do głównego katalogu `logs/` i nie są wersjonowane.

## Obsidian

Domyślnym vaultem jest `Pirx/vault`. Możesz użyć innego vaulta, ustawiając
zmienną środowiskową przed uruchomieniem:

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
4. Uruchom `pnpm --filter @pirx/mcp-server calendar:authorize`. Pirx spróbuje
   automatycznie otworzyć domyślną przeglądarkę; jeśli środowisko jest
   headless/SSH, użyj wypisanego URL-a ręcznie. Zaakceptuj dostęp. Token zostanie zapisany atomowo z uprawnieniami
   `0600` (domyślnie `~/.config/pirx/google-calendar/token.json`).

Konfiguracja:

- `PIRX_GOOGLE_CREDENTIALS_FILE` — plik klienta OAuth,
- `PIRX_GOOGLE_TOKEN_FILE` — lokalny plik tokenu,
- `PIRX_GOOGLE_CALENDAR_ID` — domyślny kalendarz (`primary`),
- `PIRX_GOOGLE_CALENDAR_TIMEZONE` — wspólna strefa IANA agenta i kalendarza
  (domyślnie systemowa),
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

## GitHub Issue round-trip POC

Opcjonalny tool `github_issue_round_trip_poc` jest widoczny wyłącznie po
ustawieniu stałego celu `PIRX_GITHUB_POC_ISSUE`. W repozytorium testowym używa
się Issue `179`. Numer Issue nie jest argumentem narzędzia i model nie może go
zmienić. Wywołanie odczytuje Issue, publikuje oznaczony komentarz cyklu życia,
weryfikuje stan i ponawia operację idempotentnie.

Konfiguracja GitHub pozostaje w procesie serwera MCP/orchestratora:

- uwierzytelnienie pochodzi z `gh auth token`; wykonaj wcześniej `gh auth login`
  (opcjonalnie ustaw `GH_CONFIG_DIR` dla niestandardowego profilu),
- `PIRX_GITHUB_OWNER` i `PIRX_GITHUB_REPOSITORY`,
- `PIRX_GITHUB_POC_ISSUE` — stały numer Issue sandboxa,
- opcjonalnie `PIRX_GITHUB_API_URL` i `PIRX_GITHUB_TIMEOUT_MS`.

Token jest pobierany przy każdym uruchomieniu serwera przez lokalny GitHub CLI,
ale nie trafia do modelu, argumentów MCP, wyników narzędzi ani logów.

Po ustawieniu `PIRX_GITHUB_OWNER` i `PIRX_GITHUB_REPOSITORY` serwer udostępnia
też repository-scoped tools `github_issue_get`, `github_issue_list`,
`github_issue_search`, `github_issue_create`, `github_issue_update`,
`github_issue_comment`, `github_issue_close` i `github_issue_reopen`. Żaden z
tych tooli nie przyjmuje repozytorium jako argumentu. Odczyty są read-only;
mutacje wymagają argumentu `confirmed: true`, czyli jawnego potwierdzenia
użytkownika przed ponowieniem wywołania.

## LazyVim

W `:LazyExtras` włącz `lang.typescript`, zrestartuj Neovim i otwórz dowolny plik z `agent/src` albo `mcp-server/src`. `:LspInfo` powinno wtedy pokazać `vtsls`; serwer językowy sam odczyta tutejszy `tsconfig` i zależności z workspace.
