# Pipeline benchmarku RunPod

Pipeline automatyzuje:

1. utworzenie jednego Poda przez oficjalne REST API RunPod;
2. oczekiwanie na publiczny SSH;
3. przesłanie wyłącznie plików benchmarku, bez `.git`, `.venv` i wyników;
4. instalację/uruchomienie Ollamy;
5. kontrolę obecności modeli na istniejącym Network Volume;
6. uruchomienie benchmarku w odłączonej sesji `tmux`;
7. sprawdzenie kompletności wszystkich wyników;
8. utworzenie raportu oraz archiwum;
9. pobranie archiwum i weryfikację SHA-256.

Pipeline nie usuwa Poda automatycznie. `terminate` jest osobną operacją,
możliwą domyślnie dopiero po prawidłowym pobraniu wyników.

## Jednorazowa konfiguracja

Pipeline można uruchomić bezpośrednio z macOS albo Linuksa. Dzięki temu nie
trzeba pośrednio przenosić wyników przez drugą maszynę. Wykonaj w bieżącej
kopii repozytorium:

```bash
cd /ścieżka/do/ai-assistant
cp bench/cloud/runpod.env.example bench/cloud/runpod.env
chmod 600 bench/cloud/runpod.env
```

Uzupełnij w `bench/cloud/runpod.env`:

- `RUNPOD_API_KEY`;
- `RUNPOD_NETWORK_VOLUME_ID`;
- `RUNPOD_SSH_KEY`.

Klucz API można utworzyć w ustawieniach konta RunPod. Klucz publiczny
odpowiadający `RUNPOD_SSH_KEY` musi być dodany do konta RunPod.

Jeżeli nie znasz ID woluminu, po ustawieniu samego API key uruchom:

```bash
./bench/cloud/runpod-pipeline.sh volumes
```

## Pełny automatyczny przebieg

Najpierw pokaż plan i wykonaj kontrolę:

```bash
./bench/cloud/runpod-pipeline.sh plan
./bench/cloud/runpod-pipeline.sh doctor
```

Następnie cały przebieg uruchamia jedno polecenie:

```bash
./bench/cloud/runpod-pipeline.sh all
```

Polecenie czeka na benchmark i pobiera zweryfikowane archiwum do:

```text
bench/cloud-results/<run-id>/
```

`all` jest wznawialne: po przerwaniu lokalnego terminala można uruchomić je
ponownie, a pipeline przejdzie do pierwszego niezakończonego etapu. Benchmark
działa niezależnie w `tmux`. Dostępne są też polecenia szczegółowe:

```bash
./bench/cloud/runpod-pipeline.sh status
./bench/cloud/runpod-pipeline.sh logs
./bench/cloud/runpod-pipeline.sh wait
./bench/cloud/runpod-pipeline.sh collect
```

Po pobraniu wyników:

```bash
./bench/cloud/runpod-pipeline.sh terminate
```

## Istniejący Pod

Jeżeli Pod został już utworzony w panelu:

```bash
./bench/cloud/runpod-pipeline.sh use-pod POD_ID
./bench/cloud/runpod-pipeline.sh prepare
./bench/cloud/runpod-pipeline.sh start
./bench/cloud/runpod-pipeline.sh wait
./bench/cloud/runpod-pipeline.sh collect
./bench/cloud/runpod-pipeline.sh terminate
```

## Bezpieczniki

- Brakujące modele domyślnie zatrzymują pipeline. Aby świadomie pozwolić na
  ich pobieranie, ustaw `RUNPOD_PULL_MISSING_MODELS=true`.
- `terminate` odmawia usunięcia Poda przed pobraniem wyników.
- Awaryjne usunięcie wymaga `terminate --force`.
- `terminate --yes` wyłącza tylko interaktywne potwierdzenie; nie omija
  kontroli pobrania.
- Klucz API, stan pipeline i wyniki chmurowe są ignorowane przez Git.

## Co można zmienić

Modele i wszystkie stałe benchmarku są jawnie zapisane w
`bench/cloud/runpod.env`. Domyślna lista finalistów:

```text
gemma4:31b-it-q4_K_M
qwen3.6:35b-a3b-q4_K_M
qwen3.5:122b-a10b-q4_K_M
qwen3:32b-q4_K_M
qwen3:14b-q4_K_M
```

Domyślna konfiguracja to `think=true`, temperatura `0`, context `8192`,
`num_predict=4096`, seed `42` i jedno powtórzenie pełnych 64 przypadków.
