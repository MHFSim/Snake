# Snake Arena 3D

3D-Multiplayer-Snake fürs Handy mit Babylon.js 9. Bis zu 8 Spieler: Einer hostet, die anderen treten jederzeit per Raumcode bei.

**Spielen:** https://mhfsim.github.io/Snake/

Jeder Push auf `main` baut das Spiel und stellt es automatisch auf GitHub Pages (`.github/workflows/pages.yml`). Einmalig nötig: unter *Settings → Pages → Build and deployment → Source* „GitHub Actions" wählen.

## Spielen

- **Linke Bildschirmseite:** Joystick (erscheint unter dem Daumen)
- **BOOST-Taste:** schneller, kostet Länge
- **Desktop:** A/D oder Pfeiltasten zum Lenken, Leertaste für Boost

Orbs fressen macht länger. Wer mit dem Kopf gegen einen fremden Körper fährt, stirbt und zerfällt in Orbs. Power-ups: Magnet, Geist, Turbo, Schild.

## Starten (Entwicklung)

```bash
npm install
npm run dev        # http://localhost:5173, im WLAN auch vom Handy erreichbar
npm test           # Unit-Tests der Spiellogik
```

## Veröffentlichen

```bash
npm run build          # Ordner dist/ auf einen beliebigen HTTPS-Webspace laden
npm run build:single   # alles in einer Datei: dist-single/index.html
```

Einfachster Weg: **GitHub Pages** (Repo anlegen, Inhalt von `dist/` in den Branch `gh-pages`, Pages aktivieren). Das Spiel braucht HTTPS, sonst blockiert der Browser WebRTC.

Mehrspieler nutzt standardmäßig den kostenlosen PeerJS-Server (inkl. STUN/TURN). Eigener Server: `npx peerjs --port 9000` und das Spiel mit `?signal=meinserver.de:9000` öffnen.

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `src/sim/` | Spiellogik ohne Grafik: Gelände, Bewegung, Kollision, Orbs, Power-ups (läuft beim Host) |
| `src/net/` | Host und Client, Binärprotokoll, Interpolation, Vorhersage der eigenen Schlange |
| `src/render/` | Babylon.js: Gelände mit LOD, Wasser, Bäume, Gras, Schlangen, Orbs, Licht, Schatten, Bloom |
| `src/input/` | Touch-Joystick, Boost, Tastatur |
| `src/ui/` | HUD, Minimap, Bestenliste, Namensschilder |

Debug-Anzeige (FPS, Auflösung): Adresse mit `?debug` öffnen.

## Bekannte Grenzen

- Wechselt der Host in eine andere App, pausiert der Browser das Spiel für alle. Host-Migration ist noch nicht eingebaut.
- In der Claude-Vorschau sind WebRTC und externe Verbindungen gesperrt: dort geht nur „Alleine üben“.
- Getestet mit 2 Spielern in Headless-Chrome; 8 echte Handys gleichzeitig sind noch nicht getestet.
