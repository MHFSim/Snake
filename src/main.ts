import "./style.css";
import { AbstractEngine, Engine, WebGPUEngine } from "@babylonjs/core";
import { SNAKE_COLORS } from "./core/config";
import { HostSession } from "./net/host";
import { ClientSession } from "./net/client";
import { normalizeCode } from "./net/protocol";
import type { Session } from "./net/session";
import { GameRenderer, Quality } from "./render/renderer";
import { Controls } from "./input/controls";
import { Hud } from "./ui/hud";
import type { PlayerInfo } from "./net/protocol";
import type { SimEvent } from "./sim/world";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("game");

// ---------- Engine ----------

async function createEngine(): Promise<AbstractEngine> {
  const wantGpu = new URLSearchParams(location.search).has("webgpu");
  if (wantGpu && (await WebGPUEngine.IsSupportedAsync)) {
    try {
      const e = new WebGPUEngine(canvas, { antialias: false, adaptToDeviceRatio: false, powerPreference: "high-performance" });
      await e.initAsync();
      return e;
    } catch (err) {
      console.warn("WebGPU nicht verfügbar, nutze WebGL2", err);
    }
  }
  return new Engine(canvas, false, { stencil: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: false }, false);
}

// ---------- Zustand ----------

let engine: AbstractEngine;
let renderer: GameRenderer | null = null;
let session: Session | null = null;
let hud: Hud | null = null;
let controls: Controls;
let myColor = 0;
let wakeLock: { release(): Promise<void> } | null = null;

function savePrefs(name: string) {
  try {
    localStorage.setItem("sa3d-name", name);
    localStorage.setItem("sa3d-color", String(myColor));
  } catch { /* egal */ }
}

function loadPrefs() {
  try {
    $<HTMLInputElement>("nameInput").value = localStorage.getItem("sa3d-name") || "";
    myColor = Number(localStorage.getItem("sa3d-color") || Math.floor(Math.random() * 8)) % 8;
  } catch {
    myColor = 0;
  }
}

function buildColorPicker() {
  const box = $("colors");
  box.innerHTML = "";
  SNAKE_COLORS.forEach(([a, b], i) => {
    const btn = document.createElement("button");
    btn.style.background = `linear-gradient(135deg, ${a}, ${b})`;
    btn.setAttribute("aria-label", `Farbe ${i + 1}`);
    if (i === myColor) btn.classList.add("sel");
    btn.onclick = () => {
      myColor = i;
      box.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
      btn.classList.add("sel");
    };
    box.append(btn);
  });
}

function playerName(): string {
  const n = $<HTMLInputElement>("nameInput").value.trim().slice(0, 14);
  return n || "Spieler" + Math.floor(Math.random() * 90 + 10);
}

function showLoading(text: string | null) {
  $("loading").classList.toggle("hidden", text === null);
  if (text) $("loadingText").textContent = text;
}

function toast(text: string, ms = 2500) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout((toast as unknown as { h: number }).h);
  (toast as unknown as { h: number }).h = window.setTimeout(() => t.classList.add("hidden"), ms);
}

async function goFullscreen() {
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen && matchMedia("(pointer: coarse)").matches) {
      await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    }
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    await o.lock?.("landscape").catch(() => {});
  } catch { /* nicht überall erlaubt */ }
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } };
    wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
  } catch { /* egal */ }
}

// ---------- Spiel starten / beenden ----------

function makeRenderer(): GameRenderer {
  return new GameRenderer(engine, {
    event: (ev: SimEvent) => hud?.event(ev),
    players: (list: PlayerInfo[]) => hud?.players(list),
    disconnected: (reason: string) => {
      endGame();
      $("menuError").textContent =
        reason === "hostleft" ? "Der Host hat das Spiel verlassen." : "Verbindung verloren.";
    },
    qualityChanged: (q: Quality) => {
      document.querySelectorAll("#qualitySeg button").forEach((b) => b.classList.toggle("sel", (b as HTMLElement).dataset.q === q));
    },
  });
}

function startPlaying(s: Session, r: GameRenderer) {
  session = s;
  renderer = r;
  if (new URLSearchParams(location.search).has("debug")) (window as unknown as Record<string, unknown>).__game = { s, r };
  hud = new Hud(s, r);
  hud.players(s.players);
  $("menu").classList.add("hidden");
  document.body.classList.add("playing");
  controls.enabled = true;
  showLoading(null);
}

async function hostGame(online: boolean) {
  $("menuError").textContent = "";
  savePrefs(playerName());
  void goFullscreen();
  showLoading("Welt wird gebaut …");
  await new Promise((r) => setTimeout(r, 30));
  const r = makeRenderer();
  const s = new HostSession(playerName(), myColor, r);
  r.attach(s);
  try {
    if (online) showLoading("Raum wird geöffnet …");
    await s.start(online);
  } catch (e) {
    console.error(e);
    s.dispose();
    r.dispose();
    showLoading(null);
    $("menuError").textContent =
      "Raum konnte nicht geöffnet werden. Mehrspieler braucht Internet und eine normale Webseite (in der Claude-Vorschau ist das gesperrt).";
    return;
  }
  startPlaying(s, r);
  if (online) toast(`Raumcode ${s.roomCode} – teile ihn mit deinen Freunden`, 4000);
}

async function joinGame(code: string) {
  $("menuError").textContent = "";
  code = normalizeCode(code);
  if (code.length !== 6) {
    $("menuError").textContent = "Der Raumcode hat 6 Zeichen.";
    return;
  }
  savePrefs(playerName());
  void goFullscreen();
  showLoading("Verbinde mit Raum " + code + " …");
  const r = makeRenderer();
  const s = new ClientSession(code, r);
  try {
    await s.join(playerName(), myColor);
  } catch (e) {
    s.dispose();
    r.dispose();
    showLoading(null);
    const m = (e as Error).message;
    $("menuError").textContent =
      m === "notfound" ? "Raum nicht gefunden. Code prüfen."
      : m === "full" ? "Der Raum ist voll (8 Spieler)."
      : m === "version" ? "Der Host hat eine andere Spielversion."
      : m === "timeout" ? "Keine Verbindung zum Host (Zeitüberschreitung)."
      : m === "webrtc" ? "Mehrspieler ist hier gesperrt. Öffne das Spiel über seine normale Webseite."
      : "Verbindung fehlgeschlagen.";
    return;
  }
  showLoading("Welt wird gebaut …");
  await new Promise((res) => setTimeout(res, 30));
  r.attach(s);
  s.begin();
  startPlaying(s, r);
}

function endGame() {
  hud?.dispose();
  hud = null;
  session?.dispose();
  session = null;
  renderer?.dispose();
  renderer = null;
  controls.enabled = false;
  document.body.classList.remove("playing");
  $("pause").classList.add("hidden");
  $("menu").classList.remove("hidden");
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------- Start ----------

async function main() {
  loadPrefs();
  buildColorPicker();
  engine = await createEngine();
  controls = new Controls($("touch"), $("stickBase"), $("stickKnob"), $("boostBtn"));
  controls.enabled = false;

  $("hostBtn").onclick = () => hostGame(true);
  $("soloBtn").onclick = () => hostGame(false);
  $("joinOpenBtn").onclick = () => {
    $("joinPanel").classList.toggle("hidden");
    $<HTMLInputElement>("codeInput").focus();
  };
  $("joinBtn").onclick = () => joinGame($<HTMLInputElement>("codeInput").value);
  $<HTMLInputElement>("codeInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") joinGame($<HTMLInputElement>("codeInput").value);
  });
  $("menuBtn").onclick = () => $("pause").classList.remove("hidden");
  $("resumeBtn").onclick = () => $("pause").classList.add("hidden");
  $("leaveBtn").onclick = () => endGame();
  document.querySelectorAll<HTMLButtonElement>("#qualitySeg button").forEach((b) => {
    b.onclick = () => renderer?.applyQuality(b.dataset.q as Quality, true);
  });
  $("shareBtn").onclick = async () => {
    if (!session) return;
    const url = `${location.origin}${location.pathname}?join=${session.roomCode}`;
    const text = `Spiel mit mir Snake Arena 3D! Raumcode: ${session.roomCode}`;
    try {
      if (navigator.share) await navigator.share({ title: "Snake Arena 3D", text, url });
      else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        toast("Code und Link kopiert");
      }
    } catch { /* abgebrochen */ }
  };
  // Pausenmenü: Raumcode zeigen
  new MutationObserver(() => {
    const open = !$("pause").classList.contains("hidden");
    if (open && session) {
      $("pauseRoom").classList.toggle("hidden", !session.roomCode);
      $("pauseCode").textContent = session.roomCode;
    }
  }).observe($("pause"), { attributes: true, attributeFilter: ["class"] });

  // Einladungslink ?join=CODE
  const join = new URLSearchParams(location.search).get("join") || (location.hash.match(/^#join-([A-Za-z0-9]{6})$/)?.[1] ?? null);
  if (join) {
    $("joinPanel").classList.remove("hidden");
    $<HTMLInputElement>("codeInput").value = normalizeCode(join);
  }

  window.addEventListener("resize", () => engine.resize());
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && session && !wakeLock) {
      try {
        const nav = navigator as Navigator & { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } };
        wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
      } catch { /* egal */ }
    }
  });

  let last = performance.now();
  engine.runRenderLoop(() => {
    const now = performance.now();
    const dt = now - last;
    last = now;
    if (!session || !renderer) return;
    // Eingabe -> Spiel
    const me = session.snakes.get(session.myId);
    if (me && me.alive) {
      const target = controls.target(renderer.cameraYaw, me.angle);
      session.setInput(target, controls.isBoost());
    }
    session.update(now);
    renderer.frame(dt);
    hud?.update(dt / 1000);
    renderer.scene.render();
  });
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<p style="padding:20px;font-family:sans-serif">Dieses Gerät unterstützt kein WebGL2. (${String(e)})</p>`;
});
