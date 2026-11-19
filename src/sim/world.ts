import { CFG, HALF, PowerKind, POWER_KINDS, lengthFromScore, radiusFromLength } from "../core/config";
import { stepHead } from "./movement";
import { Rng } from "../core/rng";
import { Terrain, WATER_LEVEL } from "./terrain";
import { Trail } from "./trail";

// Die komplette Spiellogik. Läuft nur beim Host. Keine Grafik, kein Netzwerk.

export interface Input {
  angle: number;
  boost: boolean;
}

export interface Orb {
  id: number;
  x: number;
  z: number;
  v: number;
  hue: number;
}

export interface PowerUp {
  id: number;
  x: number;
  z: number;
  kind: PowerKind;
}

export type SimEvent =
  | { t: "kill"; killer: number; victim: number }
  | { t: "die"; id: number; cause: "snake" | "wall" | "head" | "left" }
  | { t: "spawn"; id: number; x: number; z: number; a: number }
  | { t: "power"; id: number; kind: PowerKind }
  | { t: "shield"; id: number };

const MAX_SEG = 1500;

export class Snake {
  x = 0;
  z = 0;
  angle = 0;
  score = 0;
  kills = 0;
  best = 0;
  alive = false;
  deadTimer = 0;
  protect = 0;
  boosting = false;
  drainAcc = 0;
  dropAcc = 0;
  power = { magnet: 0, ghost: 0, turbo: 0, shield: 0 };
  trail = new Trail();
  body = new Float32Array(MAX_SEG * 3);
  bodyCount = 0;
  input: Input = { angle: 0, boost: false };

  constructor(
    public id: number,
    public name: string,
    public color: number,
  ) {}

  get length(): number {
    return Math.min(MAX_SEG, lengthFromScore(this.score));
  }
  get radius(): number {
    return radiusFromLength(this.length);
  }
}

const ORB_CELL = 8;
const BODY_CELL = 4;
const key = (cx: number, cz: number) => (cx + 200) * 1000 + (cz + 200);

export class World {
  readonly terrain: Terrain;
  readonly snakes = new Map<number, Snake>();
  readonly orbs = new Map<number, Orb>();
  readonly powerups = new Map<number, PowerUp>();
  tick = 0;

  private rng: Rng;
  private nextOrbId = 1;
  private nextPowId = 1;
  private powTimer = 0;
  private orbGrid = new Map<number, Set<number>>();
  private bodyGrid = new Map<number, number[]>();

  // Änderungen seit dem letzten flush() (für das Netzwerk)
  events: SimEvent[] = [];
  orbAdded: Orb[] = [];
  orbRemoved: number[] = []; // [orbId, eaterId, ...]
  powAdded: PowerUp[] = [];
  powRemoved: number[] = [];

  constructor(readonly seed: number) {
    this.terrain = new Terrain(seed);
    this.rng = new Rng(seed ^ 0x1234567);
    for (let i = 0; i < CFG.orbTarget; i++) this.spawnRandomOrb();
    this.orbAdded.length = 0;
  }

  // ---------- Spieler ----------

  addPlayer(id: number, name: string, color: number): Snake {
    const s = new Snake(id, name, color);
    this.snakes.set(id, s);
    this.spawn(s);
    return s;
  }

  removePlayer(id: number) {
    const s = this.snakes.get(id);
    if (!s) return;
    if (s.alive) this.kill(s, -1, "left");
    this.snakes.delete(id);
  }

  setInput(id: number, input: Input) {
    const s = this.snakes.get(id);
    if (s) s.input = input;
  }

  private spawn(s: Snake) {
    let bx = 0;
    let bz = 0;
    let bestScore = -1;
    for (let i = 0; i < 40; i++) {
      const r = this.rng.range(0, 180);
      const a = this.rng.range(0, Math.PI * 2);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!this.terrain.isFree(x, z, 3)) continue;
      if (this.terrain.heightAt(x, z) < WATER_LEVEL + 0.2) continue;
      let minD = 1e9;
      for (const o of this.snakes.values()) {
        if (o === s || !o.alive) continue;
        minD = Math.min(minD, Math.hypot(o.x - x, o.z - z));
        for (let k = 0; k < o.bodyCount; k += 8) {
          minD = Math.min(minD, Math.hypot(o.body[k * 3] - x, o.body[k * 3 + 2] - z));
        }
      }
      if (minD > bestScore) {
        bestScore = minD;
        bx = x;
        bz = z;
      }
      if (minD > 40) break;
    }
    s.x = bx;
    s.z = bz;
    s.angle = Math.atan2(-bx, -bz) + this.rng.range(-0.6, 0.6); // grob zur Mitte
    s.score = 0;
    s.alive = true;
    s.protect = CFG.spawnProtect;
    s.power = { magnet: 0, ghost: 0, turbo: 0, shield: 0 };
    s.boosting = false;
    s.drainAcc = 0;
    s.dropAcc = 0;
    s.input = { angle: s.angle, boost: false };
    s.trail.resetStraight(s.x, s.z, s.angle, s.length * CFG.segmentSpacing + 2);
    s.bodyCount = s.trail.sample(s.x, 0, s.z, CFG.segmentSpacing, s.length, s.body);
    this.events.push({ t: "spawn", id: s.id, x: s.x, z: s.z, a: s.angle });
  }

  private kill(s: Snake, killer: number, cause: "snake" | "wall" | "head" | "left") {
    s.alive = false;
    s.deadTimer = CFG.respawnDelay;
    // Körper zerfällt in Orbs
    const n = s.bodyCount;
    const step = Math.max(2, Math.ceil(n / 220));
    const count = Math.ceil(n / step);
    const value = Math.max(1, Math.round((s.length * CFG.deathShare) / Math.max(1, count)));
    for (let k = 0; k < n; k += step) {
      const x = s.body[k * 3] + this.rng.range(-0.6, 0.6);
      const z = s.body[k * 3 + 2] + this.rng.range(-0.6, 0.6);
      this.addOrb(x, z, value, (s.color * 45 + this.rng.range(-15, 15) + 360) % 360);
    }
    s.best = Math.max(s.best, s.score);
    this.events.push({ t: "die", id: s.id, cause });
    if (killer >= 0) {
      const k = this.snakes.get(killer);
      if (k) k.kills++;
      this.events.push({ t: "kill", killer, victim: s.id });
    }
  }

  // ---------- Orbs ----------

  private addOrb(x: number, z: number, v: number, hue: number) {
    x = Math.max(-HALF + 3, Math.min(HALF - 3, x));
    z = Math.max(-HALF + 3, Math.min(HALF - 3, z));
    const o: Orb = { id: this.nextOrbId++, x, z, v, hue: Math.round(hue) };
    this.orbs.set(o.id, o);
    const k = key(Math.floor(x / ORB_CELL), Math.floor(z / ORB_CELL));
    let set = this.orbGrid.get(k);
    if (!set) this.orbGrid.set(k, (set = new Set()));
    set.add(o.id);
    this.orbAdded.push(o);
  }

  private removeOrb(o: Orb, eater: number) {
    this.orbs.delete(o.id);
    this.orbGrid.get(key(Math.floor(o.x / ORB_CELL), Math.floor(o.z / ORB_CELL)))?.delete(o.id);
    this.orbRemoved.push(o.id, eater);
  }

  private spawnRandomOrb() {
    for (let i = 0; i < 6; i++) {
      const x = this.rng.range(-HALF + 8, HALF - 8);
      const z = this.rng.range(-HALF + 8, HALF - 8);
      if (!this.terrain.isFree(x, z, 0.6)) continue;
      const big = this.rng.next() < 0.03;
      this.addOrb(x, z, big ? 5 : CFG.orbSmallValue, this.rng.range(0, 360));
      return;
    }
  }

  private spawnPowerUp() {
    for (let i = 0; i < 10; i++) {
      const x = this.rng.range(-HALF + 30, HALF - 30);
      const z = this.rng.range(-HALF + 30, HALF - 30);
      if (!this.terrain.isFree(x, z, 2)) continue;
      const kind = POWER_KINDS[this.rng.int(0, POWER_KINDS.length)];
      const p: PowerUp = { id: this.nextPowId++, x, z, kind };
      this.powerups.set(p.id, p);
      this.powAdded.push(p);
      return;
    }
  }

  // ---------- Ein Tick ----------

  step(dt: number) {
    this.tick++;
    const S = CFG.segmentSpacing;

    // 1) Bewegung
    for (const s of this.snakes.values()) {
      if (!s.alive) {
        s.deadTimer -= dt;
        if (s.deadTimer <= 0) this.spawn(s);
        continue;
      }
      s.protect = Math.max(0, s.protect - dt);
      s.power.magnet = Math.max(0, s.power.magnet - dt);
      s.power.ghost = Math.max(0, s.power.ghost - dt);
      s.power.turbo = Math.max(0, s.power.turbo - dt);

      const len = s.length;
      const canBoost = s.power.turbo > 0 || s.score >= CFG.minBoostScore;
      s.boosting = s.input.boost && canBoost;
      // Lenken, fahren, an Hindernissen abgleiten
      stepHead(s, s.input.angle, s.boosting, len, dt, this.terrain);

      // Boost kostet Länge
      if (s.boosting && s.power.turbo <= 0) {
        s.drainAcc += CFG.boostDrainPerSec * dt;
        const d = Math.floor(s.drainAcc + 1e-9);
        if (d > 0) {
          s.score = Math.max(0, s.score - d);
          s.drainAcc -= d;
        }
        s.dropAcc += dt;
        if (s.dropAcc >= CFG.boostDropInterval && s.bodyCount > 0) {
          s.dropAcc = 0;
          const t = (s.bodyCount - 1) * 3;
          this.addOrb(s.body[t], s.body[t + 2], CFG.boostDropValue, (s.color * 45 + 360) % 360);
        }
      }

      s.trail.push(s.x, s.z);
      s.trail.trim(len * S + 4);
      s.bodyCount = s.trail.sample(s.x, 0, s.z, S, len, s.body);
    }

    // 2) Körper in Raster eintragen
    this.bodyGrid.clear();
    for (const s of this.snakes.values()) {
      if (!s.alive || s.protect > 0) continue;
      for (let k = 0; k < s.bodyCount; k++) {
        const kk = key(Math.floor(s.body[k * 3] / BODY_CELL), Math.floor(s.body[k * 3 + 2] / BODY_CELL));
        let list = this.bodyGrid.get(kk);
        if (!list) this.bodyGrid.set(kk, (list = []));
        list.push(s.id * 65536 + k);
      }
    }

    // 3) Kollisionen sammeln, dann anwenden
    const deaths: { s: Snake; killer: number; cause: "snake" | "wall" | "head" }[] = [];
    const alive = [...this.snakes.values()].filter((s) => s.alive);
    for (const s of alive) {
      const r = s.radius;
      if (Math.abs(s.x) > HALF - r || Math.abs(s.z) > HALF - r) {
        deaths.push({ s, killer: -1, cause: "wall" });
        continue;
      }
      if (s.protect > 0 || s.power.ghost > 0) continue;
      // Kopf gegen Kopf
      let dead = false;
      for (const o of alive) {
        if (o === s || o.protect > 0 || o.power.ghost > 0) continue;
        const rr = r + o.radius;
        if ((o.x - s.x) ** 2 + (o.z - s.z) ** 2 < rr * rr * 0.8) {
          deaths.push({ s, killer: -1, cause: "head" });
          dead = true;
          break;
        }
      }
      if (dead) continue;
      // Kopf gegen fremden Körper
      const cx = Math.floor(s.x / BODY_CELL);
      const cz = Math.floor(s.z / BODY_CELL);
      outer: for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.bodyGrid.get(key(cx + dx, cz + dz));
          if (!list) continue;
          for (const e of list) {
            const oid = Math.floor(e / 65536);
            if (oid === s.id) continue;
            const o = this.snakes.get(oid)!;
            const k = e % 65536;
            const ddx = o.body[k * 3] - s.x;
            const ddz = o.body[k * 3 + 2] - s.z;
            const rr = r * 0.85 + o.radius * 0.85;
            if (ddx * ddx + ddz * ddz < rr * rr) {
              deaths.push({ s, killer: oid, cause: "snake" });
              break outer;
            }
          }
        }
      }
    }
    const handled = new Set<Snake>();
    for (const d of deaths) {
      if (handled.has(d.s) || !d.s.alive) continue;
      handled.add(d.s);
      if (d.cause !== "wall" && d.s.power.shield > 0) {
        d.s.power.shield = 0;
        d.s.protect = 1;
        this.events.push({ t: "shield", id: d.s.id });
        continue;
      }
      this.kill(d.s, d.killer, d.cause);
    }

    // 4) Fressen
    for (const s of this.snakes.values()) {
      if (!s.alive) continue;
      const eatR = s.power.magnet > 0 ? CFG.magnetRange : s.radius + 0.9;
      const cells = Math.ceil(eatR / ORB_CELL);
      const cx = Math.floor(s.x / ORB_CELL);
      const cz = Math.floor(s.z / ORB_CELL);
      for (let dx = -cells; dx <= cells; dx++) {
        for (let dz = -cells; dz <= cells; dz++) {
          const set = this.orbGrid.get(key(cx + dx, cz + dz));
          if (!set || set.size === 0) continue;
          for (const id of set) {
            const o = this.orbs.get(id)!;
            if ((o.x - s.x) ** 2 + (o.z - s.z) ** 2 < eatR * eatR) {
              s.score += o.v;
              this.removeOrb(o, s.id);
            }
          }
        }
      }
      for (const p of this.powerups.values()) {
        const rr = s.radius + 1.3;
        if ((p.x - s.x) ** 2 + (p.z - s.z) ** 2 < rr * rr) {
          if (p.kind === "shield") s.power.shield = 1;
          else s.power[p.kind] = CFG.powerDur[p.kind];
          this.powerups.delete(p.id);
          this.powRemoved.push(p.id);
          this.events.push({ t: "power", id: s.id, kind: p.kind });
        }
      }
      s.best = Math.max(s.best, s.score);
    }

    // 5) Nachschub
    const missing = CFG.orbTarget - this.orbs.size;
    for (let i = 0; i < Math.min(missing, 15); i++) this.spawnRandomOrb();
    this.powTimer += dt;
    if (this.powTimer >= CFG.powerUpInterval) {
      this.powTimer = 0;
      if (this.powerups.size < CFG.maxPowerUps) this.spawnPowerUp();
    }
  }

  flush() {
    const out = {
      events: this.events,
      orbAdded: this.orbAdded,
      orbRemoved: this.orbRemoved,
      powAdded: this.powAdded,
      powRemoved: this.powRemoved,
    };
    this.events = [];
    this.orbAdded = [];
    this.orbRemoved = [];
    this.powAdded = [];
    this.powRemoved = [];
    return out;
  }
}
