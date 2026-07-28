# Benchmark modeli lokalnych

Benchmark mierzy zachowanie tekstowego asystenta bez narzędzi i bez MCP.
Służy do porównania jakości, stabilności i wydajności konkretnych konfiguracji
modeli.

## Zestawy

- `cases.jsonl` — pełny zestaw 64 przypadków;
- `contested_cases.jsonl` — 10 unikalnych trudnych przypadków przeznaczonych
  do wielokrotnych prób;
- `grades.jsonl` — ręczne oceny odpowiedzi;
- `results/` — surowe odpowiedzi i metryki.

Pełny zestaw obejmuje prawdomówność, brakujące informacje, planowanie, logikę,
redakcję, statystykę, DevOps/coding, analizę kontekstu oraz rozmowy wieloturowe.

## Porównanie kontrolowane

Jeden przebieg całego zestawu, temperatura 0 i wspólny seed:

```bash
OLLAMA_TEMPERATURE=0 \
BENCH_REPEATS=1 \
BENCH_SEED=42 \
./bench/run.sh model-12b model-32b model-70b
```

Każdy przypadek startuje z czystą historią. Modele otrzymują ten sam prompt,
kontekst i ustawienia. Runner wykonuje rozgrzewkę i domyślnie zwalnia model
przed załadowaniem kolejnego.

W każdym przebiegu używaj tej samej maszyny i wersji Ollamy. Jeżeli runner
działa na innej maszynie niż serwer Ollamy, ustaw stabilny identyfikator
serwera:

```bash
BENCH_MACHINE_ID=gpu-rental-01 ./bench/run.sh model-32b
```

Po rozgrzewce runner odczytuje `/api/ps` i zapisuje:

- całkowity rozmiar załadowanego modelu,
- część umieszczoną w VRAM,
- liczbę bajtów pozostawionych w RAM,
- procent modelu na GPU,
- wykrycie CPU offloadu,
- kontekst, z którym model został załadowany.

Jeżeli `cpu_offload_detected=true`, wynik szybkości nie powinien być
porównywany z przebiegiem wykonanym w całości na GPU.

## Ground 0 — wybór modelu na obecny sprzęt

Zanim porównamy większe modele, uruchamiamy ponownie dwie konfiguracje, które
już działają lokalnie:

| Rola | Model | Thinking |
|---|---|---:|
| `G0-Q` | `qwen3:14b` | `true` |
| `G0-G` | `hf.co/google/gemma-4-12B-it-qat-q4_0-gguf` | `false` |

To porównanie konfiguracji wdrożeniowych, a nie czysty test wpływu rozmiaru.
Odpowiada na pytanie, który model ustawić obecnie. Osobna seria Qwen 14B/32B
z tym samym quantem i thinkingiem odpowie później na pytanie o wpływ skali.

Pełny Ground 0 — po jednym przebiegu 64 przypadków oraz pięć prób dziesięciu
trudnych przypadków — uruchamia:

```bash
./bench/run-ground-zero.sh
```

Nie łączymy wcześniejszych 7 × 5 wyników z nowym wynikiem liczbowym. Są
wartościowym dowodem historycznym, ale nowy Ground 0 używa rozszerzonego
zestawu 10 przypadków, jawnych seedów i bieżących metadanych środowiska.

## Test stabilności

Pięć prób dziesięciu trudnych przypadków:

```bash
BENCH_CASES="$PWD/bench/contested_cases.jsonl" \
OLLAMA_TEMPERATURE=0.3 \
BENCH_REPEATS=5 \
BENCH_SEED=100 \
./bench/run.sh model-12b model-32b model-70b
```

Runner sam tworzy powtórzenia. W `contested_cases.jsonl` każdy przypadek
występuje tylko raz.

## Ocena

Oceń każdy plik wynikowy:

```bash
./bench/grade.sh bench/results/model_20260728_120000.jsonl
```

Skala:

- `pass` = 2 punkty,
- `partial` = 1 punkt,
- `fail` = 0 punktów.

Przy odpowiedzi częściowej lub błędnej oceniający osobno oznacza
`critical_failure`. Raport pokazuje liczbę takich błędów łącznie i per
kategoria.

Ocena jest identyfikowana przez `run_id + model + case_id + repeat`, dlatego
można niezależnie oceniać kolejne przebiegi i seedy.

## Raport

Wybrane pliki:

```bash
./bench/report.sh bench/results/model-a_*.jsonl bench/results/model-b_*.jsonl
```

Wszystkie wyniki:

```bash
./bench/report.sh
```

Raport rozdziela przebiegi oraz konfiguracje, pokazuje kompletność, p50/p95
pełnego czasu odpowiedzi, wydajność, wyniki ręczne per kategoria i stabilność
ocenionych powtórzeń.

Starsze pliki nie zawierają oczekiwanej liczby rekordów, dlatego ich pole
`kompletny` w raporcie ma wartość `null`.

## Najważniejsze zmienne

| Zmienna | Domyślnie | Znaczenie |
|---|---:|---|
| `BENCH_CASES` | `bench/cases.jsonl` | plik przypadków |
| `BENCH_REPEATS` | `1` | liczba prób każdego przypadku |
| `BENCH_SEED` | `42` | seed pierwszej próby; kolejne zwiększają go o 1 |
| `BENCH_MACHINE_ID` | nazwa hosta runnera | stabilny identyfikator maszyny z Ollamą |
| `BENCH_THINK` | `false` | tryb thinking |
| `GROUND_ZERO_QWEN_MODEL` | `qwen3:14b` | model Qwen w Ground 0 |
| `GROUND_ZERO_GEMMA_MODEL` | Gemma 4 12B QAT Q4_0 z Hugging Face | model Gemma w Ground 0 |
| `BENCH_RESULTS_DIR` | `bench/results` | katalog wyników |
| `BENCH_ROOT` | katalog projektu | główny katalog projektu |
| `OLLAMA_TEMPERATURE` | `0.3` | temperatura |
| `OLLAMA_NUM_CTX` | `8192` | rozmiar kontekstu |
| `OLLAMA_KEEP_ALIVE` | `10m` | czas utrzymania modelu |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | adres Ollamy |

Wynik zapisuje także digest i quant modelu, wersję Ollamy, stan umieszczenia
modelu z `/api/ps` oraz — jeśli dostępne przez `nvidia-smi` — nazwę GPU,
sterownik i całkowitą pamięć VRAM. Raport sprawdza, czy wybrane wyniki mają
wspólny `machine_id` i wersję Ollamy.
