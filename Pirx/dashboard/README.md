# Dashboard Pirxa (Grafana)

Trzy dashboardy tylko do odczytu na bazie `~/.local/share/pirx/pirx.sqlite`:
wydajność modeli, narzędzia i błędy, rozmowy.

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

## Diagnostyka

```bash
./query.sh "SELECT COUNT(*) AS turns FROM turns"
docker logs pirx-dashboard-grafana-1 2>&1 | tail -50
```

Dane historyczne sprzed zapisu z TUI importuje `pnpm --filter @pirx/agent import:logs <katalog logów>`
(z katalogu `Pirx`). Operacje narzędzi są tylko dla nowych sesji.
