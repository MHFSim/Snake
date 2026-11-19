import { HALF, SNAKE_COLORS, lengthFromScore } from "../core/config";
import { F_GHOST, F_MAGNET, F_SHIELD, F_TURBO } from "../net/protocol";
import type { PlayerInfo } from "../net/protocol";
import type { Session } from "../net/session";
import type { SimEvent } from "../sim/world";
import type { GameRenderer } from "../render/renderer";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// Anzeige im Spiel: Werte, Bestenliste, Minimap, Meldungen, Namensschilder, Todesbildschirm.
export class Hud {
  private names = new Map<number, string>();
  private tags = new Map<number, HTMLDivElement>();
  private mapBg: HTMLCanvasElement | null = null;
  private mapCtx = $<HTMLCanvasElement>("minimap").getContext("2d")!;
  private slowTimer = 0;
  private deathTimer = 0;
  private lastPlayers: PlayerInfo[] = [];
  private debug = new URLSearchParams(location.search).has("debug");

  constructor(private session: Session, private renderer: GameRenderer) {
    $("hud").classList.remove("hidden");
    if (session.isHost && session.roomCode) {
      $("room").classList.remove("hidden");
      $("roomCode").textContent = session.roomCode;
    } else if (!session.isHost) {
      $("room").classList.remove("hidden");
      $("roomCode").textContent = session.roomCode;
      $("shareBtn").classList.add("hidden");
      $("ping").classList.remove("hidden");
    } else {
      $("room").classList.add("hidden");
    }
    $("debug").classList.toggle("hidden", !this.debug);
    const bg = document.createElement("canvas");
    bg.width = bg.height = 140;
    bg.getContext("2d")!.putImageData(renderer.minimapImage(140), 0, 0);
    this.mapBg = bg;
  }

  players(list: PlayerInfo[]) {
    const before = new Set(this.lastPlayers.map((p) => p.id));
    const after = new Set(list.map((p) => p.id));
    if (this.lastPlayers.length) {
      for (const p of list) if (!before.has(p.id)) this.feed(`${p.name} ist beigetreten`);
      for (const p of this.lastPlayers) if (!after.has(p.id)) this.feed(`${p.name} hat das Spiel verlassen`);
    }
    this.lastPlayers = list;
    for (const p of list) this.names.set(p.id, p.name);
    for (const [id, el] of this.tags) if (!after.has(id)) { el.remove(); this.tags.delete(id); }
    const ul = $("playerList");
    ul.innerHTML = "";
    for (const p of list) {
      const li = document.createElement("li");
      const a = document.createElement("span");
      a.textContent = p.name + (p.id === this.session.myId ? " (du)" : p.id === 0 ? " (Host)" : "");
      a.style.color = SNAKE_COLORS[p.color][0];
      const b = document.createElement("span");
      b.textContent = p.id === 0 ? "Host" : `${p.ping} ms`;
      li.append(a, b);
      ul.append(li);
    }
  }

  private name(id: number) {
    return this.names.get(id) ?? "Jemand";
  }

  event(ev: SimEvent) {
    const me = this.session.myId;
    if (ev.t === "kill") {
      if (ev.killer === me) {
        this.feed(`Du hast ${this.name(ev.victim)} erwischt!`, true);
        navigator.vibrate?.([30, 40, 30]);
      } else this.feed(`${this.name(ev.killer)} hat ${this.name(ev.victim)} erwischt`);
      if (ev.victim === me) $("deathText").textContent = `von ${this.name(ev.killer)}`;
    } else if (ev.t === "die") {
      if (ev.cause === "wall") this.feed(`${this.name(ev.id)} ist in die Energiewand gefahren`);
      if (ev.cause === "head") this.feed(`${this.name(ev.id)}: Kopf an Kopf`);
      if (ev.id === me) {
        $("deathTitle").textContent = "Erwischt!";
        $("deathText").textContent = ev.cause === "wall" ? "Die Energiewand ist tödlich" : ev.cause === "head" ? "Kopf an Kopf" : "";
        $("death").classList.remove("hidden");
        this.deathTimer = 3;
        navigator.vibrate?.(220);
      }
    } else if (ev.t === "spawn" && ev.id === me) {
      $("death").classList.add("hidden");
    } else if (ev.t === "power" && ev.id === me) {
      const label = { magnet: "Magnet", ghost: "Geist", turbo: "Turbo", shield: "Schild" }[ev.kind];
      this.feed(`${label} aktiv!`, true);
      navigator.vibrate?.(40);
    } else if (ev.t === "shield" && ev.id === me) {
      this.feed("Schild hat dich gerettet!", true);
    }
  }

  feed(text: string, me = false) {
    const box = $("feed");
    const d = document.createElement("div");
    d.textContent = text;
    if (me) d.style.borderColor = "var(--accent)";
    box.prepend(d);
    while (box.children.length > 4) box.lastChild!.remove();
    setTimeout(() => d.remove(), 3500);
  }

  update(dt: number) {
    const s = this.session;
    const me = s.snakes.get(s.myId);

    if (this.deathTimer > 0) {
      this.deathTimer -= dt;
      $("deathCount").textContent = String(Math.max(1, Math.ceil(this.deathTimer)));
    }

    this.updateTags();

    this.slowTimer += dt;
    if (this.slowTimer < 0.2) return;
    this.slowTimer = 0;

    const ranked = [...s.snakes.values()].filter((r) => this.names.has(r.id)).sort((a, b) => b.score - a.score);
    if (me) {
      $("statLen").textContent = String(lengthFromScore(me.score));
      $("statRank").textContent = `${ranked.findIndex((r) => r.id === me.id) + 1}/${ranked.length}`;
      $("statKills").textContent = String(me.kills);
      const p: string[] = [];
      if (me.flags & F_MAGNET) p.push("🧲 Magnet");
      if (me.flags & F_GHOST) p.push("👻 Geist");
      if (me.flags & F_TURBO) p.push("⚡ Turbo");
      if (me.flags & F_SHIELD) p.push("🛡️ Schild");
      const pw = $("powers");
      const html = p.map((x) => `<div>${x}</div>`).join("");
      if (pw.innerHTML !== html) pw.innerHTML = html;
    }
    const board = $("board");
    board.innerHTML = "";
    for (const r of ranked.slice(0, 5)) {
      const li = document.createElement("li");
      if (r.id === s.myId) li.className = "me";
      const color = SNAKE_COLORS[(s.players.find((p) => p.id === r.id)?.color ?? r.id) % 8][0];
      const a = document.createElement("span");
      a.innerHTML = `<i style="background:${color}"></i>`;
      a.append(document.createTextNode(this.name(r.id)));
      const b = document.createElement("span");
      b.textContent = String(lengthFromScore(r.score));
      li.append(a, b);
      board.append(li);
    }
    if (!s.isHost) $("ping").textContent = `Ping ${s.ping} ms`;
    if (this.debug) {
      const e = this.renderer.engine;
      $("debug").textContent = `${this.renderer.fps.toFixed(0)} FPS  ${this.renderer.quality}\n${e.getRenderWidth()}x${e.getRenderHeight()}  meshes ${this.renderer.scene.getActiveMeshes().length}`;
    }
    this.drawMinimap(ranked[0]?.id ?? -1);
  }

  private updateTags() {
    const s = this.session;
    const cam = this.renderer.camera.position;
    for (const r of s.snakes.values()) {
      if (r.id === s.myId) continue;
      let el = this.tags.get(r.id);
      if (!el) {
        el = document.createElement("div");
        $("tags").append(el);
        this.tags.set(r.id, el);
      }
      const head = this.renderer.headOf(r.id);
      const dist = head ? Math.hypot(head.x - cam.x, head.z - cam.z) : 1e9;
      if (!head || !r.alive || dist > 70) {
        el.style.display = "none";
        continue;
      }
      const p = this.renderer.project(head.x, head.y + 1.8, head.z);
      if (!p.visible) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      const name = this.name(r.id);
      if (el.textContent !== name) el.textContent = name;
      const color = SNAKE_COLORS[(s.players.find((q) => q.id === r.id)?.color ?? r.id) % 8][0];
      el.style.color = color;
      el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
      el.style.opacity = String(Math.min(1, (70 - dist) / 20));
    }
  }

  private drawMinimap(leader: number) {
    const ctx = this.mapCtx;
    const W = ctx.canvas.width;
    ctx.clearRect(0, 0, W, W);
    if (this.mapBg) ctx.drawImage(this.mapBg, 0, 0, W, W);
    const toX = (x: number) => ((x + HALF) / (HALF * 2)) * W;
    const toY = (z: number) => (1 - (z + HALF) / (HALF * 2)) * W;
    for (const p of this.renderer.powList()) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(toX(p.x) - 4, toY(p.z) - 4, 8, 8);
    }
    for (const r of this.session.snakes.values()) {
      if (!r.alive) continue;
      const color = SNAKE_COLORS[(this.session.players.find((q) => q.id === r.id)?.color ?? r.id) % 8][0];
      const x = toX(r.x);
      const y = toY(r.z);
      if (r.id === this.session.myId) {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(r.angle);
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, -13);
        ctx.lineTo(9, 9);
        ctx.lineTo(-9, 9);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = color;
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
      }
      if (r.id === leader) {
        ctx.font = "22px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("👑", x, y - 12);
      }
    }
  }

  dispose() {
    $("hud").classList.add("hidden");
    $("death").classList.add("hidden");
    $("room").classList.add("hidden");
    $("ping").classList.add("hidden");
    $("shareBtn").classList.remove("hidden");
    $("tags").innerHTML = "";
    $("feed").innerHTML = "";
    $("board").innerHTML = "";
    $("powers").innerHTML = "";
  }
}
