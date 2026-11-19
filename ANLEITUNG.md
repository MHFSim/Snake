# Snake Arena 3D auf dem eigenen Server (Docker)

Diese Anleitung bringt das Spiel auf deinen Server. Danach läuft alles dort:

- **Das Spiel selbst** (die Webseite)
- **Die Vermittlung der Mehrspieler-Verbindungen** (Signaling). Der öffentliche PeerJS-Dienst wird nicht mehr gebraucht.

Ein Docker-Container erledigt beides, auf **Port 8080**.

---

## Was du brauchst

- Einen Server mit **Docker** (und Docker Compose) oder **Coolify**
- Eine **Domain mit HTTPS**, z. B. `snake.zehnkronen.com` oder `zehnkronen.com/snake`
  (ohne HTTPS sperren Handys Vollbild, Bildschirm-wach-halten und teils die Verbindungen)
- Der Server braucht beim Bauen Internet (er lädt Node.js und die Pakete)

---

## Inhalt der Zip

| Datei / Ordner | Wofür |
| --- | --- |
| `ANLEITUNG.md` | diese Anleitung |
| `Dockerfile` | baut das Spiel und den Server in ein Image |
| `docker-compose.yml` | startet den Container (und optional einen TURN-Server) |
| `server/` | der kleine Node-Server: liefert das Spiel aus und vermittelt die Verbindungen |
| `src/`, `index.html`, `public/` | Quellcode des Spiels |
| `package.json`, `package-lock.json` | Paketliste des Spiels |

---

## Weg A: mit Coolify (empfohlen, wenn du Coolify schon nutzt)

Coolify baut das Image selbst aus dem `Dockerfile`.

1. **Code bereitstellen.** Am einfachsten über GitHub: Der Code liegt schon im Repo `MHFSim/Snake` (inkl. Dockerfile). Alternativ den Inhalt dieser Zip in ein eigenes Repo hochladen.
2. In Coolify eine **neue Ressource** anlegen und das Repo auswählen (öffentliches oder privates GitHub-Repo, Branch `main`).
3. Als Build-Art **Dockerfile** wählen (nicht Nixpacks). Das Dockerfile liegt im Hauptordner.
4. **Port** (Ports Exposes) auf **`8080`** setzen.
5. **Domain eintragen**, eine der beiden Varianten:
   - **Eigene Subdomain** (am einfachsten): `https://snake.zehnkronen.com`
     → Umgebungsvariable `BASE_PATH` bleibt `/`.
   - **Unterpfad**: `https://zehnkronen.com/snake`
     → Kommt es darauf an, ob Coolify den Pfad vor dem Weiterleiten abschneidet („Strip Prefix“):
       - Pfad wird **abgeschnitten**: `BASE_PATH=/`
       - Pfad wird **mitgeschickt**: `BASE_PATH=/snake`
     → Welche Variante richtig ist, verrät der Test in Schritt 8.
6. **Health Check** (falls Coolify danach fragt): Pfad `/health`, Port `8080`.
7. **Deploy** klicken. Der erste Build dauert 2–4 Minuten.
8. **Testen** im Browser (Beispiel Unterpfad, sonst ohne `/snake`):
   - `https://zehnkronen.com/snake/server-config.json` → zeigt `{"signal":true,...}`
   - `https://zehnkronen.com/snake/peerjs/` → zeigt `{"name":"PeerJS Server",...}`
   - `https://zehnkronen.com/snake/` → das Spiel startet
   Zeigt der erste Link eine Fehlerseite, ist `BASE_PATH` falsch: auf den anderen Wert umstellen und neu deployen.

**Updates:** Neuen Code ins Repo pushen, in Coolify auf **Redeploy** (oder Auto-Deploy bei Push einschalten).

---

## Weg B: Docker Compose direkt auf dem Server

### 1. Dateien auf den Server bringen

Auf deinem Rechner:

```bash
scp snake-arena-3d-docker.zip benutzer@dein-server:/opt/
```

Auf dem Server:

```bash
cd /opt
unzip snake-arena-3d-docker.zip -d snake
cd snake
```

### 2. Einstellungen prüfen

`docker-compose.yml` öffnen (`nano docker-compose.yml`):

- `ports: "8080:8080"`: Der linke Wert ist der Port auf deinem Server. Ist 8080 schon belegt, z. B. `"8085:8080"` nehmen.
- `BASE_PATH`: `/` für eigene Subdomain, `/snake` für `zehnkronen.com/snake` (siehe Schritt 4).

### 3. Bauen und starten

```bash
docker compose up -d --build
```

Prüfen:

```bash
docker compose ps                         # Status sollte "healthy" werden
curl http://127.0.0.1:8080/health         # {"ok":true}
docker compose logs -f snake              # Logs ansehen (Strg+C beendet)
```

### 4. Reverse Proxy mit HTTPS davor

Der Container spricht nur HTTP auf Port 8080. Dein Reverse Proxy (der auch HTTPS macht) leitet die Domain dorthin weiter.
**Wichtig:** WebSockets müssen durchgereicht werden, sonst kommt im Spiel „Raum nicht gefunden“.

**Caddy, eigene Subdomain** (Caddy macht HTTPS und WebSockets automatisch):

```
snake.zehnkronen.com {
    reverse_proxy 127.0.0.1:8080
}
```

**Caddy, Unterpfad** (`BASE_PATH=/snake`, Pfad wird mitgeschickt):

```
zehnkronen.com {
    handle /snake* {
        reverse_proxy 127.0.0.1:8080
    }
    # ... deine anderen Seiten
}
```

**nginx, eigene Subdomain:**

```nginx
server {
    server_name snake.zehnkronen.com;
    # listen 443 ssl; + Zertifikat wie bei deinen anderen Seiten (z. B. certbot)

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

**nginx, Unterpfad** (`BASE_PATH=/snake`): gleicher Block, aber
`location /snake/ { ... }` und `proxy_pass http://127.0.0.1:8080;` (**ohne** Schrägstrich am Ende, damit der Pfad mitgeschickt wird).
Dazu eine Zeile, damit auch die Adresse ohne Schrägstrich funktioniert:

```nginx
location = /snake { return 301 /snake/; }
```

Danach testen wie in Weg A, Schritt 8.

### 5. Updates einspielen

Neue Zip entpacken (alte Dateien überschreiben) oder `git pull`, dann:

```bash
docker compose up -d --build
```

Laufende Spiele brechen dabei ab. Am besten updaten, wenn niemand spielt.

---

## Einstellungen (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `8080` | Port im Container |
| `BASE_PATH` | `/` | Unterpfad, unter dem die Anfragen ankommen (z. B. `/snake`) |
| `TURN_URL` | leer | eigener TURN-Server, z. B. `turn:zehnkronen.com:3478` (mehrere mit Komma) |
| `TURN_USER` | leer | Benutzername für den TURN-Server |
| `TURN_PASS` | leer | Passwort für den TURN-Server |
| `PUBLIC_TURN` | `1` | `0` schaltet den kostenlosen PeerJS-TURN ab (nur mit eigenem TURN sinnvoll) |

---

## TURN: wenn Spieler im Mobilfunknetz nicht beitreten können

Die Handys verbinden sich direkt miteinander (WebRTC). Im WLAN klappt das fast immer. Manche Mobilfunknetze blockieren direkte Verbindungen. Dann braucht es einen **TURN-Server**, der die Daten weiterreicht.

- **Standard:** Der Server gibt dem Spiel den kostenlosen TURN von PeerJS mit. Für den Anfang reicht das meist.
- **Eigener TURN** (zuverlässiger): In `docker-compose.yml` beim Dienst `coturn` das Passwort in `--user=snake:...` ändern, beim Dienst `snake` die drei `TURN_...`-Zeilen einkommentieren (gleiches Passwort) und dann:

  ```bash
  docker compose --profile turn up -d --build
  ```

  In der Firewall öffnen: **3478 TCP+UDP** und **49160–49200 UDP**.
  (Mit Coolify: coturn als eigene Docker-Compose-Ressource anlegen oder direkt per Docker starten.)

---

## Fehlersuche

| Problem | Ursache und Lösung |
| --- | --- |
| Spiel lädt nicht, weiße Seite | `BASE_PATH` passt nicht zum Proxy. Test aus Schritt 8 machen, Wert umstellen. |
| „Raum konnte nicht geöffnet werden“ / „Raum nicht gefunden“ | WebSockets werden nicht durchgereicht. Bei nginx die `Upgrade`/`Connection`-Zeilen prüfen. Test: `.../peerjs/` muss JSON zeigen. |
| Im WLAN geht es, im Mobilfunk nicht | TURN fehlt oder ist blockiert. Abschnitt TURN. |
| „andere Spielversion“ | Ein Spieler hat noch die alte Seite offen. Seite neu laden. |
| Container wird nicht „healthy“ | `docker compose logs snake` ansehen. Meist ist Port 8080 belegt. |
| Spiel ruckelt auf dem Handy | Im Spiel ☰ → Grafik → „Niedrig“. |

Alle Spieler müssen dieselbe Adresse benutzen (deinen Server). Die GitHub-Pages-Version und die Server-Version können nicht zusammen in einem Raum spielen.

---

## Lokal testen (ohne Server)

Auf einem Rechner mit Docker:

```bash
docker compose up -d --build
```

Dann `http://localhost:8080` öffnen. Ein zweites Gerät im selben WLAN kann über `http://<IP-des-Rechners>:8080` beitreten (ohne HTTPS fehlen Vollbild und Wach-halten, das Spielen selbst geht).
