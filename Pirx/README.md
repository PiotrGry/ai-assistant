# Pirx w TypeScript

## Pytania workera do Pirxa

Daemon automatycznie uruchamia Claude z dedykowanym serwerem MCP
`pirx_advisor` i narzędziem `ask_pirx`. Nie trzeba rejestrować MCP ręcznie.
Konfiguracja jest przypisana do konkretnego Tasku i Attemptu; pozostałe
serwery MCP są wyłączone przez `--strict-mcp-config`.

Doradca to osobna tura modelu Pirxa w Ollamie, bez narzędzi wykonawczych.
Otrzymuje cel, zakres, kryteria akceptacji i poprzednie pytania z Attemptu.
Korzysta z ustawień `OLLAMA_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_NUM_CTX`
w środowisku serwera lub `~/.config/pirx/chat.json`. Nie zna historii TUI
ani stanu hosta poza przekazanym kontekstem. Odpowiedź nie przyznaje uprawnień.

Limit wynosi 3 pytania na Attempt, 4000 znaków pytania, 6000 znaków odpowiedzi
i 45 sekund na odpowiedź modelu (w ramach limitu czasu całego workera).
Powtórzenie tego samego `requestId` odczytuje poprzedni wynik bez ponownego
wywołania modelu. Brak odpowiedzi oznacza błąd narzędzia; worker powinien
zwrócić BLOCKED, jeśli nie może kontynuować bez wyjaśnienia.

Pytania, odpowiedzi i błędy są zapisywane po redakcji sekretów w tabeli
`runtime_agent_questions` w `runtime.sqlite` (migracja 32). Czat odczytuje
historię narzędziem `pirx_agent_conversation` z `taskId` i kursorem `afterRow`.
`pending` oznacza wywołanie bez zapisanego wyniku, również po przerwaniu procesu.
Ta funkcja nie wysyła automatycznych powiadomień do TUI.

Po aktualizacji trzeba zbudować cały workspace (`pnpm build`) i wdrożyć
razem pakiety orchestrator, mcp-server oraz agent. Stary runtime ze schematem
31 nie może otwierać bazy po migracji 32; przed wdrożeniem zachowaj kopię bazy.

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
listę modeli zainstalowanych w Ollamie, a Ctrl+C kończy sesję. Pełnoekranowy
widok pokazuje ostatnią część rozmowy, a pełna historia trafia również do
zwykłego bufora terminala: kółko myszy przewija, przeciągnięcie zaznacza tekst,
a Cmd+C (macOS) lub Ctrl+Shift+C (Linux/Windows) kopiuje zaznaczenie. `pnpm
start` pozostaje dotychczasowym interfejsem CLI.

Agent domyślnie używa modelu `hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL` i Ollamy pod `http://localhost:11434`. Ustawienia można nadpisać zmiennymi:

- `OLLAMA_MODEL`,
- `OLLAMA_NUM_CTX` (domyślnie `16384`; 4096 jest zbyt małe dla promptu systemowego i schematów narzędzi MCP),
- `OLLAMA_KEEP_ALIVE`,
- `OLLAMA_BASE_URL`,
- `OLLAMA_TEMPERATURE`,
- `OLLAMA_MAX_OUTPUT_TOKENS`,
- `ADA_PROMPT_FILE`.

Context and storage controls:

- `PIRX_CONTEXT_SAFETY_MARGIN_TOKENS` — reserved input margin (default `512`),
- `PIRX_MAX_TOOL_RESULT_CHARACTERS` — deterministic MCP result limit (default `12000`),
- `PIRX_CONTINUATION_CHECK` — after a reply without a tool call, ask the model once whether a tool step is still needed, so an announced step ("Pobieram teraz…") actually runs (default `true`),
- `PIRX_STORAGE_FILE` — SQLite path (default `$XDG_DATA_HOME/pirx/pirx.sqlite` or `~/.local/share/pirx/pirx.sqlite`),
- `PIRX_STORAGE_MODE` — `full_local` (default, keeps message and tool-result bodies for the dashboard), `redacted`, or `metrics_only`,
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

The standalone `pnpm --filter @pirx/agent gpu:sampler` process stores one-second
host CPU and NVIDIA GPU samples in the same local `gpu.sqlite` database. CPU
utilization is calculated from operating-system counter deltas; its first value
is deliberately unavailable. CPU collection continues when `nvidia-smi` is
missing, while GPU collection can continue after a transient CPU-reader error.
The MCP server uses the same `PIRX_GPU_DB`/XDG path for the always-listed
read-only `pirx_resource_report` tool. One call returns current values, stale
flags, bounded averages/peaks, and bucketed CPU/GPU history; it never starts the
sampler or returns process lists and filesystem paths.

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

Serwer zawsze udostępnia repository-scoped tools `github_issue_get`,
`github_issue_list`, `github_issue_search`, `github_issue_create`,
`github_issue_update`, `github_issue_comment`, `github_issue_close` i
`github_issue_reopen`. Bez `PIRX_GITHUB_OWNER` i `PIRX_GITHUB_REPOSITORY`
pozostają widoczne, ale zwracają kontrolowany błąd `configuration` z nazwą
brakującej zmiennej, więc model nie udaje braku dostępu. `task Pirx` ustawia
je na `PiotrGry/ai-assistant`. Żaden z tych tooli nie przyjmuje repozytorium
jako argumentu. Odczyty są read-only;
mutacje są wykonywane wyłącznie po autoryzacji związanej przez hosta Pirx z
konkretnym narzędziem, celem i skrótem argumentów. Model nie może sam nadać
sobie uprawnień przez argument narzędzia. Klucz idempotencji jest wyznaczany
przez hosta, więc ponowienie tej samej operacji nie tworzy drugiego zapisu.

### Controlled shipment round-trip POC

Po ustawieniu `PIRX_GITHUB_SHIPMENT_POC=1` serwer udostępnia dodatkowo
`github_shipment_round_trip_poc`. Narzędzie przyjmuje tylko `eventId`, branch
`pirx/poc-*`, dokładny SHA oraz bounded watch settings. Cel jest na stałe
ustawiony na `PiotrGry/zdrovena-reconciliation`, a bazy na `develop` i `main`.
Operacja weryfikuje branch, tworzy lub odzyskuje feature PR, obserwuje CI dla
dokładnego SHA, scala wyłącznie feature PR do `develop`, a następnie tworzy lub
odzyskuje release PR i obserwuje jego CI. Zawsze zatrzymuje się przed merge do
`main` i zwraca `production_approval_required`, gdy release CI jest zielone.

Stan wznowień jest przechowywany lokalnie w katalogu stanu użytkownika
(`$XDG_STATE_HOME/pirx/github-shipment-poc.json` lub
`~/.local/state/pirx/github-shipment-poc.json`); ścieżkę można zmienić przez
`PIRX_GITHUB_SHIPMENT_POC_STATE_FILE`. Plik nie
zawiera tokenów, logów jobów ani surowych odpowiedzi GitHuba.

## LazyVim

W `:LazyExtras` włącz `lang.typescript`, zrestartuj Neovim i otwórz dowolny plik z `agent/src` albo `mcp-server/src`. `:LspInfo` powinno wtedy pokazać `vtsls`; serwer językowy sam odczyta tutejszy `tsconfig` i zależności z workspace.


### Explicit Obsidian opt-in

Set `PIRX_OBSIDIAN_VAULT` to the vault you want Pirx to access, either in the
existing chat profile or the launch environment (explicit environment wins).
There is no automatic fallback to the repository vault. Missing configuration
leaves Obsidian unavailable; an invalid configured path fails only the Obsidian
operation and never selects another vault. Other MCP integrations remain usable.


### GitHub write target

A fallback repository is only a read default. To enable mutations, explicitly set
both `PIRX_GITHUB_OWNER` and `PIRX_GITHUB_REPOSITORY` in the launch environment or
supported chat profile. Daemon repository entries supply their explicit targets.
GitHub token transport requires HTTPS; redirects and cross-origin request URLs
are rejected. Tests use injected transports rather than a production HTTP bypass.


`calendar_list_events` returns one bounded page: `events`, `complete`, and optional
`nextPageToken`. Continue with that token as `pageToken` and unchanged calendar,
range and page-size parameters. An empty page with a token is not an empty calendar.
A failed subsequent page is an error, not proof that the previous page was complete.
