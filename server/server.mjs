// Snake Arena 3D – eigener Server
// - liefert das fertige Spiel (Ordner public/) aus
// - vermittelt die Mehrspieler-Verbindungen (PeerJS-Signaling unter <BASE_PATH>peerjs/)
// - sagt dem Spiel über <BASE_PATH>server-config.json, dass es diesen Server benutzen soll
import express from "express";
import { ExpressPeerServer } from "peer";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8080);

// Unterpfad, unter dem der Server die Anfragen bekommt, z. B. "/snake/".
// Wenn dein Reverse-Proxy den Pfad abschneidet (Strip Prefix), bleibt das "/".
let BASE = process.env.BASE_PATH || "/";
if (!BASE.startsWith("/")) BASE = "/" + BASE;
if (!BASE.endsWith("/")) BASE += "/";

// STUN/TURN für Verbindungen über Mobilfunk.
// Standard: Google-STUN + der kostenlose TURN von PeerJS. Eigener TURN über TURN_URL/TURN_USER/TURN_PASS.
function iceServers() {
  const list = [{ urls: "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(",").map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USER || "",
      credential: process.env.TURN_PASS || "",
    });
  } else if (process.env.PUBLIC_TURN !== "0") {
    list.push({
      urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
      username: "peerjs",
      credential: "peerjsp",
    });
  }
  return list;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

const server = app.listen(PORT, () => {
  console.log(`Snake Arena 3D läuft auf Port ${PORT}, Pfad ${BASE}`);
});

// "/snake" ohne Schrägstrich -> "/snake/", damit relative Pfade im Spiel stimmen
if (BASE !== "/") {
  const noSlash = BASE.slice(0, -1);
  app.use((req, res, next) => {
    if (req.path !== noSlash) return next();
    const q = req.originalUrl.indexOf("?");
    res.redirect(301, BASE + (q >= 0 ? req.originalUrl.slice(q) : ""));
  });
}

app.get(BASE + "health", (_req, res) => res.json({ ok: true }));

app.get(BASE + "server-config.json", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ signal: true, iceServers: iceServers() });
});

// Signaling-Server (WebSocket + REST) unter <BASE>peerjs/
// Muss direkt an der App hängen (nicht an einem Router), sonst startet PeerJS nicht.
const peerServer = ExpressPeerServer(server, {
  path: "/",
  proxied: true,
  allow_discovery: false,
  alive_timeout: 60000,
});
peerServer.on("connection", () => stats.connected++);
peerServer.on("disconnect", () => stats.connected--);
app.use(BASE + "peerjs", peerServer);

// Spiel-Dateien: index.html nie cachen, Assets mit Hash lange
app.use(
  BASE,
  express.static(publicDir, {
    index: "index.html",
    setHeaders(res, file) {
      if (file.endsWith("index.html") || file.endsWith(".webmanifest")) res.set("Cache-Control", "no-cache");
      else if (file.includes(`${path.sep}assets${path.sep}`)) res.set("Cache-Control", "public, max-age=31536000, immutable");
    },
  }),
);

// Gesundheitscheck auch ohne Unterpfad (für Docker/Coolify)
if (BASE !== "/") app.get("/health", (_req, res) => res.json({ ok: true }));

const stats = { connected: 0 };
setInterval(() => {
  if (stats.connected > 0) console.log(`Verbunden mit dem Signaling: ${stats.connected}`);
}, 300000).unref();

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
