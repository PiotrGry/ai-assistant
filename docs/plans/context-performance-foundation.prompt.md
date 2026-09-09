# Prompt rozwojowy: fundament wydajności, kontekstu i obserwowalności Pirxa

Data przygotowania: 2026-09-09. Poniższy tekst jest samodzielnym promptem do dalszej pracy nad repozytorium. To plan do uzgodnienia, nie polecenie jednorazowego przebudowania całej aplikacji.

## Cel i tryb współpracy

Pracujesz nad moim osobistym, lokalnym agentem AI Pirx w repozytorium `PiotrGry/ai-assistant`. Najpierw przeczytaj aktualny kod i instrukcje repozytorium. Zaprojektuj małymi krokami fundament zarządzania kontekstem, obserwowalności i trwałego przechowywania danych. Nie rozwijaj teraz nowych integracji ani funkcji biznesowych.

Używam Ollamy i modelu `gemma4:12b` na komputerze z kartą NVIDIA i około 16 GB VRAM. Potwierdź rzeczywisty model GPU, ilość VRAM, RAM systemowy, system operacyjny i wersję backendu; nie wyprowadzaj tych danych z nazwy komputera lub wcześniejszej rozmowy. TypeScript pozostaje językiem aplikacji. Obsidian pozostaje źródłem notatek.

Chcę rozumieć i współtworzyć rozwiązanie. Najpierw przedstaw audyt, decyzje architektoniczne, zakres etapów i testy. Poczekaj na zatwierdzenie przed zmianami kodu aplikacji. Po zatwierdzeniu wykonuj tylko uzgodniony etap, wyjaśniaj kompromisy i pokazuj wyniki. Nie rób automatycznie commitów, pushy, instalacji usług, zmian globalnej konfiguracji Ollamy ani płatnych uruchomień.

Poprzedni review dotyczył `6f633f3`; lokalny checkout na Macu był starszy. Ustal analizowany commit i stan zmian. Nie zakładaj, że tamten review nadal dokładnie opisuje aktualny kod. Nie nadpisuj moich niezwiązanych zmian.

## Co optymalizujemy

Priorytety, w tej kolejności:

1. Poprawne wykonanie zadania, zachowanie ograniczeń użytkownika i potwierdzeń operacji.
2. Krótki czas do użytecznej odpowiedzi i dobry p95 czasu całego zadania.
3. Mały, trafny kontekst, brak niekontrolowanego obcinania i stabilne zużycie pamięci.
4. Wydajne wykorzystanie lokalnego GPU, CPU, RAM i SSD przy niskim narzucie monitoringu.
5. Tanie, uporządkowane dane do późniejszej analizy, debugowania i selektywnego odtwarzania historii.

Nie traktuj 100% GPU utilization ani wypełnienia całego VRAM jako celu. Nie poprawiaj tokens/s kosztem poprawności lub dłuższych zbędnych odpowiedzi. Nie obiecuj przyspieszenia przed pomiarami na mojej maszynie. Oddziel spostrzeżenia z kodu, dokumentacji, testów z atrapami i pomiarów rzeczywistej inferencji.

## Granice pierwszej iteracji

- Zachowaj istniejącego agenta, Ollamę i MCP; preferuj małe moduły zamiast nowego frameworka.
- Bez dodatkowego dużego modelu zarządzającego pamięcią, serwera wektorowego, GraphRAG, klastra, Kubernetes i rozbudowanego stosu monitoringu.
- Nie wdrażaj teraz samodzielnego porządkowania vaulta, nowych integracji ani automatycznego uczenia na rozmowach.
- Przygotuj interfejsy pod późniejszy retrieval i eksport. Nie buduj z wyprzedzeniem wielu adapterów baz danych.
- Testy na Macu mają działać bez GPU i bez prawdziwych kont zewnętrznych. Pomiary NVIDIA wykonuj wyłącznie na właściwym hoście.

## Etap 0 — audyt i baseline

Prześledź pełną turę: użytkownik → składanie kontekstu → Ollama → MCP → wynik narzędzia → kolejne wywołanie → odpowiedź → zapis danych.

Sprawdź przede wszystkim: rosnącą historię, rozmiar wyników narzędzi, liczbę schematów narzędzi, powtarzany thinking, timeouty, anulowanie, ponawianie zapisów, moment zapisywania logów i aktualne metryki. Zweryfikuj wcześniejsze podejrzenia o utratę potwierdzenia zapisu po błędzie modelu i wielokrotne wykonanie tej samej mutacji.

Zapisz manifest środowiska i eksperymentu: commit i stan dirty, wersje aplikacji/Node/Ollamy/SQLite, model tag i digest, faktyczna kwantyzacja, hash szablonu i system promptu, parametry generacji, kontekst, ustawienia cache/FlashAttention/parallelism, GPU/driver/VRAM, CPU/RAM. Nie zbieraj pełnego środowiska procesu ani sekretów. Brakujące dane oznacz jako niedostępne.

Nie aktualizuj modelu lub backendu w trakcie porównania. Przypnij konfigurację i rozdziel zimny start, ciepły model oraz ponownie użyty prefiks. Uruchom obecne testy; zaproponuj mały powtarzalny zestaw baseline przed optymalizacjami.

## Etap 1 — uporządkowane dane i monitoring

### Magazyn v1

Domyślnie wybierz SQLite na lokalnym SSD. Pola potrzebne do filtrowania i agregacji przechowuj w typowanych kolumnach; dodatkowe atrybuty w walidowanym JSON. Nie zapisuj wszystkiego jako nieprzeszukiwalnego tekstowego logu i nie dubluj wszystkich danych w kilku magazynach. Dla dokumentów i odtwarzalnych indeksów pozostaw jawne referencje do źródeł.

Zapewnij migracje, klucze obce, indeksy pod rzeczywiste zapytania i wersjonowane kontrakty TypeScript/Zod. Rozszerzalność SQL/NoSQL uzyskaj przez stabilne rekordy i eksport JSONL, nie przez wdrożenie kilku baz. Duże analizy i eksport kolumnowy można dodać później.

Rozważ WAL, pojedynczego writer-a, krótkie transakcje i ograniczoną kolejkę zapisów. Nie trzymaj transakcji otwartej podczas wywołania modelu/narzędzia. Telemetrię grupuj w paczki; krytyczne potwierdzenia operacji wymagają silniejszej trwałości. Jawnie opisz zachowanie przy pełnym dysku, błędzie zapisu, przeciążeniu kolejki i awarii procesu. Utrata próbek monitoringu musi być policzona; nie wolno po cichu zgubić dziennika operacji. WAL nie powinien działać na udziale sieciowym; dobierz i uzasadnij ustawienia synchronizacji. Sprawdź faktyczną wersję SQLite w sterowniku, w tym poprawkę WAL-reset: 3.51.3+ lub odpowiedni backport. [SQLite WAL](https://sqlite.org/wal.html)

Początkowo preferuj jedną bazę z `synchronous=FULL`, z paczkowaniem zwykłych metryk. Nie osłabiaj trwałości dziennika, zanim pomiar nie pokaże rzeczywistego problemu. Zastosuj parametryzowane zapytania i ograniczony czas oczekiwania na blokadę.

### Minimalny logiczny model danych

Możesz scalać poniższe encje, jeśli uprości to implementację bez utraty semantyki. Nie buduj pełnego frameworka event sourcing/CQRS.

| Encja | Minimalna zawartość |
|---|---|
| `run_environments` | Wersje, model/digest, sprzęt, efektywna konfiguracja i jej hash. |
| `sessions`, `turns` | Identyfikatory, powiązania, czas, status, cel pomiaru, pełny czas tury, referencja środowiska. |
| `messages`, `artifacts` | Uporządkowane wiadomości i typowane bloki; wyniki narzędzi, źródła, hashe, wersje, retencja. Treść zależna od polityki prywatności. |
| `operations` lub `spans` | Wywołania LLM, MCP, retrieval, kompakcji i storage; rodzic, kolejność, status, czas, błąd, metryki właściwe operacji. |
| `context_builds` | Wersja polityki, budżet, oszacowanie wejścia, wybrane/odrzucone referencje, powody, hash faktycznie wysłanego zestawu. |
| `checkpoints` | Cel, ograniczenia, decyzje, otwarte kwestie, następny krok; zakres źródłowych wiadomości, wersja podsumowania. |
| `action_events` | Identyfikator mutacji, cel, próba, autoryzacja, stan `planned/started/succeeded/failed/unknown`, potwierdzenie wyniku. |
| `resource_samples` | Timestamp, źródło pomiaru, host/GPU, zakres host/proces, próbki GPU/VRAM/RAM/CPU/power i jakość pomiaru. |

Wspólne zasady: `schema_version`, unikalne ID odporne na uruchomienia w tej samej sekundzie, `session_id`, `turn_id`, `operation_id`, opcjonalne `parent_operation_id`, kolejność zdarzeń, timestamp UTC. Czas trwania mierz zegarem monotonicznym. Ustal jednostki: ms, bajty, waty; nie myl GB z GiB. Nie przenoś nanosekund do JSON bez określonego sposobu zachowania precyzji.

Oddziel jawnie:

- rzeczywiste liczniki backendu od szacunków tokenizera;
- brak metryki (`null` plus powód) od zmierzonego zera;
- surowe dowody od streszczeń i wniosków modelu;
- rozmowy użytkownika od benchmarków i fixture'ów;
- odtwarzalny indeks od nieodtwarzalnego dziennika działań.

### Co mierzyć

Dla każdego wywołania Ollamy zapisz dostępne liczniki i czasy backendu, przyczynę zakończenia, efektywne ustawienia oraz liczbę wywołań narzędzi. Obsłuż wersje bez `prompt_eval_cached_count`; nie wpisuj wtedy zera. Zachowaj nazwy/pochodzenie surowych liczników, a metryki pochodne licz według zweryfikowanej semantyki wersji. Nie odejmuj cached tokens ponownie, jeśli dany licznik już je wyklucza. [Ollama Chat API](https://docs.ollama.com/api/chat)

Ponadto mierz:

- pełny czas tury, osobno kolejkę, składanie kontekstu, retrieval, narzędzia, kompakcję i zapis;
- przy streamingu: czas do pierwszego chunku, pierwszego fragmentu thinkingu, pierwszej treści odpowiedzi; bez streamingu te pola pozostają niedostępne, nie udawaj TTFT;
- podział szacowanego kontekstu na instrukcje, schematy narzędzi, pamięć roboczą, historię, źródła i bieżącą wiadomość;
- wielkość wyników przed/po redukcji, deduplikację, powody pominięcia, koszt kompakcji;
- prompt processing i generację oddzielnie; sumy tokenów ze wszystkich wywołań nie są zajętością okna jednego wywołania;
- OOM, timeouty, anulowania, obcięcia `length`, CPU offload i przeładowania modelu;
- narzut samego monitoringu oraz wzrost rozmiaru danych na dysku.

Zbieraj próbki zasobów także podczas pracy, nie tylko przed i po turze. Zacznij od konfigurowalnego próbkowania około 1 Hz podczas aktywności i wyłączania/ograniczania próbek w bezczynności. Preferuj jeden sampler zamiast uruchamiania procesu `nvidia-smi` na każdy token. NVML może być alternatywą, jeśli zależność ma uzasadnienie. Nie blokuj odpowiedzi wolnym odczytem telemetrii.

Rozróżniaj użycie pamięci od aktywności kontrolera pamięci. `utilization.gpu` nie mierzy procentu wykorzystanych FLOPS, a próbka całej karty nie jest pomiarem wyłącznie Pirxa. Maksimum próbek oznacz jako zaobserwowany peak, nie gwarantowane rzeczywiste maksimum. Weryfikuj rezydencję modelu także przez `/api/ps` lub `ollama ps`. [NVIDIA SMI](https://docs.nvidia.com/deploy/nvidia-smi/index.html)

Zaproponuj prosty widok CLI: zajętość kontekstu, największe jego składniki, czas tury, prefill/decode, sampled VRAM peak, status offload i koszty kompakcji. Bez dashboardu webowego w pierwszej iteracji.

### Archiwum, retencja i prywatność

Pełna historia na dysku nie oznacza pełnej historii w promptach. Zapisuj wiadomości i artefakty raz, a manifest kontekstu jako uporządkowane referencje do ich wersji. Dla treści zewnętrznych sam hash/ścieżka nie wystarczy do dokładnego odtworzenia po zmianie pliku: opcjonalny capture musi zachować dopuszczony snapshot. Oznacz odtworzenie jako pełne, zredagowane lub niepełne. Nigdy nie wykonuj mutujących narzędzi podczas replay.

Zaproponuj konfigurowalne tryby zapisu: `metrics_only`, `redacted`, `full_local`. Wyjaśnij, czego nie da się odzyskać po wyborze oszczędniejszego trybu. Nie migruj ani nie usuwaj istniejących logów bez mojej decyzji. Sekrety i tokeny uwierzytelniające zawsze wykluczaj; surowy thinking nie jest domyślnym archiwum wiedzy.

Punkt wyjścia do uzgodnienia: szczegółowe próbki sprzętu 7 dni, potem agregaty per operacja/tura; metryki i porównania eksperymentów 180 dni; treści według osobnej polityki. Nie kasuj checkpointów, źródeł podsumowań lub potwierdzeń operacji tylko dlatego, że skończyła się retencja próbek GPU. Zapewnij dry-run retencji, poprawne referencje i eksport przed usuwaniem. Zachowaj per-call duration lub odpowiednie histogramy: percentyli nie da się poprawnie odtworzyć ze średnich godzinowych. Hash treści nie jest anonimizacją, a usunięcie rekordu nie gwarantuje fizycznego wymazania wszystkich backupów i danych na SSD.

Baza, WAL, snapshoty i prywatne logi nie należą do Git. Przechowuj je w prywatnym katalogu danych poza repo, z ograniczonymi uprawnieniami. Backup ma zachowywać spójność działającej bazy; nie kopiuj wyłącznie aktywnego pliku `.db` z pominięciem WAL. Zaprojektuj również test przywracania. [SQLite Backup API](https://sqlite.org/backup.html)

Przygotuj lokalne raporty/zapytania: p50/p95 latencji per konfiguracja i typ zadania; wzrost kontekstu w sesji; najcięższe narzędzia; koszt kompakcji; wykorzystanie cache; offload/OOM; poprawność benchmarku. Nie zakładaj, że wbudowany percentile jest dostępny w każdej dystrybucji SQLite.

## Etap 2 — kontroler kontekstu

Wydziel testowalny `ContextManager`, oddzielony od transportu Ollamy, bazy i CLI. Pełne zdarzenia pozostają na dysku; kontekst jednego wywołania jest wyliczaną projekcją. Kontroler działa przed KAŻDYM wywołaniem modelu, także wewnątrz pętli narzędzi.

Zaprojektuj profile konfiguracji, a nie automatyczne zmienianie `num_ctx` w każdej turze. Budżet uwzględnia wejście, szablon, narzędzia, maksymalną generację/thinking i margines. Jako eksperymentalny punkt startowy dla 8192 tokenów można sprawdzić 6144 wejścia + 1536 generacji + 512 marginesu. To hipoteza, nie obietnica dla każdego zadania. Dla dłuższego reasoning zaproponuj odrębny budżet.

Nie zakładaj istnienia endpointu tokenizacji w Ollamie. Sprawdź dostępność zgodnego tokenizera dla faktycznego modelu/szablonu. Jeśli pozostaje estymator, oznacz jego błąd, kalibruj na pomiarach i stosuj konserwatywny margines. Rozmiary sekcji mogą być estymowane nawet wtedy, gdy znamy rzeczywistą sumę backendu. Nie udawaj twardej gwarancji na podstawie `characters / 4`.

Kolejność redukcji:

1. Zwięzłe, typowane wyniki narzędzi: wymagane pola, limit elementów, sekcje, paginacja i referencja do pełnego artefaktu. Nie obcinaj JSON-u w środku i nie usuwaj informacji o błędzie, ID lub wykonanym zapisie.
2. Deduplikacja tej samej wersji źródła. Uwzględniaj zmiany pliku i świeżość kalendarza; cache nie może udawać aktualnego odczytu.
3. Selekcja fragmentów związanych z zadaniem; ograniczony odczyt notatek zamiast całych plików.
4. Usunięcie starych, zbędnych wyników odczytów z aktywnego promptu przy zachowaniu źródłowych referencji.
5. Kompakcja starszych zakończonych tur do struktury: cel, ograniczenia, decyzje, otwarte kwestie, następny krok, dowody.

Chroń aktualną prośbę, instrukcje bezpieczeństwa, istotne ograniczenia i potwierdzenia operacji. Zachowaj poprawne pary wywołań narzędzi i wyników. Jeśli minimalny wymagany kontekst się nie mieści, wykonaj kontrolowany podział zadania lub zgłoś ograniczenie; nie licz na ciche obcięcie przez backend.

Kompakcję uruchamiaj progowo z histerezą, nie po każdej wiadomości. Preferuj deterministyczne redukcje przed dodatkowym wywołaniem LLM. Mierz koszt podsumowania i utratę ponownego użycia prefiksu. W pierwszej iteracji wykonuj ją sekwencyjnie, bez konkurującego modelu na GPU. Streszczenia mają wersję, zakres źródeł i test zachowania faktów; nie streszczaj bez końca samego poprzedniego streszczenia bez dostępu do dowodów. [Praktyki context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

Dobieraj ograniczone grupy narzędzi do zadania, z możliwością poszerzenia, stabilną kolejnością i rejestrem faktycznie udostępnionych schematów. Nie wprowadzaj osobnego zapytania do modelu tylko po to, aby routować każdą prostą wiadomość. Nie uznawaj filtrowania narzędzi za zastępstwo kontroli uprawnień.

W Gemmie sprawdź normalizację historii: dokumentacja zaleca nie przenosić thinkingu z poprzednich tur do nowej tury użytkownika. Zachowaj finalną odpowiedź i kontrakt tool calling; osobno sprawdź wymagania aktywnej rundy narzędzi. Nie manipuluj na ślepo tokenami szablonu. Nie zmieniaj jednocześnie domyślnego samplingu przy pomiarze tej optymalizacji. [Gemma 4 w Ollamie — praktyki multi-turn](https://ollama.com/library/gemma4:12b)

## Etap 3 — profilowanie i optymalizacje runtime

Przeprowadzaj pojedyncze, odwracalne eksperymenty w ustalonej kolejności:

1. Ograniczenie kontekstu i wyników narzędzi; porównanie jakości przed/po.
2. Streaming z prawdziwym anulowaniem HTTP/MCP i sprawdzaniem anulowania przed następną mutacją. Streaming poprawia dostęp do częściowej odpowiedzi, ale sam nie gwarantuje szybszej generacji.
3. Stabilny prefiks instrukcji i schematów, zmienne dane później, utrzymywanie modelu ciepłego w aktywnej sesji. Mierz trafienia cache zamiast zakładać je z podobieństwa tekstu. Zmiana wczesnego fragmentu historii może unieważnić dużą część prefiksu. Cache obliczeń nie jest pamięcią trwałą. [llama.cpp server](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
4. Zweryfikowanie FlashAttention; aktualna Ollama używa go automatycznie na obsługiwanym backendzie/sprzęcie. Porównanie kontekstu 4k/8k/16k, ale tylko jeśli minimalny prompt i zadanie się mieszczą. Nie uznawaj maksymalnego kontekstu z model card za rozsądny budżet lokalny. [Ollama FAQ](https://docs.ollama.com/faq), [Context length](https://docs.ollama.com/context-length)
5. Jawny budżet wyjścia i obsługiwany dla modelu tryb thinking. Nie wyłączaj reasoning globalnie bez testów jakości, nie uznawaj pustej odpowiedzi z `length` za sukces.
6. Jeden model generujący i początkowo pojedyncze żądanie inferencji. CPU/SSD obsługują storage, ekstrakcję, indeks i monitoring; zadania tła mają limity. Równoległość i batching badaj dopiero dla rzeczywistego zapotrzebowania, nie po to, aby podnieść wykres GPU utilization.

Pozostaw na później: zmiana backendu na vLLM/SGLang, speculative decoding/MTP i embeddingi/reranker. Wymagają osobnego dowodu zysku, kompatybilności NVIDIA/modelu i zapasu pamięci. Nie przenoś wyników Apple Silicon na RTX. Kwantyzację KV cache można oznaczyć jako osobny opcjonalny eksperyment — nadal jest kwantyzacją i nie zastępuje powyższych prac.

## Spójność działań jest częścią fundamentu

Kompakcja, restart i błąd modelu nie mogą usuwać jedynego potwierdzenia wykonanej mutacji. Przed zapisem utrwal zamiar, po wykonaniu wynik. Przy niepewnym rezultacie zachowaj `unknown` i sprawdź stan zewnętrzny przed ponowieniem. Używaj idempotencji tam, gdzie jest dostępna; sam lokalny dziennik nie daje transakcji dokładnie-raz obejmującej zewnętrzne API.

Deduplikuj tę samą operację, nie wszystkie podobne prośby użytkownika w przyszłości. Zapis krytycznego zamiaru musi się udać przed uruchomieniem mutacji. Przy awarii storage nie deklaruj wykonania bez dowodu. Nie pozwalaj modelowi zmieniać potwierdzeń ani traktować treści notatek jako nowych instrukcji systemowych.

## Etap 4 — testy i warunki odbioru

Przygotuj mały zestaw syntetyczny i osobny zestaw docelowych zadań. Uwzględnij: prostą odpowiedź, kilka narzędzi, notatkę znacznie większą od okna, powtórne odczyty, zmienione źródło, polski tekst, restart, ponad 50 tur i zachowanie starego ograniczenia po kompakcji. Dodaj timeout/błąd po udanym zapisie, przerwanie użytkownika, duplikat mutacji, brak GPU, brak pola metryki, pełny dysk, odzyskiwanie dziennika oraz eksport/import/backup.

W porównaniach utrzymuj model/digest, sampling, zadania i tryb thinking. Zapisuj seedy i wykonuj powtórzenia, ale nie obiecuj pełnej deterministyczności. Kontroluj cache i inne obciążenia; zmieniaj kolejność wariantów. Nie prezentuj p95 jako stabilnej statystyki z pięciu prób. Najpierw mały screening, potem większa próba finalistów. Nie uruchamiaj wielkiego iloczynu wszystkich konfiguracji.

Proponowane cele do zatwierdzenia, nie gotowe wyniki:

- brak cichego przekroczenia ustalonego budżetu w zestawie testowym; jawne oznaczenie obcięć backendu;
- zachowanie krytycznych ograniczeń, par tool call/result i potwierdzeń operacji;
- ograniczony aktywny kontekst podczas długiej sesji, niezależnie od rosnącego archiwum;
- brak nieuprawnionych lub zduplikowanych mutacji w testach awarii;
- możliwość wyjaśnienia, dlaczego dany fragment trafił do konkretnego zapytania;
- pełna korelacja sesja → tura → wywołanie → źródła → wynik; brak udawanych zer i TTFT;
- mniejszy koszt wejścia na długich sesjach i brak regresji ocenianej jakości;
- wstępny cel narzutu zwykłego monitoringu poniżej 5% czasu zadania względem wersji bez niego, sprawdzony pomiarem; kompakcja raportowana osobno i w pełnym koszcie zadania;
- brak OOM i niezamierzonego offload w wybranym profilu na rzeczywistym sprzęcie, z jawnym marginesem na pozostałe aplikacje;
- ograniczony rozmiar storage, działająca retencja i przetestowane przywrócenie danych.

## Oczekiwany wynik pierwszej odpowiedzi

Oddaj najpierw, bez implementacji:

1. Zwięzły audyt aktualnego kodu z dowodami i informacją, czego nie można zmierzyć na dostępnym hoście.
2. Proponowany podział modułów i przepływ danych; oddziel archiwum, pamięć roboczą, prompt oraz cache obliczeń.
3. Decyzję SQLite vs alternatywy i minimalny schemat z kilkoma przykładowymi rekordami oraz zapytaniami analitycznymi. Wybierz sterownik po sprawdzeniu runtime i wersji silnika, nie z przyzwyczajenia.
4. Plan małych etapów/PR-ów: zakres, pliki, zależności, testy, sposób cofnięcia i mierzalny efekt. Osobno elementy konieczne i późniejsze eksperymenty.
5. Protokół baseline i kolejność eksperymentów. Nie przypisuj hipotetycznych oszczędności jako wyników.
6. Najmniejszy sensowny pierwszy etap do mojej akceptacji.

Uzasadnienia opieraj na aktualnych źródłach pierwotnych i kodzie. Jeśli dokumentacja opisuje inną wersję lub platformę, zaznacz to. Nie buduj dodatkowych funkcjonalności, dopóki nie uzgodnimy i nie sprawdzimy tego fundamentu.

## Dodatkowe źródła i interoperacyjność

SQLite obsługuje zapytania do JSON, więc elastyczne atrybuty nie wymagają od razu NoSQL. Wspólne metryki powinny pozostać w kolumnach do prostych agregacji. [SQLite JSON](https://sqlite.org/json1.html)

Do późniejszego eksportu obserwowalności wykorzystaj identyfikatory i strukturę operacji zgodną koncepcyjnie z OpenTelemetry. Konwencje GenAI są rozwijane; przypnij wersję ewentualnego adaptera zamiast uzależniać wewnętrzny schemat danych od każdej zmiany nazw. SDK, collector i zewnętrzny backend nie są wymaganiem pierwszej iteracji. [OpenTelemetry GenAI — metryki](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md), [spany i treści](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
