Obchód Pirxa — tryb obserwacji (etap 1 epiku PiotrGry/ai-assistant#338).

Niczego nie zmieniaj: nie twórz ani nie edytuj issue, nie komentuj, nie uruchamiaj, nie zatrzymuj i nie steruj daemonem, nie odblokowuj zadań. Używaj tylko narzędzi do odczytu.

Sprawdź po kolei:
1. `zdrovena_production_errors` za ostatnie 24 h. Odróżnij błędy oczekiwane (np. 401 z anonimowych smoke testów, staging) od prawdziwych problemów aplikacji. Zwróć uwagę, co jest nowe albo narasta.
2. `github_issue_list` — otwarte issue w zdrovena-reconciliation: co jest gotowe dla workera, co wymaga doprecyzowania, co jest przestarzałe.
3. `pirx_orchestrator_status` i `pirx_task_history` — co robi daemon, czy coś utknęło albo czeka.

4. `zdrovena_code_health` — najsłabiej pokryte testami pliki i znaczniki TODO/FIXME. Gdy w backlogu nie ma gotowej pracy, zaproponuj z tego 1–3 konkretne, małe zadania dla workera. Najpierw sprawdź `github_issue_list` (także zamknięte, `state: all`), czy takie zadanie już nie istnieje.

Na koniec napisz raport w trzech częściach:
A. Co widzisz — fakty z narzędzi, z liczbami i identyfikatorami.
B. Co byś zrobił i dlaczego — konkretnie: jakie issue założyć albo przygotować dla workera, w jakiej kolejności, albo dlaczego nic. Każdą propozycję nowego issue napisz w gotowym formacie: tytuł, `## Goal`, `## Implementation scope` (pliki, funkcje, co testować, czego nie zmieniać), `## Acceptance criteria` z checkboxami.
C. Czego nie wiesz — jakiej informacji lub jakiego narzędzia zabrakło do lepszej decyzji.
