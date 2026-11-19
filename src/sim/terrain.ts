import { Simplex2 } from "../core/noise";
import { Rng } from "../core/rng";
import { HALF } from "../core/config";

// Gelände: wird von Spiellogik UND Grafik benutzt. Nur aus dem Seed berechnet.

export const WATER_LEVEL = 0;

export interface Biome {
  meadow: number;
  forest: number;
  dunes: number;
  lake: number;
}

export type ObstacleKind = "tree" | "pine" | "rock" | "crystal";
export interface Obstacle {
  kind: ObstacleKind;
  x: number;
  z: number;
  r: number; // Kollisionsradius
  scale: number;
  rot: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Mittelpunkte der Außen-Biome (Winkel in Radiant)
const FOREST_A = Math.PI * 0.5;
const DUNES_A = Math.PI * (7 / 6);
const LAKE_A = Math.PI * (11 / 6);

function angDist(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

export class Terrain {
  readonly seed: number;
  private n1: Simplex2;
  private n2: Simplex2;
  private n3: Simplex2;
  readonly obstacles: Obstacle[] = [];
  private obstGrid = new Map<number, Obstacle[]>();
  private static CELL = 8;

  constructor(seed: number) {
    this.seed = seed;
    this.n1 = new Simplex2(seed);
    this.n2 = new Simplex2(seed ^ 0x9e3779b9);
    this.n3 = new Simplex2(seed ^ 0x51ed270b);
    this.placeObstacles();
  }

  biome(x: number, z: number): Biome {
    const d = Math.hypot(x, z) + this.n2.noise(x / 60, z / 60) * 25;
    const meadow = 1 - smooth(85, 135, d);
    const ang = Math.atan2(z, x) + this.n3.noise(x / 120, z / 120) * 0.5;
    const wf = 1 - smooth(0.6, 1.35, angDist(ang, FOREST_A));
    const wd = 1 - smooth(0.6, 1.35, angDist(ang, DUNES_A));
    const wl = 1 - smooth(0.6, 1.35, angDist(ang, LAKE_A));
    const sum = wf + wd + wl + 1e-6;
    const outer = 1 - meadow;
    return { meadow, forest: (wf / sum) * outer, dunes: (wd / sum) * outer, lake: (wl / sum) * outer };
  }

  heightAt(x: number, z: number): number {
    return this.heightWithBiome(x, z, this.biome(x, z));
  }

  heightWithBiome(x: number, z: number, b: Biome): number {
    // sanfte Grundhügel
    let h = 3 + this.n1.fbm(x / 140, z / 140, 4) * 5;
    // Dünen: weiche Rippen
    if (b.dunes > 0.01) {
      const ridge = 1 - Math.abs(Math.sin((x * 0.8 + z * 0.35) / 11 + this.n2.noise(x / 50, z / 50) * 1.6));
      h += b.dunes * (ridge * ridge * 3.2 + 1.5);
    }
    // Wald: etwas unruhiger
    if (b.forest > 0.01) h += b.forest * this.n2.fbm(x / 45, z / 45, 2) * 2.2;
    // See: Becken mit Inseln
    if (b.lake > 0.01) {
      const islands = this.n3.fbm(x / 38, z / 38, 3);
      const lakeH = -1.8 + Math.max(0, islands - 0.15) * 7;
      const w = smooth(0.25, 0.75, b.lake);
      h = h * (1 - w) + lakeH * w;
    }
    // Rand: leicht ansteigen
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h += smooth(HALF - 40, HALF, edge) * 4;
    return h;
  }

  // Höhe, auf der eine Schlange fährt (schwimmt auf dem Wasser)
  surfaceAt(x: number, z: number): number {
    return Math.max(this.heightAt(x, z), WATER_LEVEL);
  }

  private placeObstacles() {
    const rng = new Rng(this.seed ^ 0xabcdef);
    const C = Terrain.CELL;
    for (let gx = -HALF + C; gx < HALF - C; gx += C) {
      for (let gz = -HALF + C; gz < HALF - C; gz += C) {
        const x = gx + rng.range(0.5, C - 0.5);
        const z = gz + rng.range(0.5, C - 0.5);
        const roll = rng.next();
        const rot = rng.range(0, Math.PI * 2);
        const sc = rng.range(0.8, 1.35);
        if (Math.hypot(x, z) < 45) continue; // Spawnbereich frei
        const b = this.biome(x, z);
        const h = this.heightAt(x, z);
        let kind: ObstacleKind | null = null;
        if (h < WATER_LEVEL + 0.3) {
          kind = null;
        } else if (b.forest > 0.5 && roll < 0.42) {
          kind = roll < 0.24 ? "pine" : "tree";
        } else if (b.lake > 0.4 && roll < 0.12) {
          kind = "crystal";
        } else if (b.meadow > 0.5 && roll < 0.025) {
          kind = "tree";
        } else if (b.dunes > 0.5 && roll < 0.045) {
          kind = "rock";
        } else if (roll < 0.012) {
          kind = "rock";
        }
        if (!kind) continue;
        const r = kind === "rock" ? 1.3 * sc : kind === "crystal" ? 0.9 * sc : 0.7 * sc;
        const o: Obstacle = { kind, x, z, r, scale: sc, rot };
        this.obstacles.push(o);
        const key = this.cellKey(x, z);
        let list = this.obstGrid.get(key);
        if (!list) this.obstGrid.set(key, (list = []));
        list.push(o);
      }
    }
  }

  private cellKey(x: number, z: number): number {
    const C = Terrain.CELL;
    return (Math.floor((x + HALF) / C) << 10) | Math.floor((z + HALF) / C);
  }

  // Schiebt einen Kreis aus Hindernissen heraus. Gibt korrigierte Position zurück.
  pushOut(x: number, z: number, r: number, out: { x: number; z: number }): boolean {
    const C = Terrain.CELL;
    const cx = Math.floor((x + HALF) / C);
    const cz = Math.floor((z + HALF) / C);
    let hit = false;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.obstGrid.get(((cx + dx) << 10) | (cz + dz));
        if (!list) continue;
        for (const o of list) {
          const ddx = x - o.x;
          const ddz = z - o.z;
          const min = o.r + r;
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 < min * min) {
            const d = Math.sqrt(d2) || 0.001;
            x = o.x + (ddx / d) * min;
            z = o.z + (ddz / d) * min;
            hit = true;
          }
        }
      }
    }
    out.x = x;
    out.z = z;
    return hit;
  }

  isFree(x: number, z: number, r: number): boolean {
    const p = { x, z };
    return !this.pushOut(x, z, r, p);
  }
}
