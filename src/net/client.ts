import { CFG, PowerKind, lengthFromScore } from "../core/config";
import { Terrain } from "../sim/terrain";
import { speedFor, stepHead, HeadState } from "../sim/movement";
import {
  F_ALIVE, F_FAST, F_TURBO, InputRec, MSG_SNAPSHOT, PlayerInfo, ReliableMsg, Snapshot,
  decodeSnapshot, encodeInputs,
} from "./protocol";
import { ClientNet } from "./transport";
import { RSnake, Session, SessionListener, lerpAngle } from "./session";

// Client: schickt nur Eingaben, zeigt den Zustand vom Host.
// Fremde Schlangen: Interpolation (100 ms Puffer). Eigene Schlange: Vorhersage + Abgleich.

export class ClientSession implements Session {
  readonly isHost = false;
  myId = -1;
  seed = 0;
  terrain!: Terrain;
  roomCode: string;
  players: PlayerInfo[] = [];
  readonly snakes = new Map<number, RSnake>();
  ping = 0;

  private net = new ClientNet();
  private snaps: Snapshot[] = [];
  private tickOffset = NaN; // geschätzter Server-Tick = now*rate/1000 + tickOffset
  private input = { angle: 0, boost: false, jump: false };
  private seq = 0;
  private pending: InputRec[] = [];
  private pred: HeadState = { x: 0, z: 0, angle: 0 };
  private predPrev: HeadState = { x: 0, z: 0, angle: 0 };
  private predValid = false;
  private corr = { x: 0, z: 0 };
  private lastClientTick = performance.now();
  private acc = 0;
  private timer = 0;
  private pingTimer = 0;
  private lastFrame = performance.now();
  private me = { score: 0, flags: 0 };
  private dead = new Set<number>(); // gestorben laut Event, noch nicht neu gespawnt

  constructor(code: string, private listener: SessionListener) {
    this.roomCode = code;
  }

  // Verbindet, wartet auf "welcome". Wirft Fehler mit message: notfound | timeout | full | version | ...
  async join(name: string, color: number): Promise<void> {
    await this.net.connect(this.roomCode);
    const welcome = await new Promise<Extract<ReliableMsg, { t: "welcome" }>>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("timeout")), 10000);
      this.net.onRel = (m) => {
        const msg = m as ReliableMsg;
        if (msg.t === "welcome") {
          clearTimeout(to);
          resolve(msg);
        } else if (msg.t === "reject") {
          clearTimeout(to);
          reject(new Error(msg.reason));
        }
      };
      this.net.onClose = (r) => reject(new Error(r));
      let token = "";
      try {
        token = localStorage.getItem("sa3d-token") || "";
        if (!token) localStorage.setItem("sa3d-token", (token = crypto.randomUUID()));
      } catch {
        token = Math.random().toString(36).slice(2);
      }
      this.net.sendRel({ t: "hello", v: CFG.protocolVersion, name, color, token } satisfies ReliableMsg);
    });

    this.myId = welcome.id;
    this.seed = welcome.seed;
    this.terrain = new Terrain(this.seed);
    this.welcome = welcome;
    // Bis begin() aufgerufen wird, Nachrichten sammeln
    this.net.onRel = (m) => this.early.push(m as ReliableMsg);
    this.net.onClose = (r) => this.listener.disconnected(r);
  }
  private welcome: Extract<ReliableMsg, { t: "welcome" }> | null = null;
  private early: ReliableMsg[] = [];

  // Startet das Spiel, nachdem die Grafik bereit ist
  begin() {
    const welcome = this.welcome!;
    this.welcome = null;
    this.players = welcome.players;
    this.listener.players(this.players);
    this.tickOffset = welcome.tick - (performance.now() * CFG.tickRate) / 1000;

    const o = welcome.orbs;
    for (let i = 0; i < o.length; i += 5) this.listener.orbAdd(o[i], o[i + 1], o[i + 2], o[i + 3], o[i + 4]);
    const p = welcome.pows;
    for (let i = 0; i < p.length; i += 4) {
      this.listener.powAdd(p[i] as number, p[i + 1] as number, p[i + 2] as number, p[i + 3] as PowerKind);
    }
    for (const s of welcome.snakes) {
      this.snakes.set(s.id, { id: s.id, alive: (s.flags & F_ALIVE) !== 0, x: s.x, z: s.z, angle: s.a, score: s.score, kills: s.kills, flags: s.flags });
      if (s.flags & F_ALIVE) this.listener.snakeInit(s.id, s.x, s.z, s.a, s.pts);
      if (s.id === this.myId) {
        this.pred = { x: s.x, z: s.z, angle: s.a };
        this.predPrev = { ...this.pred };
        this.predValid = (s.flags & F_ALIVE) !== 0;
        this.input.angle = s.a;
      }
    }
    // Erster Snapshot aus dem Welcome
    this.snaps.push({
      tick: welcome.tick, ack: 0,
      snakes: welcome.snakes.map((s) => ({ id: s.id, flags: s.flags, x: s.x, z: s.z, a: s.a, score: s.score, kills: s.kills })),
    });

    this.net.onRel = (m) => this.onRel(m as ReliableMsg);
    this.net.onFast = (buf) => this.onFast(buf);
    for (const m of this.early) this.onRel(m);
    this.early = [];
    this.lastClientTick = performance.now();
    this.timer = window.setInterval(() => this.pump(), 1000 / CFG.tickRate / 2);
    this.pingTimer = window.setInterval(() => {
      this.net.sendRel({ t: "ping", ts: performance.now(), rtt: this.ping } satisfies ReliableMsg);
    }, 1000);
  }

  setInput(angle: number, boost: boolean, jump = false) {
    this.input.angle = angle;
    this.input.boost = boost;
    this.input.jump = jump;
  }

  sendEmote(k: number) {
    this.net.sendRel({ t: "emote", k } satisfies ReliableMsg);
  }

  private onRel(msg: ReliableMsg) {
    switch (msg.t) {
      case "players":
        this.players = msg.list;
        this.listener.players(msg.list);
        break;
      case "pong":
        this.ping = Math.round(this.ping ? this.ping * 0.7 + (performance.now() - msg.ts) * 0.3 : performance.now() - msg.ts);
        break;
      case "d": {
        const L = this.listener;
        for (let i = 0; i < msg.oa.length; i += 5) L.orbAdd(msg.oa[i], msg.oa[i + 1], msg.oa[i + 2], msg.oa[i + 3], msg.oa[i + 4]);
        for (let i = 0; i < msg.or.length; i += 2) L.orbRemove(msg.or[i], msg.or[i + 1]);
        for (let i = 0; i < msg.pa.length; i += 4) {
          L.powAdd(msg.pa[i] as number, msg.pa[i + 1] as number, msg.pa[i + 2] as number, msg.pa[i + 3] as PowerKind);
        }
        for (const id of msg.pr) L.powRemove(id);
        for (const e of msg.ev) {
          if (e.t === "spawn") {
            let r = this.snakes.get(e.id);
            if (!r) {
              r = { id: e.id, alive: true, x: e.x, z: e.z, angle: e.a, score: 0, kills: 0, flags: F_ALIVE };
              this.snakes.set(e.id, r);
            }
            r.alive = true;
            this.dead.delete(e.id);
            r.x = e.x;
            r.z = e.z;
            r.angle = e.a;
            // alte Snapshots dieser Schlange sind ungültig
            for (const s of this.snaps) {
              const q = s.snakes.find((q) => q.id === e.id);
              if (q) { q.x = e.x; q.z = e.z; q.a = e.a; q.flags |= F_ALIVE; }
            }
            if (e.id === this.myId) {
              this.pred = { x: e.x, z: e.z, angle: e.a };
              this.predPrev = { ...this.pred };
              this.pending = [];
              this.predPad = 0;
              this.corr.x = this.corr.z = 0;
              this.predValid = true;
              this.input.angle = e.a;
            }
          } else if (e.t === "die") {
            const r = this.snakes.get(e.id);
            if (r) r.alive = false;
            this.dead.add(e.id);
            if (e.id === this.myId) this.predValid = false;
            if (e.cause === "left") this.snakes.delete(e.id);
          }
          L.event(e);
        }
        break;
      }
    }
  }

  private onFast(buf: ArrayBuffer) {
    if (buf.byteLength < 10 || new DataView(buf).getUint8(0) !== MSG_SNAPSHOT) return;
    const snap = decodeSnapshot(buf);
    const last = this.snaps[this.snaps.length - 1];
    if (last && snap.tick <= last.tick) return; // veraltet
    this.snaps.push(snap);
    if (this.snaps.length > 30) this.snaps.shift();

    // Uhr angleichen: früheste Ankunft zählt, langsam nachgeben
    const sample = snap.tick - (performance.now() * CFG.tickRate) / 1000;
    if (!Number.isFinite(this.tickOffset) || sample > this.tickOffset) this.tickOffset = sample;

    // Eigene Schlange abgleichen
    const mine = snap.snakes.find((s) => s.id === this.myId);
    if (mine) {
      this.me.score = mine.score;
      this.me.flags = mine.flags;
      if ((mine.flags & F_ALIVE) && this.predValid) {
        const base: HeadState = { x: mine.x, z: mine.z, angle: mine.a };
        this.pending = this.pending.filter((p) => p.seq > snap.ack);
        const len = lengthFromScore(mine.score);
        const canBoost = (mine.flags & F_TURBO) !== 0 || mine.score >= CFG.minBoostScore;
        let pad = (mine.flags & F_FAST) !== 0 ? CFG.padDuration * 0.5 : 0;
        for (const p of this.pending) pad = this.predictStep(base, p, canBoost, len, pad);
        this.predPad = pad;
        const ex = this.pred.x - base.x;
        const ez = this.pred.z - base.z;
        if (ex * ex + ez * ez > 25) {
          this.corr.x = this.corr.z = 0; // großer Fehler: sofort springen
        } else {
          this.corr.x += ex;
          this.corr.z += ez;
        }
        // Bewegung des laufenden Ticks beibehalten, damit nichts springt
        const dx = this.pred.x - this.predPrev.x;
        const dz = this.pred.z - this.predPrev.z;
        const da = this.pred.angle - this.predPrev.angle;
        this.pred = base;
        this.predPrev = { x: base.x - dx, z: base.z - dz, angle: base.angle - da };
      }
    }
  }

  private pump() {
    const now = performance.now();
    const dtTick = 1000 / CFG.tickRate;
    this.acc += now - this.lastClientTick;
    this.lastClientTick = now;
    let n = 0;
    while (this.acc >= dtTick && n < 5) {
      this.acc -= dtTick;
      this.clientTick();
      n++;
    }
    if (n === 5) this.acc = 0;
  }

  private clientTick() {
    this.seq++;
    const rec: InputRec = { seq: this.seq, angle: this.input.angle, boost: this.input.boost, jump: this.input.jump };
    this.pending.push(rec);
    if (this.pending.length > 90) this.pending.shift();
    if (this.predValid) {
      this.predPrev = { ...this.pred };
      const len = lengthFromScore(this.me.score);
      const canBoost = (this.me.flags & F_TURBO) !== 0 || this.me.score >= CFG.minBoostScore;
      this.predPad = this.predictStep(this.pred, rec, canBoost, len, this.predPad);
    }
    this.lastPredTime = performance.now();
    this.net.sendFast(encodeInputs(this.pending.slice(-3)));
    // Uhr driftet langsam nach unten, damit sie sich an langsamere Verbindungen anpasst
    this.tickOffset -= 0.002;
  }
  private lastPredTime = performance.now();
  private predPad = 0;

  // Ein Tick der eigenen Schlange, gleiche Reihenfolge wie beim Host. Gibt den Pad-Timer zurück.
  private predictStep(st: HeadState, rec: InputRec, canBoost: boolean, len: number, pad: number): number {
    const dt = 1 / CFG.tickRate;
    pad = Math.max(0, pad - dt);
    if (this.terrain.onPad(st.x, st.z)) pad = CFG.padDuration;
    stepHead(st, rec.angle, speedFor(rec.boost && canBoost, pad > 0), len, dt, this.terrain);
    return pad;
  }

  update(nowMs: number) {
    const dt = Math.min(0.1, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;
    const renderTick = (nowMs * CFG.tickRate) / 1000 + this.tickOffset - (CFG.interpDelayMs * CFG.tickRate) / 1000;

    // passende Snapshots suchen
    let a: Snapshot | undefined;
    let b: Snapshot | undefined;
    for (let i = this.snaps.length - 1; i >= 0; i--) {
      if (this.snaps[i].tick <= renderTick) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
    }
    if (!a) a = this.snaps[0];
    const t = b ? Math.min(1, (renderTick - a.tick) / (b.tick - a.tick)) : 0;

    if (a) {
      for (const sa of a.snakes) {
        let r = this.snakes.get(sa.id);
        if (!r) {
          if (!this.players.some((p) => p.id === sa.id)) continue;
          r = { id: sa.id, alive: false, x: sa.x, z: sa.z, angle: sa.a, score: 0, kills: 0, flags: 0 };
          this.snakes.set(sa.id, r);
        }
        if (sa.id === this.myId) continue;
        const sb = b?.snakes.find((q) => q.id === sa.id);
        if (sb && (sb.flags & F_ALIVE) && Math.hypot(sb.x - sa.x, sb.z - sa.z) < 6) {
          r.x = sa.x + (sb.x - sa.x) * t;
          r.z = sa.z + (sb.z - sa.z) * t;
          r.angle = lerpAngle(sa.a, sb.a, t);
        } else {
          r.x = sa.x;
          r.z = sa.z;
          r.angle = sa.a;
        }
        const src = sb ?? sa;
        r.flags = src.flags;
        r.alive = (src.flags & F_ALIVE) !== 0 && !this.dead.has(sa.id);
        r.score = src.score;
        r.kills = src.kills;
      }
    }
    // Spieler, die nicht mehr in der Liste sind, entfernen
    for (const id of [...this.snakes.keys()]) if (!this.players.some((p) => p.id === id)) this.snakes.delete(id);

    // eigene Schlange: Vorhersage
    const me = this.snakes.get(this.myId);
    if (me) {
      const k = Math.exp(-dt * 8);
      this.corr.x *= k;
      this.corr.z *= k;
      const alpha = Math.min(1, (nowMs - this.lastPredTime) / (1000 / CFG.tickRate));
      if (this.predValid) {
        me.x = this.predPrev.x + (this.pred.x - this.predPrev.x) * alpha + this.corr.x;
        me.z = this.predPrev.z + (this.pred.z - this.predPrev.z) * alpha + this.corr.z;
        me.angle = lerpAngle(this.predPrev.angle, this.pred.angle, alpha);
      }
      me.alive = this.predValid && (this.me.flags & F_ALIVE) !== 0;
      me.score = this.me.score;
      me.flags = this.me.flags;
      const latest = this.snaps[this.snaps.length - 1]?.snakes.find((s) => s.id === this.myId);
      if (latest) me.kills = latest.kills;
    }
  }

  serverTime(nowMs: number): number {
    if (!Number.isFinite(this.tickOffset)) return 0;
    return ((nowMs * CFG.tickRate) / 1000 + this.tickOffset) / CFG.tickRate;
  }

  dispose() {
    clearInterval(this.timer);
    clearInterval(this.pingTimer);
    this.net.close();
  }
}
