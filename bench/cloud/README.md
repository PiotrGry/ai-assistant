# Benchmark na zdalnym GPU przez Taskfile

Maszynę z GPU tworzymy ręcznie w panelu wybranego dostawcy. Dzięki temu wybór
sprzętu, ceny oraz operacja finansowa pozostają pod bezpośrednią kontrolą.
Pozostałe kroki są powtarzalne i niezależne od dostawcy.

Taskfile automatyzuje:

1. kontrolę połączenia SSH;
2. rozpoznanie NVIDIA/CUDA albo AMD/ROCm;
3. synchronizację wyłącznie kodu benchmarku;
4. instalację i uruchomienie Ollamy;
5. kontrolę dostępności modeli oraz próbne załadowanie każdego do VRAM;
6. uruchomienie benchmarku w odłączonej sesji `tmux`;
7. walidację kompletności odpowiedzi;
8. raport, archiwum, pobranie oraz kontrolę SHA-256.

Taskfile celowo nie tworzy, nie zatrzymuje i nie usuwa maszyny.
Etap `prepare` zatrzymuje przebieg przed właściwym testem, jeżeli `/api/ps`
nie potwierdzi 100% modelu w VRAM.

## 1. Instalacja Task

Na macOS:

```bash
brew install go-task
```

Na Linuxie można użyć pakietu dystrybucji albo oficjalnego instalatora
opisanego na stronie <https://taskfile.dev/docs/installation>.

## 2. Ręczne utworzenie maszyny

Utwórz host z publicznym SSH. Dla R9700 wymagany jest Linux ze sprawnym ROCm 7.
Zapisz adres, port oraz ścieżkę do swojego klucza prywatnego.

## 3. Konfiguracja

```bash
cp bench/cloud/host.env.example bench/cloud/host.env
chmod 600 bench/cloud/host.env
```

Uzupełnij:

```dotenv
BENCH_SSH_HOST="157.157.221.177"
BENCH_SSH_PORT=14857
BENCH_SSH_USER="root"
BENCH_SSH_KEY="$HOME/.ssh/id_ed25519"
```

Konfiguracja, stan połączenia oraz wyniki są ignorowane przez Git.

## 4. Uruchomienie

Sprawdzenie planu i hosta:

```bash
task cloud:plan
task cloud:doctor
```

Cały przebieg:

```bash
task cloud:all
```

Benchmark działa na hoście niezależnie od lokalnego terminala. Po zerwaniu
połączenia można użyć:

```bash
task cloud:status
task cloud:logs
task cloud:wait
task cloud:collect
task cloud:finish
```

Wyniki trafiają do:

```text
bench/cloud-results/<run-id>/
```

Po `task cloud:finish` należy ręcznie zatrzymać lub usunąć maszynę w panelu
dostawcy.

## Modele

Domyślny zestaw:

```text
gemma4:31b-it-q4_K_M
qwen3.6:35b-a3b-q4_K_M
qwen3:32b-q4_K_M
qwen3:14b-q4_K_M
```

Model 122B został usunięty, ponieważ screening nie wykazał przewagi jakości,
a jego wymagania pamięciowe nie odpowiadają badanej klasie GPU 32 GB.

Ustawienia domyślne: `think=true`, temperatura `0`, context `8192`,
`num_predict=4096`, seed `42`, jedno powtórzenie 64 przypadków.
