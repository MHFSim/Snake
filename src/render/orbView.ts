import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial, TransformNode } from "@babylonjs/core";
import type { PowerKind } from "../core/config";
import type { TerrainView } from "./terrainView";

// Energie-Orbs als Thin Instances (ein Draw Call), dazu fliegende Orbs beim Fressen und Power-ups.

const CAP = 6000;
const FLY_CAP = 512;

function hueToRgb(h: number, out: number[], mul: number) {
  const s = 1, l = 0.5;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  out[0] = f(0) * mul;
  out[1] = f(8) * mul;
  out[2] = f(4) * mul;
}

interface Fly {
  x: number; y: number; z: number;
  r: number; g: number; b: number; s: number;
  eater: number; t: number;
}

export const POWER_COLORS: Record<PowerKind, Color3> = {
  magnet: new Color3(2.4, 0.4, 0.9),
  ghost: new Color3(1.6, 1.6, 2.4),
  turbo: new Color3(2.6, 1.4, 0.2),
  shield: new Color3(0.3, 1.2, 2.8),
};

export class OrbView {
  private mesh: Mesh;
  private fly: Mesh;
  private mat = new Float32Array(CAP * 16);
  private col = new Float32Array(CAP * 4);
  private flyMat = new Float32Array(FLY_CAP * 16);
  private flyCol = new Float32Array(FLY_CAP * 4);
  private count = 0;
  private idToIdx = new Map<number, number>();
  private idxToId = new Int32Array(CAP);
  private base = new Float32Array(CAP * 4); // x, y, z, scale
  private flying: Fly[] = [];
  private dirty = false;
  private pows = new Map<number, { node: TransformNode; kind: PowerKind; y: number }>();
  private powTemplates: Record<PowerKind, Mesh>;
  private tmp = [0, 0, 0];

  constructor(private scene: Scene, private terrain: TerrainView) {
    const m = new StandardMaterial("orbMat", scene);
    m.disableLighting = true;
    m.diffuseColor = Color3.White();
    m.emissiveColor = Color3.White(); // Farbe kommt pro Orb aus der Instanzfarbe
    m.specularColor = Color3.Black();
    this.mesh = MeshBuilder.CreateIcoSphere("orbs", { radius: 0.36, subdivisions: 2 }, scene);
    this.mesh.material = m;
    this.mesh.thinInstanceSetBuffer("matrix", this.mat, 16, false);
    this.mesh.thinInstanceSetBuffer("color", this.col, 4, false);
    this.mesh.thinInstanceCount = 0;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.isPickable = false;

    // eigenes Mesh (ein Klon würde die Thin-Instance-Puffer teilen)
    this.fly = MeshBuilder.CreateIcoSphere("orbFly", { radius: 0.36, subdivisions: 2 }, scene);
    this.fly.material = m;
    this.fly.isPickable = false;
    this.fly.thinInstanceSetBuffer("matrix", this.flyMat, 16, false);
    this.fly.thinInstanceSetBuffer("color", this.flyCol, 4, false);
    this.fly.thinInstanceCount = 0;
    this.fly.alwaysSelectAsActiveMesh = true;

    this.powTemplates = {
      magnet: this.makePowTemplate("magnet"),
      ghost: this.makePowTemplate("ghost"),
      turbo: this.makePowTemplate("turbo"),
      shield: this.makePowTemplate("shield"),
    };
  }

  private makePowTemplate(kind: PowerKind): Mesh {
    const sc = this.scene;
    const mat = new PBRMaterial("pow_" + kind, sc);
    const c = POWER_COLORS[kind];
    mat.albedoColor = new Color3(c.r / 3, c.g / 3, c.b / 3);
    mat.emissiveColor = c;
    mat.metallic = 0.3;
    mat.roughness = 0.2;
    let m: Mesh;
    if (kind === "magnet") m = MeshBuilder.CreateTorus("pm", { diameter: 1.4, thickness: 0.4, tessellation: 24 }, sc);
    else if (kind === "ghost") m = MeshBuilder.CreateIcoSphere("pg", { radius: 0.8, subdivisions: 1, flat: true }, sc);
    else if (kind === "turbo") m = MeshBuilder.CreatePolyhedron("pt", { type: 1, size: 0.75 }, sc);
    else m = MeshBuilder.CreatePolyhedron("ps", { type: 2, size: 0.6 }, sc);
    m.material = mat;
    const ring = MeshBuilder.CreateTorus("ring", { diameter: 2.6, thickness: 0.06, tessellation: 40 }, sc);
    ring.material = mat;
    ring.parent = m;
    ring.rotation.x = Math.PI / 2;
    m.setEnabled(false);
    m.isPickable = false;
    return m;
  }

  add(id: number, x: number, z: number, v: number, hue: number) {
    if (this.count >= CAP || this.idToIdx.has(id)) return;
    const i = this.count++;
    this.idToIdx.set(id, i);
    this.idxToId[i] = id;
    const s = v >= 5 ? 1.9 : v >= 3 ? 1.45 : v >= 2 ? 1.0 : 0.85;
    const y = this.terrain.surfaceAt(x, z) + 0.55 * s;
    this.base[i * 4] = x;
    this.base[i * 4 + 1] = y;
    this.base[i * 4 + 2] = z;
    this.base[i * 4 + 3] = s;
    this.writeMat(i);
    hueToRgb(hue, this.tmp, v >= 3 ? 2.8 : 1.9);
    this.col[i * 4] = this.tmp[0];
    this.col[i * 4 + 1] = this.tmp[1];
    this.col[i * 4 + 2] = this.tmp[2];
    this.col[i * 4 + 3] = 1;
    this.dirty = true;
  }

  private writeMat(i: number) {
    const o = i * 16;
    const s = this.base[i * 4 + 3];
    const m = this.mat;
    m.fill(0, o, o + 16);
    m[o] = s; m[o + 5] = s; m[o + 10] = s; m[o + 15] = 1;
    m[o + 12] = this.base[i * 4];
    m[o + 13] = this.base[i * 4 + 1];
    m[o + 14] = this.base[i * 4 + 2];
  }

  remove(id: number, eater: number) {
    const i = this.idToIdx.get(id);
    if (i === undefined) return;
    if (eater >= 0 && this.flying.length < FLY_CAP) {
      this.flying.push({
        x: this.base[i * 4], y: this.base[i * 4 + 1], z: this.base[i * 4 + 2],
        r: this.col[i * 4], g: this.col[i * 4 + 1], b: this.col[i * 4 + 2], s: this.base[i * 4 + 3],
        eater, t: 0,
      });
    }
    const last = --this.count;
    if (i !== last) {
      const lastId = this.idxToId[last];
      this.mat.copyWithin(i * 16, last * 16, last * 16 + 16);
      this.col.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.base.copyWithin(i * 4, last * 4, last * 4 + 4);
      this.idxToId[i] = lastId;
      this.idToIdx.set(lastId, i);
    }
    this.idToIdx.delete(id);
    this.dirty = true;
  }

  clear() {
    this.count = 0;
    this.idToIdx.clear();
    this.flying.length = 0;
    this.dirty = true;
    for (const p of this.pows.values()) p.node.dispose();
    this.pows.clear();
  }

  powAdd(id: number, x: number, z: number, kind: PowerKind) {
    const t = this.powTemplates[kind];
    const inst = t.clone("pow" + id, null)!;
    inst.setEnabled(true);
    const y = this.terrain.surfaceAt(x, z) + 1.6;
    inst.position.set(x, y, z);
    this.pows.set(id, { node: inst, kind, y });
  }

  powRemove(id: number) {
    const p = this.pows.get(id);
    if (!p) return;
    p.node.dispose();
    this.pows.delete(id);
  }

  powList(): { x: number; z: number; kind: PowerKind }[] {
    return [...this.pows.values()].map((p) => ({ x: p.node.position.x, z: p.node.position.z, kind: p.kind }));
  }

  // headPos: Kopfposition je Schlange (für fliegende Orbs)
  update(dt: number, time: number, headPos: (id: number) => { x: number; y: number; z: number } | null) {
    if (this.dirty) {
      this.mesh.thinInstanceCount = this.count;
      this.mesh.thinInstanceBufferUpdated("matrix");
      this.mesh.thinInstanceBufferUpdated("color");
      this.dirty = false;
    }
    // Fliegende Orbs zum Fresser ziehen
    let n = 0;
    for (let k = this.flying.length - 1; k >= 0; k--) {
      const f = this.flying[k];
      f.t += dt;
      const h = headPos(f.eater);
      if (!h || f.t > 0.35) {
        this.flying.splice(k, 1);
        continue;
      }
      const a = Math.min(1, dt * 14);
      f.x += (h.x - f.x) * a;
      f.y += (h.y - f.y) * a;
      f.z += (h.z - f.z) * a;
      const s = f.s * (1 - f.t / 0.35);
      const o = n * 16;
      this.flyMat.fill(0, o, o + 16);
      this.flyMat[o] = s; this.flyMat[o + 5] = s; this.flyMat[o + 10] = s; this.flyMat[o + 15] = 1;
      this.flyMat[o + 12] = f.x; this.flyMat[o + 13] = f.y; this.flyMat[o + 14] = f.z;
      this.flyCol[n * 4] = f.r * 1.5; this.flyCol[n * 4 + 1] = f.g * 1.5; this.flyCol[n * 4 + 2] = f.b * 1.5; this.flyCol[n * 4 + 3] = 1;
      n++;
    }
    this.fly.thinInstanceCount = n;
    if (n > 0) {
      this.fly.thinInstanceBufferUpdated("matrix");
      this.fly.thinInstanceBufferUpdated("color");
    }
    // Power-ups schweben und drehen sich
    for (const p of this.pows.values()) {
      p.node.rotation.y = time * 1.6;
      p.node.position.y = p.y + Math.sin(time * 2 + p.node.position.x) * 0.25;
    }
  }
}
