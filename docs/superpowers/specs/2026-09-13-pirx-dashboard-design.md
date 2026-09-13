# Dashboard danych Pirxa (Grafana): projekt

- Data: 2026-09-13
- Status: architektura zatwierdzona w rozmowie 2026-09-13 (z sekretami w sops)

## Cel

Jeden dashboard, który pokazuje trzy rzeczy z lokalnej bazy Pirxa:

1. wydajność modeli,
2. użycie narzędzi MCP i błędy,
3. przebieg rozmów (przeglądarka sesji i tur z wyszukiwaniem).

Dashboard działa na serwerze `pepus-pc` tylko na `127.0.0.1` i jest otwierany
na Macu przez tunel SSH. Treść rozmów nie opuszcza tych dwóch maszyn.

## Poza zakresem

- panele GPU i zasobów (próbki nadal są zapisywane, ale bez paneli),
- jakikolwiek zapis do bazy z poziomu dashboardu,
- alerty, wielu użytkowników, wystawienie poza `127.0.0.1`,
- odtwarzanie nazw narzędzi dla historii (stare logi ich nie mają),
- import transkryptów `logs/*.md`.

## Stan wyjściowy (zweryfikowany 2026-09-13)

- Baza: `~/.local/share/pirx/pirx.sqlite`, `node:sqlite`, tryb WAL, schemat v2
  (`agent/src/storage/sqlite.ts`). Katalog `drwx------ pepus:pepus` (uid 1000).
- CLI (`pnpm start`) zapisuje sesje przez `SessionLogger`. TUI nie zapisuje nic:
  `tui/src/app.tsx` woła `agent.chat(value)` bez kontekstu tury.
- Domyślny tryb zapisu to `redacted` (bez treści).
- `logs/*.jsonl`: 34 pliki, 105 tur z 24.07–12.09.2026, modele gemma4:12b,
  qwen3:14b, gpt-oss:20b, lfm-32k. Każda linia ma `prompt`, `response`, `model`
  i metryki tury, ale nie ma nazw narzędzi.
- Docker 29.1.3 i Compose v5.1.0 działają bez `sudo`. W repo nie ma plików compose.
- sops 3.9.4 i age; prywatny klucz w `~/.config/sops/age/keys.txt`, publiczny
  odbiorca `age1rdg9cfj48m3j34x6w3wy7m0mpppn9azzns2v72k7mcpj4mw4ap3qj3gk2m`.
- Wtyczka `frser-sqlite-datasource` 4.0.6 (podpis community). Grafana 13.0.8.

## Część 1: zapis sesji z TUI

- `tui/src/index.tsx` tworzy `SessionLogger.create(config, agent.systemPrompt)`,
  przekazuje go do `App` i zamyka w `finally` przed `agent.close()`.
- Nowy moduł `tui/src/recorded-turn.ts` z funkcją `runRecordedTurn(agent, logger, prompt)`:
  `beginTurn` → `agent.chat(prompt, turn)` → `saveTurn(prompt, content, metrics, turn, messages)`.
  Gdy `chat` rzuci błąd: `failTurn(turn, error)` i ponowne rzucenie błędu.
- Błąd samego zapisu nie może zepsuć rozmowy: jeśli `saveTurn` rzuci, funkcja
  i tak zwraca turę razem z opisem błędu zapisu, a TUI pokazuje odpowiedź oraz
  komunikat „Nie zapisano tury: …”.
- `App.submit` używa `runRecordedTurn` zamiast bezpośredniego `agent.chat`.
- Domyślny `PIRX_STORAGE_MODE` zmienia się na `full_local`
  (`agent/src/config.ts`, test konfiguracji, `README.md`).
- Konsekwencja: TUI, tak jak CLI, zapisuje też `logs/session_*.md|jsonl`
  i próbkuje zasoby co sekundę.

## Część 2: jednorazowy import historii

- Moduł `agent/src/import-logs.ts` i skrypt `pnpm --filter @pirx/agent import:logs [katalog]`
  (domyślnie `<repo>/logs`).
- Każdy plik `session_*.jsonl` daje jeden `run_environment` i jedną sesję:
  status `completed`, `started_at` z pierwszej linii, `ended_at` z ostatniej.
  `run_environment.payload` zawiera model, `num_ctx`, temperaturę, strefę,
  plik i skrót promptu z pierwszej linii oraz `imported_from` (nazwa pliku).
- Każda poprawna linia daje turę: `sequence` = numer linii, status `completed`,
  `user_prompt` = `prompt`, `ended_at` = `timestamp` + `turn_duration_ms`,
  `payload` = `{ schema_version: 1, storage_mode: "full_local", response, metrics, imported: { source, line } }`,
  gdzie `metrics` to linia bez `prompt` i `response`.
- Identyfikatory są deterministyczne: UUID (układ wersji 5) z
  `sha256("pirx-import:session:<plik>")` dla sesji, `sha256("pirx-import:environment:<plik>")`
  dla środowiska i `sha256("pirx-import:turn:<plik>:<linia>")` dla tur.
- Cały plik importowany jest w jednej transakcji (nowa metoda `SqliteStore.transaction`),
  więc przerwany import nie zostawia sesji z brakującymi turami.
- Idempotencja: jeśli sesja o danym id już istnieje, plik jest pomijany
  (nowa metoda `SqliteStore.sessionExists(id)`).
- Linia, która nie jest poprawnym JSON-em, jest pomijana i zgłaszana w raporcie.
  Plik bez żadnej poprawnej linii jest pomijany.
- Raport na stdout: zaimportowane i pominięte pliki, liczba tur, pominięte linie.
- Znaczniki czasu zostają zapisane bez zmian (starsze mają offset `+02:00`,
  nowsze `Z`). Zapytania normalizują je przez `CAST(strftime('%s', …) AS INTEGER)`,
  które daje ten sam wynik dla obu formatów w SQLite 3.37.2 i 3.53.3.

## Część 3: Grafana

### Pliki (`Pirx/dashboard/`)

- `compose.yaml`
  - obraz `grafana/grafana:13.0.8`, `user: "1000:1000"`,
  - port `127.0.0.1:3000:3000`,
  - wtyczka `frser-sqlite-datasource` w wersji 4.0.6 instalowana przy starcie,
  - `GF_SECURITY_ADMIN_PASSWORD=${GF_SECURITY_ADMIN_PASSWORD:?}`,
    anonimowy dostęp wyłączony, raportowanie i sprawdzanie aktualizacji wyłączone,
  - wolumeny: katalog `${HOME}/.local/share/pirx` jako `/var/lib/pirx`
    (cały katalog, bo WAL potrzebuje plików `-wal` i `-shm`), nazwany wolumen
    na stan Grafany, `provisioning/` i `dashboards/` tylko do odczytu.
- `provisioning/datasources/pirx.yaml`: źródło `frser-sqlite-datasource`,
  `uid: pirx-sqlite`, ścieżka `/var/lib/pirx/pirx.sqlite`. Tylko do odczytu
  dzięki domyślnemu `_pragma=query_only(1)`, które wtyczka dodaje sama; bez `mode=ro`,
  bo odczyt w trybie WAL potrzebuje dostępu do pliku `-shm`.
- `provisioning/dashboards/pirx.yaml`: dostawca czytający `dashboards/*.json`
  do folderu „Pirx”, bez zapisu zmian z UI.
- `dashboards/pirx-models.json`, `dashboards/pirx-tools.json`,
  `dashboards/pirx-conversations.json`.
- `grafana.sops.env`: dotenv z `GF_SECURITY_ADMIN_PASSWORD`, zaszyfrowany w całości, w gicie.
- `up.sh`: sprawdza, że istnieje plik bazy i klucz age, potem
  `sops exec-env grafana.sops.env 'docker compose -f compose.yaml up -d'`.
  `down.sh` zatrzymuje kontener.
- `.sops.yaml` w katalogu głównym repo z regułą dla `Pirx/dashboard/grafana\.sops\.env$`
  i odbiorcą `age1rdg9…`.
- Hasło z `GF_SECURITY_ADMIN_PASSWORD` działa tylko przy pierwszym utworzeniu
  wolumenu Grafany. Późniejsza zmiana: `docker compose exec grafana grafana cli admin reset-admin-password`.
  Opis w `Pirx/dashboard/README.md` razem z komendą tunelu:
  `ssh -L 3000:127.0.0.1:3000 pepus@pepus-pc.taild372e3.ts.net`.

### Dashboardy

Wszystkie używają filtra czasu Grafany. Dashboard wydajności ma też zmienną `model`
(wiele wartości, domyślnie wszystkie). Operacje narzędzi nie zapisują modelu, więc
dashboard narzędzi jej nie ma.
Czas tury liczony jest z `turns.started_at` jako `CAST(strftime('%s', started_at) AS INTEGER)`;
wtyczka traktuje liczbę jako unix epoch. Zapytania nie używają funkcji nowszych niż
SQLite 3.37 (`json_extract` zamiast `->>`, bez `unixepoch()`), bo wersja SQLite
wbudowana we wtyczkę nie jest znana.

1. **Wydajność modeli** (źródło: `turns.payload_json` → `$.metrics`)
   - czas tury (`turn_duration_ms`) w czasie, osobno dla każdego modelu,
   - tokeny/s generacji i prefill,
   - tokeny wejścia i wyjścia na turę,
   - zajętość kontekstu: ostatni `context_estimates[].estimatedInputTokens` wobec `inputBudgetTokens`,
   - tabela porównania modeli: liczba tur, mediana i p95 czasu tury (funkcje okna),
     średnie tokeny/s, średnia liczba wywołań modelu i narzędzi.
2. **Narzędzia i błędy** (źródło: `operations` z `kind = 'mcp'`; tylko nowe sesje, bo import nie ma operacji)
   - liczba wywołań na narzędzie, odsetek błędów na narzędzie, mediana i p95 `wall_duration_ms`,
   - tabela ostatnich błędów narzędzi: czas, narzędzie, treść błędu,
   - nieudane tury i sesje z treścią błędu,
   - liczba tur zakończonych `tool_iteration_limit` albo `unexpected_loop_end`.
3. **Rozmowy**
   - zmienna `session` (czas startu, model, liczba tur, znacznik „import”) i pole tekstowe `search`,
   - tabela tur: czas, pytanie, odpowiedź, model, liczba narzędzi, czas tury;
     `search` filtruje `user_prompt` i odpowiedź w całej bazie, gdy nie wybrano sesji,
   - zmienna `turn` → tabela wiadomości tury z `messages` (kolejność, rola, narzędzie, treść)
     oraz tabela operacji tury (rodzaj, status, czas, błąd).
   - Ograniczenie Grafany: długie treści są ucięte w komórce, pełne w podglądzie komórki.

## Obsługa błędów

- Brak pliku bazy albo brak klucza age: `up.sh` kończy się czytelnym komunikatem.
- Błąd odczytu w Grafanie: panel pokazuje błąd źródła danych; kontener działa dalej.
- Błąd zapisu z TUI: rozmowa trwa, TUI pokazuje komunikat (część 1).
- Błędy importu: raport w części 2, bez przerywania całego importu.

## Testy

- `tui`: `runRecordedTurn` z fałszywym agentem i loggerem: sukces zapisuje turę;
  błąd `chat` wywołuje `failTurn` i rzuca dalej; błąd `saveTurn` zwraca turę z opisem błędu.
- `agent`: domyślny tryb `full_local`; `SqliteStore.sessionExists`; importer na plikach
  JSONL w katalogu tymczasowym (sesje, tury, payload, ponowny import bez duplikatów,
  zła linia pominięta i zgłoszona).
- `dashboard`: test `node:test`, który wyciąga wszystkie zapytania SQL z plików
  dashboardów, podstawia zmienne Grafany wartościami testowymi i wykonuje je na bazie
  tymczasowej wypełnionej importerem i jedną nagraną turą z operacjami. Każde zapytanie
  musi się wykonać, a panele szeregów czasowych muszą zwracać kolumnę czasu.
- Na żywo: `up.sh`, `/api/health`, zapytanie przez API źródła danych dla każdego panelu,
  obejrzenie dashboardów na Macu przez tunel.

## Ryzyka do sprawdzenia na początku planu

- Zgodność wtyczki 4.0.6 z Grafaną 13.0.8 i właściwa zmienna instalacji wtyczek.
- Odczyt bazy w trybie WAL z kontenera przy otwarciu tylko do odczytu.
- Wersja SQLite wbudowana we wtyczkę: jedno zapytanie diagnostyczne `select sqlite_version()`
  przez API źródła danych zaraz po starcie kontenera.
