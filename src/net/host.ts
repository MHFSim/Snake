import { CFG } from "../core/config";
import { World, Snake } from "../sim/world";
import type { Terrain } from "../sim/terrain";
import {
  F_ALIVE, F_BOOST, F_DOUBLE, F_FAST, F_GHOST, F_MAGNET, F_PROTECT, F_SHIELD, F_TURBO,
  InputRec, PlayerInfo, ReliableMsg, SnapSnake,
  decodeInputs, encodeSnapshot, makeRoomCode, orbsToArr, powToArr, MSG_INPUT,
} from "./protocol";
import { HostNet, ClientLink } from "./transport";
import { RSnake, Session, SessionListener, lerpAngle } from "./session";

const DEBUG = new URLSearchParams(location.search).has("debug");

// Host: rechnet das Spiel und verteilt den Zustand an alle Clients.

interface RemotePlayer {
  id: number;
  link: ClientLink;
  name: string;
  color: number;
  queue: InputRec[];
  lastQueued: number;
  lastSeq: number;
  lastSeen: number;
  ping: number;
  joined: boolean;
  lastEmote: number;
}

export function snakeFlags(s: Snake): number {
  let f = 0;
  if (s.alive) f |= F_ALIVE;
  if (s.boosting) f |= F_BOOST;
  if (s.protect > 0) f |= F_PROTECT;
  if (s.power.ghost > 0) f |= F_GHOST;
  if (s.power.shield > 0) f |= F_SHIELD;
  if (s.power.magnet > 0) f |= F_MAGNET;
  if (s.power.turbo > 0) f |= F_TURBO;
  if (s.padTimer > 0) f |= F_FAST;
  if (s.power.double > 0) f |= F_DOUBLE;
  return f;
}

export class HostSession implements Session {
  readonly isHost = true;
  readonly myId = 0;
  readonly seed: number;
  readonly world: World;
  roomCode = "";
  players: PlayerInfo[] = [];
  readonly snakes = new Map<number, RSnake>();
  ping = 0;
  online = false;

  private net: HostNet | null = null;
  private remotes = new Map<string, RemotePlayer>();
  private prev = new Map<number, { x: number; z: number; angle: number }>();
  private lastTickTime = performance.now();
  private acc = 0;
  private timer = 0;
  private myName: string;
  private myColor: number;

  constructor(name: string, color: number, private listener: SessionListener) {
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    this.world = new World(this.seed);
    this.myName = name;
    this.myColor = color;
  }

  get terrain(): Terrain {
    return this.world.terrain;
  }

  // Startet das Spiel. online=true öffnet einen Raum für Mitspieler.
  async start(online: boolean): Promise<void> {
    // Anfangszustand an die eigene Grafik geben
    for (const o of this.world.orbs.values()) this.listener.orbAdd(o.id, o.x, o.z, o.v, o.hue);
    this.world.addPlayer(0, this.myName, this.myColor);
    this.dispatch(this.world.flush());
    this.updatePlayers();

    if (online) {
      this.net = new HostNet();
      this.net.onLink = (l) => this.onLink(l);
      this.net.onFast = (pid, buf) => this.onFast(pid, buf);
      for (let attempt = 0; attempt < 4; attempt++) {
        const code = makeRoomCode();
        try {
          await this.net.open(code);
          this.roomCode = code;
          this.online = true;
          break;
        } catch (e) {
          const t = (e as { type?: string }).type;
          if (t !== "unavailable-id") throw e;
        }
      }
    }
    this.lastTickTime = performance.now();
    this.timer = window.setInterval(() => this.pump(), 1000 / CFG.tickRate / 2);
  }

  setInput(angle: number, boost: boolean) {
    this.world.setInput(0, { angle, boost });
  }

  sendEmote(k: number) {
    this.world.events.push({ t: "emote", id: 0, k });
  }

  // ---------- Netzwerk ----------

  private onLink(link: ClientLink) {
    link.rel.on("data", (d) => this.onRel(link, d as ReliableMsg));
    link.rel.on("close", () => this.dropRemote(link.peerId));
    link.rel.on("error", () => this.dropRemote(link.peerId));
  }

  private onRel(link: ClientLink, msg: ReliableMsg) {
    const r = this.remotes.get(link.peerId);
    if (r) r.lastSeen = performance.now();
    switch (msg.t) {
      case "hello": {
        if (r) return;
        if (msg.v !== CFG.protocolVersion) {
          link.rel.send({ t: "reject", reason: "version" } satisfies ReliableMsg);
          setTimeout(() => link.rel.close(), 500);
          return;
        }
        const used = new Set(this.world.snakes.keys());
        let id = -1;
        for (let i = 1; i < CFG.maxPlayers; i++) if (!used.has(i)) { id = i; break; }
        if (id < 0) {
          link.rel.send({ t: "reject", reason: "full" } satisfies ReliableMsg);
          setTimeout(() => link.rel.close(), 500);
          return;
        }
        const name = this.uniqueName(String(msg.name || "Spieler").slice(0, 14));
        const color = Math.max(0, Math.min(31, Math.floor(Number(msg.color) || 0)));
        const rp: RemotePlayer = {
          id, link, name, color, queue: [], lastQueued: 0, lastSeq: 0,
          lastSeen: performance.now(), ping: 0, joined: true, lastEmote: 0,
        };
        this.remotes.set(link.peerId, rp);
        this.world.addPlayer(id, name, color);
        this.sendWelcome(rp);
        this.updatePlayers();
        break;
      }
      case "emote": {
        const now = performance.now();
        if (r && now - r.lastEmote > 800) {
          r.lastEmote = now;
          this.world.events.push({ t: "emote", id: r.id, k: Math.max(0, Math.min(5, Math.floor(Number(msg.k) || 0))) });
        }
        break;
      }
      case "ping": {
        if (r) r.ping = Math.round(msg.rtt ?? 0);
        link.rel.send({ t: "pong", ts: msg.ts } satisfies ReliableMsg);
        break;
      }
    }
  }

  private uniqueName(n: string): string {
    const names = new Set([this.myName, ...[...this.remotes.values()].map((r) => r.name)]);
    if (!names.has(n)) return n;
    for (let i = 2; i < 20; i++) if (!names.has(`${n} ${i}`)) return `${n} ${i}`;
    return n;
  }

  private sendWelcome(rp: RemotePlayer) {
    const snakes = [...this.world.snakes.values()].map((s) => ({
      id: s.id, flags: snakeFlags(s), x: s.x, z: s.z, a: s.angle, score: s.score, kills: s.kills,
      pts: s.alive ? s.trail.exportPoints(0.6, s.length * CFG.segmentSpacing) : [],
    }));
    const msg: ReliableMsg = {
      t: "welcome", id: rp.id, seed: this.seed, tick: this.world.tick, players: this.playerList(),
      snakes, orbs: orbsToArr([...this.world.orbs.values()]), pows: powToArr([...this.world.powerups.values()]),
    };
    rp.link.rel.send(msg);
  }

  private onFast(pid: string, buf: ArrayBuffer) {
    const r = this.remotes.get(pid);
    if (!r || buf.byteLength < 2) return;
    r.lastSeen = performance.now();
    if (new DataView(buf).getUint8(0) !== MSG_INPUT) return;
    for (const rec of decodeInputs(buf)) {
      if (rec.seq <= r.lastQueued) continue;
      if (!Number.isFinite(rec.angle)) continue;
      r.lastQueued = rec.seq;
      r.queue.push(rec);
    }
    while (r.queue.length > 6) r.queue.shift();
  }

  private dropRemote(pid: string) {
    const r = this.remotes.get(pid);
    if (!r) return;
    this.remotes.delete(pid);
    this.world.removePlayer(r.id);
    this.updatePlayers();
  }

  private playerList(): PlayerInfo[] {
    const list: PlayerInfo[] = [{ id: 0, name: this.myName, color: this.myColor, ping: 0 }];
    for (const r of this.remotes.values()) list.push({ id: r.id, name: r.name, color: r.color, ping: r.ping });
    return list.sort((a, b) => a.id - b.id);
  }

  private updatePlayers() {
    this.players = this.playerList();
    this.listener.players(this.players);
    this.broadcast({ t: "players", list: this.players });
  }

  private broadcast(msg: ReliableMsg) {
    for (const r of this.remotes.values()) if (r.link.rel.open) r.link.rel.send(msg);
  }

  // ---------- Spieltakt ----------

  private pump() {
    const now = performance.now();
    const dtTick = 1000 / CFG.tickRate;
    this.acc += now - this.lastTickTime;
    this.lastTickTime = now;
    let n = 0;
    while (this.acc >= dtTick && n < 10) {
      this.acc -= dtTick;
      this.tick();
      n++;
    }
    if (n === 10) this.acc = 0;
  }

  private tick() {
    for (const s of this.world.snakes.values()) this.prev.set(s.id, { x: s.x, z: s.z, angle: s.angle });
    // Eingaben der Clients anwenden (eine pro Tick)
    for (const r of this.remotes.values()) {
      while (r.queue.length > 3) r.queue.shift();
      const rec = r.queue.shift();
      if (rec) {
        this.world.setInput(r.id, { angle: rec.angle, boost: rec.boost });
        r.lastSeq = rec.seq;
      }
    }
    this.world.step(1 / CFG.tickRate);
    const f = this.world.flush();
    this.dispatch(f);
    if (this.remotes.size > 0) {
      if (f.events.length || f.orbAdded.length || f.orbRemoved.length || f.powAdded.length || f.powRemoved.length) {
        this.broadcast({
          t: "d", ev: f.events, oa: orbsToArr(f.orbAdded), or: f.orbRemoved,
          pa: powToArr(f.powAdded), pr: f.powRemoved,
        });
      }
      if (this.world.tick % (CFG.tickRate / CFG.snapshotRate) === 0) this.sendSnapshots();
    }
    // Verbindungen ohne Lebenszeichen trennen
    const now = performance.now();
    // Vor der ersten Eingabe (Client baut noch die Welt) großzügig warten
    for (const [pid, r] of this.remotes) if (now - r.lastSeen > (r.lastQueued > 0 ? 8000 : 45000)) {
      r.link.rel.close();
      this.dropRemote(pid);
    }
    if (this.world.tick % (CFG.tickRate * 2) === 0 && this.remotes.size > 0) {
      this.updatePlayers();
      if (DEBUG) for (const r of this.remotes.values()) console.info(`[host] ${r.name}: still ${Math.round(now - r.lastSeen)} ms, seq ${r.lastSeq}, queue ${r.queue.length}`);
    }
    this.lastTickTime2 = now;
  }
  private lastTickTime2 = performance.now();

  private sendSnapshots() {
    const list: SnapSnake[] = [];
    for (const s of this.world.snakes.values()) {
      list.push({ id: s.id, flags: snakeFlags(s), x: s.x, z: s.z, a: s.angle, score: s.score, kills: s.kills });
    }
    for (const r of this.remotes.values()) {
      if (r.link.fast?.open) r.link.fast.send(encodeSnapshot(this.world.tick, r.lastSeq, list));
    }
  }

  private dispatch(f: ReturnType<World["flush"]>) {
    const L = this.listener;
    for (const o of f.orbAdded) L.orbAdd(o.id, o.x, o.z, o.v, o.hue);
    for (let i = 0; i < f.orbRemoved.length; i += 2) L.orbRemove(f.orbRemoved[i], f.orbRemoved[i + 1]);
    for (const p of f.powAdded) L.powAdd(p.id, p.x, p.z, p.kind);
    for (const id of f.powRemoved) L.powRemove(id);
    for (const e of f.events) L.event(e);
  }

  // ---------- Darstellung ----------

  update(nowMs: number) {
    const alpha = Math.min(1, Math.max(0, (nowMs - this.lastTickTime2) / (1000 / CFG.tickRate)));
    for (const id of [...this.snakes.keys()]) if (!this.world.snakes.has(id)) this.snakes.delete(id);
    for (const s of this.world.snakes.values()) {
      let r = this.snakes.get(s.id);
      if (!r) {
        r = { id: s.id, alive: false, x: 0, z: 0, angle: 0, score: 0, kills: 0, flags: 0 };
        this.snakes.set(s.id, r);
      }
      const p = this.prev.get(s.id);
      const jump = p ? Math.hypot(p.x - s.x, p.z - s.z) > 5 : true;
      if (p && !jump) {
        r.x = p.x + (s.x - p.x) * alpha;
        r.z = p.z + (s.z - p.z) * alpha;
        r.angle = lerpAngle(p.angle, s.angle, alpha);
      } else {
        r.x = s.x;
        r.z = s.z;
        r.angle = s.angle;
      }
      r.alive = s.alive;
      r.score = s.score;
      r.kills = s.kills;
      r.flags = snakeFlags(s);
    }
  }

  serverTime(nowMs: number): number {
    const alpha = Math.min(1, Math.max(0, (nowMs - this.lastTickTime2) / (1000 / CFG.tickRate)));
    return (this.world.tick + alpha) / CFG.tickRate;
  }

  dispose() {
    clearInterval(this.timer);
    this.net?.close();
  }
}
