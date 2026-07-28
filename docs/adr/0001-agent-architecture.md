# 0001 — Architektura procesu agentowego (agent + serwer narzędzi MCP)

- **Status:** Zaakceptowane
- **Data:** 2026-07-27

## Kontekst

POC asystentki Ada ma dziś dwa niepołączone ze sobą prototypy:

- `assistant.sh` (bash) — pętla czatu z Ollamą, wczytywanie `prompts/system.md`, logowanie sesji (transkrypt `.md` + metryki `.jsonl`), komendy `/help /clear /reload /stats /model /unload`. Nie wywołuje żadnych narzędzi.
- `Pirx/pirx-mcp` (Python) — działający serwer MCP (`server.py`, narzędzia `hello`, `system_info`) oraz klient testowy (`agent_test.py`), który już poprawnie realizuje pętlę: zapytanie do Ollamy z listą narzędzi → jeśli `tool_calls`, wywołanie przez sesję MCP → dołożenie wyniku do historii → ponowne zapytanie. Model wpisany na sztywno, brak system promptu, brak logowania.

Benchmark modeli lokalnych (`bench/`) wykazał, że `hf.co/google/gemma-4-12B-it-qat-q4_0-gguf` ma realny, potwierdzony testem tool calling i dorównuje najlepszemu modelowi w rozumowaniu (13,5/15 w serii zadań realnych), więc krok 2 mapy drogowej (wywoływanie narzędzi) jest gotowy do realizacji. Docelowo POC ma zostać przepisane na TypeScript. Potrzebna jest decyzja, czym zastąpić dzisiejszy podział na dwa nieskomunikowane prototypy — jednym, spójnym procesem docelowym.

## Decyzja

Docelowy proces agentowy powstaje **od razu w TypeScript**, jako **dwa procesy w jednym repozytorium**, komunikujące się protokołem **MCP po stdio** — czyli ten sam wzorzec, co dziś w Pythonie (`agent_test.py` + `pirx-mcp`), przeniesiony na docelowy stos.

### Struktura

```
Pirx/
  agent/         (nowy, TS)   — klient: pętla czatu, klient Ollama, klient MCP, logi
  mcp-server/    (nowy, TS)   — serwer MCP: narzędzia (hello, system_info; później kalendarz)
  pirx-mcp/      (istniejący, Python) — zostaje nietknięty, jako referencja
```

`agent` wczytuje `prompts/system.md`, rozmawia z Ollamą (domyślnie `hf.co/google/gemma-4-12B-it-qat-q4_0-gguf`, konfigurowalne przez `OLLAMA_MODEL`), spawnuje `mcp-server` jako podproces przez `StdioClientTransport` z `@modelcontextprotocol/sdk`, i loguje sesję dwoma plikami — transkrypt `.md` i metryki `.jsonl` — dokładnie jak dziś `assistant.sh`.

`mcp-server` to port `server.py` na TS SDK (`McpServer` + `StdioServerTransport`), na start z tymi samymi dwoma narzędziami (`hello`, `system_info`); narzędzia kalendarza z kroku 3 mapy drogowej dochodzą tu później.

### Przepływ jednej tury rozmowy

1. Użytkownik wpisuje wiadomość; `agent` dokłada ją do historii.
2. `agent` woła `ollama.chat()` z pełną listą narzędzi pobraną wcześniej przez `session.list_tools()`.
3. Jeśli odpowiedź zawiera `tool_calls` — dla każdego wywołania: `ClientSession.call_tool()` do `mcp-server`, wynik dołożony jako wiadomość `role: tool`, powrót do kroku 2. Pętla ma **twardy limit 8 iteracji** jako jedyny mechanizm bezpieczeństwa — po przekroczeniu `agent` przerywa i informuje użytkownika, że nie udało się uzyskać finalnej odpowiedzi.
4. Jeśli brak `tool_calls` — to finalna odpowiedź: wypisanie, zapis transkryptu, zapis metryk (te same pola co dziś: tokeny, czas, `gpu_before`/`gpu_after`).

### Obsługa błędów

- `mcp-server` nie odpala się → `agent` kończy z czytelnym komunikatem przed pierwszą wiadomością.
- `mcp-server` pada w trakcie rozmowy → `agent` łapie błąd przy najbliższym `call_tool()`, informuje użytkownika, **nie kończy sesji** — rozmowa toczy się dalej bez narzędzi.
- Ollama nieosiągalna → sprawdzenie na starcie (`/api/tags`), czytelny komunikat, jak dziś.
- Narzędzie zwraca błąd → wynik z błędem wraca do modelu jako zwykła treść `role: tool`; model dostaje szansę zareagować, pętla się nie przerywa.

### Konfiguracja

Zmienne środowiskowe identyczne z dzisiejszymi w `assistant.sh`: `OLLAMA_MODEL`, `OLLAMA_NUM_CTX`, `OLLAMA_KEEP_ALIVE`, `OLLAMA_BASE_URL`. Bez pliku konfiguracyjnego, bez trybów.

### Weryfikacja

Manualny test end-to-end: start procesu, `list_tools()` pokazuje `hello`/`system_info`, wywołanie obu przez rozmowę, potwierdzenie że wynik trafia do modelu i jest użyty w odpowiedzi. Dodatkowo: wymuszony restart `mcp-server` w trakcie rozmowy — `agent` musi przeżyć i zgłosić brak narzędzi, nie ubić sesji.

## Alternatywy rozważone i odrzucone

- **Zwykłe funkcje w procesie, bez MCP** — najmniej ruchomych części, ale odrzucone: użytkownik chce zachować protokół MCP, żeby zostawić otwartą możliwość podłączenia gotowych, zewnętrznych serwerów MCP bez pisania własnych.
- **Jeden proces z transportem MCP in-memory** (klient i serwer w tym samym procesie Node) — mniej kodu obsługi podprocesu, ale odrzucone na rzecz wierności dzisiejszemu, już sprawdzonemu wzorcowi dwóch procesów; łatwiejsze też podłączenie zewnętrznego serwera MCP w przyszłości (z natury działa jako osobny proces).
- **Serwer MCP pozostaje w Pythonie** (MCP jest z założenia międzyjęzykowy, klient TS mógłby rozmawiać z serwerem Python bez zmian) — odrzucone na rzecz jednego języka w całym stosie, żeby nie utrzymywać dwóch runtime'ów (uv + node) długoterminowo.
- **Pozostanie przy Pythonie** dla całego procesu docelowego — odrzucone, bo user i tak planuje przejście na TypeScript; unika się podwójnego przepisywania.
- **Pozostanie w bash** (dodanie wywoływania narzędzi do `assistant.sh` przez curl+jq) — odrzucone: pętla narzędziowa w bashu szybko robi się nieczytelna, a projekt i tak zmierza w stronę TS.

## Konsekwencje

- Dwa runtime'y współistnieją w repo na czas przejściowy: `pirx-mcp` (Python, nietknięty) obok nowych `agent`/`mcp-server` (TS) — to świadomy koszt, nie dług do natychmiastowej spłaty.
- `assistant.sh` i `start.sh` zostają nietknięte jako fallback — prosty czat bez narzędzi nadal dostępny równolegle.
- Limit iteracji pętli tool-calling (krok 3 przepływu) to jedyny mechanizm bezpieczeństwa w tym ADR — brak retry z backoffem, brak circuit breakera; jeśli w praktyce okaże się to za mało, to temat na kolejny ADR, nie coś do przewidywania teraz.

## Jawnie poza zakresem

- Brak autonomicznej pętli — agent nie działa bez człowieka w środku, nie planuje wielu kroków naprzód bez pytania.
- Brak pamięci długoterminowej między sesjami — historia żyje tylko w ramach jednej rozmowy.
- Brak UI webowego — nadal terminal.
- Brak frameworka agentowego (LangChain itp.) — własna, krótka pętla, jak w `agent_test.py`.
