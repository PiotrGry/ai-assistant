# Dashboard Pirxa (Grafana)

Cztery dashboardy tylko do odczytu: wydajność modeli, narzędzia i błędy, rozmowy
(baza `~/.local/share/pirx/pirx.sqlite`) oraz GPU (baza `~/.local/share/pirx/gpu.sqlite`).

## Start i stop

```bash
./up.sh     # odszyfrowuje grafana.sops.env przez sops i uruchamia Grafanę na 127.0.0.1:3000
./down.sh
```

Wymaga Dockera, `sops` i klucza age w `~/.config/sops/age/keys.txt`.
Stan Grafany leży w `~/.local/share/pirx-grafana`.

## Dostęp z Maca

```bash
ssh -L 3000:127.0.0.1:3000 pepus@pepus-pc.taild372e3.ts.net
```

Potem `http://localhost:3000`, użytkownik `admin`. Hasło:

```bash
sops --decrypt grafana.sops.env
```

`GF_SECURITY_ADMIN_PASSWORD` działa tylko przy pierwszym starcie z pustym
`~/.local/share/pirx-grafana`. Zmiana hasła później:

```bash
docker exec -it pirx-dashboard-grafana-1 grafana cli admin reset-admin-password '<nowe hasło>'
sops edit grafana.sops.env   # wpisz to samo hasło
```

## Wykresy GPU

Serwis użytkownika `pirx-gpu-sampler` co sekundę zapisuje dane z `nvidia-smi`
(obciążenie GPU i pamięci, VRAM, temperatura, moc i limit, wentylator, P-state
oraz procesy liczące na GPU) do `~/.local/share/pirx/gpu.sqlite` i trzyma
ostatnie 7 dni. Działa, gdy jesteś zalogowany (także w tmux).

```bash
cd ~/ai-assistant/Pirx && pnpm build
systemctl --user enable --now ~/ai-assistant/Pirx/dashboard/systemd/pirx-gpu-sampler.service
systemctl --user status pirx-gpu-sampler
journalctl --user -u pirx-gpu-sampler -n 20
```

Po zmianach w kodzie: `pnpm build && systemctl --user restart pirx-gpu-sampler`.
Wyłączenie: `systemctl --user disable --now pirx-gpu-sampler`.

Ustawienia zmieniasz przez `systemctl --user edit pirx-gpu-sampler`, dopisując
w sekcji `[Service]` na przykład `Environment=PIRX_GPU_RETENTION_DAYS=14`:

- `PIRX_GPU_INTERVAL_MS` (domyślnie `1000`),
- `PIRX_GPU_RETENTION_DAYS` (domyślnie `7`),
- `PIRX_GPU_DB` (domyślnie `~/.local/share/pirx/gpu.sqlite`; Grafana czyta tylko tę ścieżkę).

Źródło danych `pirx-gpu` Grafana wczytuje przy starcie, więc po pierwszym
wdrożeniu uruchom ją ponownie: `./down.sh && ./up.sh`.

## Diagnostyka

```bash
./query.sh "SELECT COUNT(*) AS turns FROM turns"
docker logs pirx-dashboard-grafana-1 2>&1 | tail -50
sqlite3 ~/.local/share/pirx/gpu.sqlite "SELECT COUNT(*), datetime(MAX(sampled_at) / 1000, 'unixepoch') FROM gpu_samples"
```

Dane historyczne sprzed zapisu z TUI importuje `pnpm --filter @pirx/agent import:logs <katalog logów>`
(z katalogu `Pirx`). Operacje narzędzi są tylko dla nowych sesji.
