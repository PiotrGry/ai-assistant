Obchód Pirxa (etap 2 epiku PiotrGry/ai-assistant#338): obserwujesz i możesz zlecić workerowi jedno bezpieczne zadanie.

Nie steruj daemonem (nie pauzuj, nie odblokowuj, nie zatrzymuj), nie komentuj, nie zamykaj i nie edytuj istniejących issue. Jedyne dozwolone zmiany to krok 5.

Sprawdź po kolei:
1. `zdrovena_production_errors` za ostatnie 24 h. Odróżnij błędy oczekiwane (np. 401 z anonimowych smoke testów, staging) od prawdziwych problemów aplikacji. Zwróć uwagę, co jest nowe albo narasta.
2. `github_issue_list` — otwarte issue w zdrovena-reconciliation: co jest gotowe dla workera, co wymaga doprecyzowania, co jest przestarzałe.
3. `pirx_orchestrator_status` i `pirx_task_history` — co robi daemon, czy coś utknęło albo czeka. Jeśli wcześniej zleciłeś zadanie (otwarte issue z etykietą `pirx-round`), sprawdź, co worker z nim zrobił.
4. `zdrovena_code_health` — najsłabiej pokryte testami pliki i znaczniki TODO/FIXME. Gdy w backlogu nie ma gotowej pracy, wybierz z tego 1–3 konkretne, małe zadania. Najpierw sprawdź `github_issue_list` z `state: all`, czy takie zadanie już nie istnieje (otwarte albo zamknięte).

5. Zlecenie — najwyżej jedno na obchód, tylko gdy wszystkie warunki są spełnione:
   - daemon działa, worker jest bezczynny, a w zdrovena nie ma otwartego issue z etykietą `pirx-round`;
   - zadanie zmienia wyłącznie testy (pliki w `tests/`), bez zmian w kodzie produkcyjnym;
   - takiego zadania nie ma jeszcze w repo.
   Inne zadania (zmiany w kodzie aplikacji, CI, infrastrukturze) tylko opisz w części B. Zleca je operator.

   Jak zlecić:
   a. `github_issue_create` z etykietą `pirx-round`. Treść dokładnie w tym układzie:
      ```
      ## Goal

      <jedno zdanie celu>

      ## Implementation scope

      - <plik do przetestowania i zakres linii z code health>
      - <co testować>
      - Only test files change; production code stays as it is.
      - Follow the existing layout and fixtures under `tests/`.

      ## Acceptance criteria

      - [ ] <kryterium 1>
      - [ ] <kryterium 2>
      ```
      Pisz po angielsku. Nie zgaduj szczegółów, których nie widziałeś w danych z narzędzi (np. nazw katalogów czy typów błędów).
   b. `pirx_work_submit` dla utworzonego issue: `repository: "PiotrGry/zdrovena-reconciliation"`, numer issue, `goal` i `acceptanceCriteria` znak w znak takie jak w treści issue, `priority: "P3"`, `risk: "Low"`, `area: "None"`, `workType: "Task"`, bez `queueOrder`, `operationId` w postaci `round-<numer issue>`.
   c. Sprawdź wynik `pirx_work_submit` (`accepted_pending`). Daemon sam doda zadanie do kolejki i uruchomi workera.

Na koniec napisz raport w czterech częściach:
A. Co widzisz — fakty z narzędzi, z liczbami i identyfikatorami.
B. Co byś zrobił i dlaczego — kolejność, a dla zadań, których nie zlecasz sam, gotowy opis (tytuł, `## Goal`, `## Implementation scope`, `## Acceptance criteria`).
C. Czego nie wiesz — jakiej informacji lub jakiego narzędzia zabrakło do lepszej decyzji.
D. Co zleciłeś — numer issue i identyfikator intake albo „nic” z powodem.
