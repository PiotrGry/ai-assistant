# 0002 — Ustrukturyzowany JSON (format/JSON Schema) dla propozycji wymagających potwierdzenia

- **Status:** Zaproponowane (dotyczy przyszłego kroku 3/4 mapy drogowej — kalendarz; nie zmienia ADR 0001)
- **Data:** 2026-07-27

## Kontekst

ADR 0001 ustala wzorzec: model proponuje akcję (np. nowe wydarzenie w kalendarzu) → propozycja jest pokazywana użytkownikowi → po potwierdzeniu dopiero następuje wywołanie narzędzia (`calendar_create_event`). Problem, który pojawi się przy pisaniu tego kroku: propozycja modelu w naturalnym przebiegu rozmowy przychodzi jako **proza** („Mogę zaproponować spotkanie na środę 10:00–11:00 pod tytułem…"), a nie jako gotowa struktura. Żeby przejść od tej prozy do realnego wywołania narzędzia, potrzebny byłby dodatkowy krok odczytania z niej `{title, start, end}` — regexem albo kolejnym zapytaniem do modelu. To wprowadza kruchy szew dokładnie w miejscu, gdzie błąd jest najdroższy: między tym, co pokazano użytkownikowi do potwierdzenia, a tym, co faktycznie trafi do kalendarza.

Ollama wspiera pole `format` w `/api/chat` (wartość `"json"` albo pełny JSON Schema), które wymusza, że odpowiedź modelu jest poprawnym JSON-em zgodnym ze schematem — niezależnie od mechanizmu `tools`/`tool_calls`.

## Decyzja

Tura odpowiedzialna za **wygenerowanie propozycji do potwierdzenia** (nie samo wywołanie narzędzia — to zostaje przez `tool_calls` jak w ADR 0001) woła `/api/chat` z `format` ustawionym na JSON Schema **identyczny z argumentami docelowego narzędzia** (np. schemat wejścia `calendar_create_event`). Model zwraca strukturę, nie wolny tekst. `agent` formatuje tę strukturę do czytelnej postaci na potrzeby potwierdzenia przez użytkownika, a po „tak" **ten sam obiekt** (bez ponownego parsowania) staje się argumentem realnego wywołania narzędzia.

Zasięg: tylko tury typu „zaproponuj coś do potwierdzenia przed zapisem". Zwykłe odpowiedzi konwersacyjne i wywołania narzędzi przez `tools` zostają bez zmian.

## Alternatywy rozważone i odrzucone

- **Parsowanie prozy modelu** (regex/heurystyki) — odrzucone: kruche, błąd trudny do wykrycia przed zapisem.
- **Drugie zapytanie do modelu** proszące o „przepisz powyższą propozycję jako JSON" — odrzucone: dodaje latencję i kolejny punkt, w którym model może się pomylić (np. inaczej zinterpretować własną wcześniejszą propozycję), bez realnej korzyści względem wymuszenia formatu od razu.

## Konsekwencje

- Nie zmienia struktury z ADR 0001 (agent + mcp-server przez stdio) — to jest szczegół pojedynczej tury, nie architektury procesu.
- Schemat JSON dla tury „propozycja" musi być zsynchronizowany ze schematem wejściowym odpowiadającego mu narzędzia MCP — przy zmianie jednego trzeba pamiętać o drugim (brak automatycznej walidacji tej zgodności na dziś; jeśli okaże się to problemem w praktyce, temat na kolejny ADR).
- Do zastosowania dopiero przy pisaniu planu implementacji kroku 3/4 (kalendarz) — nie wcześniej, bo `hello`/`system_info` tego nie potrzebują.
