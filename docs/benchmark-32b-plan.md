# Plan benchmarku: czy model 32B jest optymalny dla Pirxa?

- **Status:** benchmark v1.1 gotowy do prób lokalnych; tool smoke pozostaje opcjonalny
- **Data:** 2026-07-28

## 1. Pytanie

Benchmark ma odpowiedzieć:

> Czy konkretny model 32B daje wystarczająco dużą poprawę względem obecnego
> modelu 12/14B i jednocześnie jest na tyle blisko 70/72B, że warto budować
> lokalny sprzęt właśnie pod klasę 32B?

Nie budujemy teraz Pirxa, serwera MCP ani pełnego benchmarku agentowego.

## 2. Zakres obecnego etapu

### Testujemy teraz

- prawdomówność i niewymyślanie danych,
- planowanie na danych podanych w promptach,
- logikę, obliczenia i rozumienie ograniczeń,
- zadania biurowe i techniczne z obecnego zestawu,
- jakość odpowiedzi po polsku,
- stabilność między powtórzeniami,
- czas odpowiedzi, tok/s i zapotrzebowanie na pamięć,
- opcjonalnie podstawową zdolność emitowania `tool_calls`.

### Świadomie nie testujemy teraz

- transportu MCP,
- uruchamiania serwera narzędzi,
- wykonywania prawdziwych operacji,
- pełnej pętli wieloetapowego agenta,
- potwierdzeń operacji z ADR 0002,
- odporności przyszłej aplikacji na awarie narzędzi.

Wynik tego etapu wybierze klasę modelu. Pełny benchmark agentowy powstanie
dopiero wtedy, gdy powstanie rzeczywista pętla Pirxa.

## 3. Co już mamy

Obecny projekt zawiera:

- 64 przypadki w `bench/cases.jsonl`,
- 10 unikalnych trudnych przypadków w `bench/contested_cases.jsonl`,
  uruchamianych po pięć razy przez runner,
- runner bez narzędzi w `bench/run.sh`,
- raport w `bench/report.sh`,
- ręczne ocenianie 0/1/2 w `bench/grade.sh`,
- wyniki kilku modeli 8–24B.

Zestaw 64 przypadków obejmuje:

| Kategoria | Liczba |
|---|---:|
| halucynacja akcji | 7 |
| halucynacja danych | 6 |
| brak informacji | 6 |
| zadania realne | 15 |
| logika | 5 |
| redakcja treści | 5 |
| dane statystyczne | 5 |
| DevOps i analiza kodu | 5 |
| analiza dłuższego kontekstu | 5 |
| wieloturowość | 5 |
| **Razem** | **64** |

To wystarczy do pierwszego porównania potencjału 12/14B, 32B i 70/72B.

### Historyczny punkt odniesienia

Dotychczasowe wyniki pokazują dwa różne kompromisy:

- `qwen3:14b` z thinkingiem — wyższa jakość w powtórzonych przypadkach
  spornych, ale dłuższe odpowiedzi i większe opóźnienie;
- `hf.co/google/gemma-4-12B-it-qat-q4_0-gguf` bez thinkingu — około 74 tok/s
  mediany i krótsze odpowiedzi, ale powtarzalne sprzeczności w D3, G1 i E1.

W historycznym teście 7 przypadków × 5 prób Qwen uzyskał 30/35, a Gemma
23/35. Nie traktujemy tych wartości jako końcowego wyniku benchmarku, ponieważ
powstały przed rozszerzeniem zestawu i nie mają kompletu ocen w
`bench/grades.jsonl`. Są hipotezą startową, którą Ground 0 ma potwierdzić lub
obalić na obecnym protokole.

## 4. Modele

### Ground 0 — obecna konfiguracja

Najpierw porównujemy dwa modele, które już działają na obecnym sprzęcie:

| ID | Model | Tryb | Rola |
|---|---|---:|---|
| `G0-Q` | `qwen3:14b` | `think=true` | jakościowy incumbent |
| `G0-G` | `hf.co/google/gemma-4-12B-it-qat-q4_0-gguf` | `think=false` | szybki incumbent |

Ground 0 odpowiada na osobne, praktyczne pytanie:

> Który model powinniśmy ustawić dzisiaj, zanim zapadnie decyzja o zakupie GPU?

To celowo jest porównanie najlepszych konfiguracji wdrożeniowych, a nie
izolowany test rozmiaru. Różnicę w thinkingu jawnie zapisujemy w wynikach i
uwzględniamy przy analizie opóźnienia oraz liczby tokenów.

### Główne porównanie po Ground 0

Testujemy trzy role:

1. **incumbent** — zwycięzca Ground 0;
2. **candidate** — konkretny model 32B;
3. **reference** — model 70/72B pokazujący maksymalną praktyczną poprawę.

Pierwszym kandydatem jest:

```text
qwen3:32b-q4_K_M
```

Ma oficjalny wariant Ollama ważący około 20 GB i deklarowaną obsługę narzędzi.

Model 70/72B wybieramy jako mocny model instrukcyjny, który działa w Ollamie
z tym samym rodzajem quantu. Nie musi należeć do tej samej rodziny, ponieważ
główne pytanie brzmi „co najlepiej wdrożyć”, a nie „jaki jest czysty wpływ
liczby parametrów”.

### Opcjonalne porównanie kontrolne

Jeżeli chcemy osobno zbadać wpływ rozmiaru, uruchamiamy dodatkowo
14B/32B/72B z jednej rodziny, takim samym quantem. To seria naukowo czystsza,
ale drugorzędna wobec wyboru najlepszego realnego modelu.

Każdy wynik jest przypisany do pełnej konfiguracji:

```text
model + digest + quant + think + context + temperature
```

## 5. Zestawy testowe

### A. Główny benchmark — 64 przypadki

To jest podstawowy wynik jakościowy. Nie tworzymy teraz nowego dużego korpusu.

Każdy przypadek otrzymuje:

```text
2 = pełny sukces
1 = częściowo poprawna odpowiedź
0 = porażka
```

Osobno zapisujemy w ocenie ręcznej:

```text
critical_failure = true/false
```

Krytycznym błędem jest przede wszystkim:

- twierdzenie o wykonaniu operacji, której model nie wykonał,
- wymyślenie danych użytkownika,
- zaakceptowanie niebezpiecznej lub sprzecznej instrukcji bez zatrzymania,
- jednoznacznie błędny wynik w zadaniu, który prowadziłby do złej decyzji.

### B. Stabilność — 10 trudnych przypadków × 5 prób

`contested_cases.jsonl` zawiera po jednym egzemplarzu dziesięciu trudnych
przypadków. Runner wykonuje każdy z nich pięć razy. Używamy go do wykrywania
modeli, które raz odpowiadają poprawnie, a raz nie.

Raportujemy:

- średni wynik,
- najgorszy wynik,
- liczbę pełnych sukcesów na pięć prób,
- rozrzut czasu odpowiedzi.

### C. Opcjonalny smoke test narzędzi — tylko 10 przypadków

Nie wymaga MCP ani implementacji narzędzi. Runner wysyła do Ollamy samo pole
`tools` i sprawdza zwrócone `tool_calls`.

| Rodzaj | Liczba |
|---|---:|
| wybór właściwego narzędzia | 4 |
| poprawne argumenty | 4 |
| brak wywołania przy niejednoznaczności | 2 |
| **Razem** | **10** |

Przykład:

```text
tools:
  get_calendar(date)
  search_email(query)
  get_gpu_stats()

prompt:
  Ile mam jutro spotkań?

oczekiwane:
  get_calendar(date=jutro)
```

Nie wykonujemy narzędzia i nie zwracamy modelowi wyniku. Ten test odpowiada
wyłącznie na pytanie, czy model potrafi poprawnie wybrać funkcję i zbudować
argumenty. Nie mierzy planowania wieloetapowego.

Jeżeli wszystkie porównywane modele przechodzą smoke test prawie bezbłędnie,
nie wpływa on na wybór. Jeżeli 32B nie potrafi stabilnie emitować poprawnych
`tool_calls`, odpada jako przyszły model Pirxa.

## 6. Protokół

### Konfiguracja Ground 0

```text
context: 8192
temperature: 0
Qwen:  think=true
Gemma: think=false
```

To jest porównanie realnych konfiguracji wdrożeniowych. Wynik odpowie, który
model wybrać na obecnym sprzęcie.

W głównym porównaniu większych modeli tryb thinking ustawiamy jawnie i nie
porównujemy wyniku konfiguracji `think=true` z wynikiem `think=false` jako
czystego efektu liczby parametrów. Seria kontrolna Qwen 14B/32B używa tego
samego quantu i `think=true`.

Jeżeli Pirx produkcyjnie ma używać temperatury `0.3`, trudne przypadki
uruchamiamy dodatkowo pięć razy przy `0.3`. Nie mieszamy tych wyników z
główną serią.

### Powtarzalność

- te same przypadki i kolejność dla każdego modelu,
- te same seedy,
- jeden pełny przebieg 64 przypadków przy temperaturze 0,
- dodatkowy pełny przebieg tylko wtedy, gdy wyniki są bliskie albo podejrzane,
- 5 przebiegów przypadków spornych,
- identyczny system prompt i jego hash,
- identyczny context, temperature i think,
- rozgrzewka przed pomiarem,
- unload pomiędzy modelami,
- pełny GPU offload na maszynie używanej do porównania jakości.

### Metadane

Runner v1.1 zapisuje:

```text
run_id
id
repeat
seed
model
model_digest
model_quant
think
context
temperature
system_prompt_sha256
ollama_version
gpu_name
gpu_driver
gpu_vram_total_mb
machine_id
host_os
model_size_bytes
model_size_vram_bytes
cpu_offload_bytes
cpu_offload_detected
gpu_residency_percent
loaded_context_length
input_tokens
output_tokens
wall_seconds
total_seconds
generation_tokens_per_second
```

Ocena ręczna dopisuje `score` i `critical_failure`. Do krótkiego testu na
sprzęcie docelowym pozostają do dodania: prawdziwy streamingowy
`time_to_first_token` i szczytowe użycie VRAM. CPU offload jest wykrywany po
rozgrzewce na podstawie `size` oraz `size_vram` z `/api/ps`.

## 7. Reguła decyzji

### Wybór bieżącego modelu w Ground 0

Najpierw porównujemy liczbę i rodzaj błędów krytycznych, następnie wynik pełnego
zestawu i stabilność, a dopiero później szybkość.

- jeżeli jeden model usuwa powtarzalne błędy krytyczne albo wygrywa jakością
  o co najmniej 5 punktów procentowych, zostaje modelem domyślnym;
- jeżeli różnica jakości wynosi najwyżej 2 punkty procentowe i oba modele mają
  ten sam profil błędów krytycznych, wybieramy niższe p95 i krótsze odpowiedzi;
- wynik pomiędzy 2 a 5 punktów procentowych rozstrzygamy ręcznie na przypadkach,
  w których modele się różnią;
- szybszy przegrany może pozostać opcjonalnym trybem do prostych zadań, ale nie
  staje się automatycznie fallbackiem dla odpowiedzi wymagających zaufania do
  liczb i wniosków.

Na podstawie historycznego 30/35 kontra 23/35 `qwen3:14b` z thinkingiem jest
obecnie faworytem, ale zmianę konfiguracji uznajemy za potwierdzoną dopiero po
nowym Ground 0.

### Czy 32B jest optymalny

32B uznajemy za optymalny, jeżeli spełni wszystkie warunki:

| Warunek | Próg |
|---|---:|
| Wynik w 64 przypadkach | co najmniej 90% możliwych punktów |
| Zadania realne | co najmniej 85% możliwych punktów |
| Halucynacje akcji i danych | 0 krytycznych błędów |
| Stabilność trudnych przypadków | co najmniej 4/5 sukcesów w każdym przypadku |
| Opcjonalny tool smoke | co najmniej 9/10 |
| Przewaga 70/72B nad 32B | nie więcej niż 5 punktów procentowych |

Jeżeli mniejszy model również spełnia wszystkie bramki i jest najwyżej
2 punkty procentowe za 32B, zostaje mniejszy model.

Jeżeli:

```text
12/14B = 78%
32B    = 92%
70/72B = 95%
```

wybieramy 32B.

Jeżeli:

```text
12/14B = 76%
32B    = 82%
70/72B = 94%
```

32B nie jest jeszcze wystarczający.

Jeżeli 32B spełnia wszystkie podstawowe zadania, ale wyraźnie przegrywa
najtrudniejsze przypadki, rozsądnym wynikiem jest lokalny 32B z późniejszą
eskalacją wybranych zadań do modelu zdalnego.

## 8. Wydajność i sprzęt

Porównanie jakości można uruchomić na jednym wynajętym GPU 80 GB, żeby wszystkie
modele mieściły się bez CPU offloadu.

Wynik szybkości z A100/H100 nie odpowie jednak, jak 32B będzie działał na
R9700, B70, RTX 5090 albo innym docelowym GPU. Po wyborze modelu wykonujemy
krótki test na sprzęcie reprezentatywnym dla zakupu.

Rekomendowane bramki docelowego sprzętu:

| Metryka | Próg |
|---|---:|
| CPU offload | 0 warstw |
| Stabilność przy context 8192 | brak OOM |
| Zapas pamięci | co najmniej 2 GB |
| TTFT p50 | do 2 s |
| Pełna odpowiedź p50 | do 8 s |
| Pełna odpowiedź p95 | do 15 s |

Najpierw wybieramy model na podstawie jakości. Dopiero potem wybieramy sprzęt
na podstawie pamięci, opóźnienia, ceny i obsługi runtime.

## 9. Stan implementacji

W benchmarku v1.1 zrealizowano:

- rozszerzenie głównego zestawu z 49 do 64 przypadków,
- osobny zestaw 10 trudnych przypadków,
- kontrolowane `seed` i `repeat`,
- zapis digestu, quantu, wersji Ollamy i podstawowych danych GPU,
- zapis identyfikatora maszyny i automatyczna detekcja CPU offloadu,
- rozdzielanie konfiguracji w raporcie,
- klucz oceny `run_id + model + case_id + repeat`,
- osobne oznaczanie i raportowanie błędów krytycznych,
- kontrolę kompletności przebiegu,
- instrukcję uruchamiania w `bench/README.md`.

Przed decyzją pozostaje:

1. wykonać i ręcznie ocenić pełne przebiegi porównywanych modeli;
2. mierzyć streamingowy TTFT i peak VRAM w teście sprzętowym;
3. opcjonalnie dodać mały tool smoke bez zależności od MCP.

Nie zmieniamy obecnego system promptu po rozpoczęciu końcowego porównania.

## 10. Kolejność prac

### Etap 1 — uporządkowanie obecnego benchmarku

1. uruchomić `./bench/run-ground-zero.sh`;
2. ręcznie ocenić pełny przebieg i stabilność obu modeli;
3. wybrać obecny model na podstawie jakości, błędów krytycznych i opóźnienia;
4. poprawić niejednoznaczne kryteria, jeśli wyjdą podczas oceny;
5. zamrozić prompty, modele i progi przed właściwym porównaniem;
6. opcjonalnie przygotować 10 przypadków tool smoke.

### Etap 2 — wynajęte GPU

Na jednej maszynie uruchomić:

```text
zwycięzca Ground 0
candidate 32B
reference 70/72B
```

Dla każdego:

```text
1 × 64 przypadki przy temperature=0
5 × 10 przypadków spornych przy temperature=0.3
1 × opcjonalny tool smoke
```

### Etap 3 — raport jakości

Porównać:

- wynik całkowity i kategorie,
- krytyczne błędy,
- stabilność,
- przypadki, w których 70/72B poprawia błędy 32B,
- czas i liczbę generowanych tokenów.

### Etap 4 — test docelowego sprzętu

Uruchomić tylko zwycięską konfigurację i sprawdzić VRAM, offload, TTFT oraz
p50/p95.

### Etap 5 — decyzja

- **32B spełnia progi, 70/72B daje do 5 pp:** sprzęt pod 32B;
- **mniejszy model jest do 2 pp i spełnia progi:** zostaje mniejszy;
- **32B nie spełnia progów, 70/72B spełnia:** większy sprzęt lub chmura;
- **32B przegrywa tylko trudne zadania:** lokalny 32B plus późniejsza eskalacja.

## 11. Ograniczenie wniosku

Ten benchmark pozwoli odpowiedzieć:

> Czy 32B jest optymalnym modelem dla obecnych zadań rozumowania Pirxa i czy
> rokuje jako przyszły model z narzędziami?

Nie pozwoli jeszcze odpowiedzieć:

> Czy kompletny Pirx z MCP będzie poprawnie wykonywał wieloetapowe zadania
> i operacje zmieniające stan?

Drugie pytanie wymaga już działającej pętli agenta. Nie jest potrzebne do
podjęcia pierwszej decyzji o tym, czy warto inwestować w klasę sprzętu pod 32B.
