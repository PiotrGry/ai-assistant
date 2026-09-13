# Wykresy GPU w Grafanie (sampler nvidia-smi): projekt

- Data: 2026-09-13
- Status: architektura zatwierdzona w rozmowie 2026-09-13; szczegóły poniżej

## Cel

Wykresy karty graficznej jak w nvtop, dostępne w Grafanie Pirxa: obciążenie GPU
i pamięci, VRAM, temperatura, moc i limit, wentylator, P-state oraz procesy
liczące na GPU z zajętym VRAM-em. Dane zbierane stale, nie tylko w trakcie
rozmowy z Pirxem.

## Decyzje z rozmowy

- Próbka co 1 s, retencja 7 dni (ok. 86 400 próbek na dobę).
- Sampler działa tylko, gdy użytkownik jest zalogowany (serwis `systemd --user`
  bez `loginctl enable-linger`).
- Zakres: metryki karty i procesy liczące na GPU.
- Podejście A: moduł TypeScript w pakiecie `agent`, osobna baza
  `~/.local/share/pirx/gpu.sqlite`, osobne źródło danych w Grafanie.

## Zweryfikowane fakty (2026-09-13)

- RTX 4080 SUPER, sterownik 580.178.04. `nvidia-smi` zwraca pola: `index`,
  `utilization.gpu`, `utilization.memory`, `memory.used`, `memory.total`,
  `temperature.gpu`, `power.draw`, `power.limit`, `fan.speed`, `pstate`;
  procesy: `pid`, `process_name`, `used_memory`.
- Jednorazowe zapytanie trwa 0,01–0,02 s. Tryb strumieniowy `-lms` jest
  buforowany w potoku, a dla procesów przy braku procesów nic nie wypisuje,
  więc sampler wywołuje zapytania jednorazowo co sekundę.
- Proces Node zajmuje ok. 42 MB RSS. `/usr/bin/node` v24.19.0; `PATH`
  menedżera użytkownika zawiera `/usr/bin` (`nvidia-smi`).
- Wtyczka SQLite w Grafanie ma makro `$__unixEpochGroupSeconds`, a Grafana
  podstawia `$__interval_ms` przed wysłaniem zapytania.

## Komponenty

### `agent/src/gpu/nvidia-smi.ts`

- `GPU_QUERY_ARGS`, `GPU_PROCESS_QUERY_ARGS`: dokładne argumenty zapytań
  (`--format=csv,noheader,nounits`).
- `parseGpuCsv(stdout)`: jeden `GpuSample` na niepusty wiersz; wartości
  `[N/A]` i `[Not Supported]` stają się `null`; wiersz z inną liczbą pól niż 10
  rzuca błąd.
- `parseProcessCsv(stdout)`: `GpuProcess { pid, name, vramMb }`; pusty wynik to
  pusta lista; nazwa to wszystko między pierwszym a ostatnim polem (może zawierać
  „, ”).
- `readNvidiaSmi(run)`: najpierw zapytanie o karty, potem o procesy; `run`
  domyślnie wywołuje `nvidia-smi` przez `execFile` z limitem 3 s.

### `agent/src/gpu/gpu-store.ts`

Osobna baza SQLite w trybie WAL, `synchronous=NORMAL`, `busy_timeout=5000`,
`PRAGMA user_version = 1`.

```sql
CREATE TABLE gpu_samples (
  sampled_at INTEGER NOT NULL,            -- epoka w ms
  gpu_index INTEGER NOT NULL,
  utilization_percent REAL, memory_utilization_percent REAL,
  vram_used_mb REAL, vram_total_mb REAL, temperature_c REAL,
  power_w REAL, power_limit_w REAL, fan_percent REAL, pstate TEXT,
  PRIMARY KEY (sampled_at, gpu_index)
) WITHOUT ROWID;

CREATE TABLE gpu_processes (
  sampled_at INTEGER NOT NULL, pid INTEGER NOT NULL,
  name TEXT NOT NULL, vram_used_mb REAL,
  PRIMARY KEY (sampled_at, pid)
) WITHOUT ROWID;
```

- `insertReading(sampledAtMs, reading)`: karty i procesy jednej próbki w jednej
  transakcji.
- `pruneBefore(cutoffMs)`: usuwa starsze wiersze z obu tabel, zwraca liczbę
  usuniętych próbek.

### `agent/src/gpu/gpu-sampler.ts`

- `GpuSampler`: pętla co `intervalMs`; kolejna próbka jest pomijana, jeśli
  poprzednia jeszcze trwa. Błąd odczytu lub zapisu trafia do `onError` i nie
  zatrzymuje pętli.
- Retencja: `pruneBefore(now - retentionMs)` przy starcie i potem co godzinę.

### `agent/src/gpu/gpu-sampler-cli.ts`

- `loadGpuSamplerConfig(env)`: `PIRX_GPU_DB` (domyślnie
  `$XDG_DATA_HOME/pirx/gpu.sqlite` albo `~/.local/share/pirx/gpu.sqlite`),
  `PIRX_GPU_INTERVAL_MS` (1000), `PIRX_GPU_RETENTION_DAYS` (7); złe wartości
  kończą start czytelnym błędem.
- Tworzy katalog z prawami 0700, uruchamia sampler, kończy się czysto po
  `SIGTERM` i `SIGINT`.
- Błędy loguje na stderr (dziennik systemd) tylko przy zmianie treści błędu
  i przy powrocie do poprawnych odczytów, żeby brak `nvidia-smi` nie zapisał
  86 400 wpisów na dobę.
- Skrypt `gpu:sampler` w `agent/package.json`.

### `Pirx/dashboard/systemd/pirx-gpu-sampler.service`

`ExecStart=/usr/bin/node --enable-source-maps %h/ai-assistant/Pirx/agent/dist/gpu-sampler-cli.js`,
`Restart=on-failure`, `RestartSec=10`, `WantedBy=default.target`. Instalacja:
`systemctl --user enable --now <ścieżka do pliku>` z głównego katalogu po scaleniu.

### Grafana

- Źródło danych `pirx-gpu`: `/var/lib/pirx/gpu.sqlite` (ten sam zamontowany
  katalog co `pirx.sqlite`).
- Dashboard `pirx-gpu.json` („Pirx · GPU”), domyślnie ostatnia godzina,
  odświeżanie co 10 s:
  - kafelki bieżących wartości: obciążenie GPU, VRAM, temperatura, moc;
  - obciążenie GPU i pamięci [%], VRAM użyty wobec całkowitego [MiB],
    temperatura [°C], moc wobec limitu [W], wentylator [%];
  - P-state jako oś stanów: najbardziej aktywny stan w przedziale, liczony
    numerycznie (`'P' || MIN(CAST(substr(pstate, 2) AS INTEGER))`), bo `P0` to
    najwyższa wydajność, a porównanie tekstu stawiałoby `P12` przed `P2`;
  - tabela procesów z ostatniej próbki w wybranym zakresie;
  - VRAM procesów w czasie, seria na nazwę procesu;
  - adnotacje tur Pirxa ze źródła `pirx-sqlite`, jeśli wtyczka obsługuje
    adnotacje (sprawdzane na żywo; bez obsługi adnotacje zostają usunięte).
- Zapytania: zakres `sampled_at >= $__from AND sampled_at < $__to` (ms),
  przedział uśredniania `MAX(1, ${__interval_ms} / 1000)` sekund, bez funkcji
  nowszych niż SQLite 3.37.

## Testy

- `gpu-nvidia-smi.test.ts`: parsery i argumenty zapytań.
- `gpu-store.test.ts`: zapis próbki z procesami, atomowość, retencja w obu tabelach.
- `gpu-sampler.test.ts`: zapis przez wstrzyknięty odczyt i zegar, pomijanie
  nakładających się próbek, błąd bez zapisu, retencja przy starcie i co godzinę.
- `gpu-sampler-cli.test.ts`: domyślne wartości i walidacja konfiguracji.
- `dashboard-queries.test.ts`: zapytania kierowane do bazy według uid źródła
  danych (`pirx-sqlite` albo `pirx-gpu`); wszystkie panele, zmienne i adnotacje
  wykonują się na danych testowych.
- Na żywo: serwis działa i zapisuje próbkę co sekundę, Grafana pokazuje panele.

## Poza zakresem

Linger, wiele kart z mapowaniem procesów na kartę, procesy graficzne
(Xorg, gnome-shell nie mają zużycia VRAM w `--query-compute-apps`), alerty.
