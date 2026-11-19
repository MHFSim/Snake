import {
  Color3, Color4, Mesh, MeshBuilder, ParticleSystem, PBRMaterial, Scene, StandardMaterial, Texture, Vector3,
} from "@babylonjs/core";
import { CFG, SNAKE_COLORS, lengthFromScore, radiusFromLength } from "../core/config";
import { Trail } from "../sim/trail";
import { F_BOOST, F_GHOST, F_PROTECT, F_SHIELD } from "../net/protocol";
import type { RSnake } from "../net/session";
import type { TerrainView } from "./terrainView";

// Eine Schlange: Körper aus Kugeln (Thin Instances), Kopf mit Augen, Boost-Partikel.

const lin = (c: Color3) => c.toLinearSpace();

export class SnakeView {
  readonly body: Mesh;
  readonly head: Mesh;
  private mat: PBRMaterial;
  private headMat: PBRMaterial;
  private shield: Mesh;
  private boostPs: ParticleSystem;
  private trail = new Trail();
  private cap = 0;
  private mats!: Float32Array;
  private cols!: Float32Array;
  private pts = new Float32Array(3 * 4096);
  private colA: Color3;
  private colB: Color3;
  private colAg: Color3;
  visible = false;
  headY = 0;
  private emissive = 0;
  private lastTail = new Vector3();

  constructor(scene: Scene, readonly id: number, colorIdx: number, particleTex: Texture) {
    const pair = SNAKE_COLORS[colorIdx % SNAKE_COLORS.length];
    this.colAg = Color3.FromHexString(pair[0]);
    this.colA = lin(this.colAg);
    this.colB = lin(Color3.FromHexString(pair[1]));

    this.mat = new PBRMaterial("snakeMat" + id, scene);
    this.mat.albedoColor = Color3.White();
    this.mat.metallic = 0.05;
    this.mat.roughness = 0.32;
    this.mat.clearCoat.isEnabled = true;
    this.mat.clearCoat.intensity = 0.9;
    this.mat.clearCoat.roughness = 0.06;
    this.mat.environmentIntensity = 0.9;

    this.headMat = this.mat.clone("snakeHeadMat" + id);
    this.headMat.albedoColor = this.colA.clone();

    this.body = MeshBuilder.CreateSphere("snakeBody" + id, { diameter: 2, segments: 10 }, scene);
    this.body.material = this.mat;
    this.body.isPickable = false;
    this.body.alwaysSelectAsActiveMesh = true;
    this.grow(512);

    this.head = MeshBuilder.CreateSphere("snakeHead" + id, { diameter: 2, segments: 16 }, scene);
    this.head.material = this.headMat;
    this.head.isPickable = false;
    this.head.rotationQuaternion = null;
    const white = new PBRMaterial("eyeW" + id, scene);
    white.albedoColor = new Color3(0.95, 0.95, 0.95);
    white.roughness = 0.15;
    white.metallic = 0;
    const black = new PBRMaterial("eyeB" + id, scene);
    black.albedoColor = new Color3(0.02, 0.02, 0.03);
    black.roughness = 0.05;
    black.metallic = 0;
    for (const sx of [-1, 1]) {
      const e = MeshBuilder.CreateSphere("eye", { diameter: 0.62, segments: 10 }, scene);
      e.material = white;
      e.parent = this.head;
      e.position.set(sx * 0.48, 0.42, 0.58);
      e.isPickable = false;
      const p = MeshBuilder.CreateSphere("pupil", { diameter: 0.32, segments: 8 }, scene);
      p.material = black;
      p.parent = this.head;
      p.position.set(sx * 0.55, 0.5, 0.8);
      p.isPickable = false;
    }

    this.shield = MeshBuilder.CreateSphere("shield" + id, { diameter: 2, segments: 16 }, scene);
    const sm = new StandardMaterial("shieldMat" + id, scene);
    sm.disableLighting = true;
    sm.emissiveColor = new Color3(0.3, 1.0, 2.2);
    sm.alpha = 0.22;
    sm.backFaceCulling = false;
    this.shield.material = sm;
    this.shield.isPickable = false;
    this.shield.setEnabled(false);

    this.boostPs = new ParticleSystem("boost" + id, 300, scene);
    this.boostPs.particleTexture = particleTex;
    this.boostPs.emitter = this.lastTail;
    this.boostPs.minEmitBox = new Vector3(-0.3, 0, -0.3);
    this.boostPs.maxEmitBox = new Vector3(0.3, 0.3, 0.3);
    const c = this.colAg;
    this.boostPs.color1 = new Color4(c.r * 2, c.g * 2, c.b * 2, 1);
    this.boostPs.color2 = new Color4(1.5, 1.5, 1.5, 1);
    this.boostPs.colorDead = new Color4(0, 0, 0, 0);
    this.boostPs.minSize = 0.15;
    this.boostPs.maxSize = 0.45;
    this.boostPs.minLifeTime = 0.25;
    this.boostPs.maxLifeTime = 0.6;
    this.boostPs.emitRate = 0;
    this.boostPs.blendMode = ParticleSystem.BLENDMODE_ADD;
    this.boostPs.gravity = new Vector3(0, 1.5, 0);
    this.boostPs.direction1 = new Vector3(-1, 0.5, -1);
    this.boostPs.direction2 = new Vector3(1, 2, 1);
    this.boostPs.minEmitPower = 0.5;
    this.boostPs.maxEmitPower = 1.5;
    this.boostPs.start();

    this.setVisible(false);
  }

  get shadowMeshes(): Mesh[] {
    return [this.body, this.head];
  }

  private grow(n: number) {
    const old = this.mats;
    const oldC = this.cols;
    this.cap = n;
    this.mats = new Float32Array(n * 16);
    this.cols = new Float32Array(n * 4);
    if (old) {
      this.mats.set(old.subarray(0, Math.min(old.length, this.mats.length)));
      this.cols.set(oldC.subarray(0, Math.min(oldC.length, this.cols.length)));
    }
    this.body.thinInstanceSetBuffer("matrix", this.mats, 16, false);
    this.body.thinInstanceSetBuffer("color", this.cols, 4, false);
  }

  private setVisible(v: boolean) {
    this.visible = v;
    this.body.setEnabled(v);
    this.head.setEnabled(v);
    if (!v) this.shield.setEnabled(false);
    if (!v) this.boostPs.emitRate = 0;
  }

  // Neue Spur (Spawn oder Join). pts = Körperpunkte vom Host, sonst gerade Linie.
  reset(x: number, z: number, a: number, terrain: TerrainView, pts?: number[], len = CFG.startLength) {
    const yAt = (px: number, pz: number) => terrain.surfaceAt(px, pz);
    if (pts && pts.length >= 4) {
      this.trail.setFromPoints([x, z, ...pts], yAt);
    } else {
      this.trail.resetStraight(x, z, a, len * CFG.segmentSpacing + 2, yAt);
    }
  }

  hide() {
    this.setVisible(false);
  }

  update(rs: RSnake, time: number, terrain: TerrainView) {
    if (!rs.alive) {
      if (this.visible) this.setVisible(false);
      return;
    }
    if (!this.visible) this.setVisible(true);

    const len = lengthFromScore(rs.score);
    const r = radiusFromLength(len);
    const surf = terrain.surfaceAt(rs.x, rs.z);

    // Spur fortschreiben
    const lx = this.trail.count ? this.trail.lastX() : NaN;
    const lz = this.trail.count ? this.trail.lastZ() : NaN;
    if (!(Math.hypot(rs.x - lx, rs.z - lz) < 0.2)) this.trail.push(rs.x, rs.z, surf);
    const bodyLen = len * CFG.segmentSpacing;
    this.trail.trim(bodyLen + 3);

    // Körper abtasten
    const spacing = r * 0.48;
    const n = Math.min(4000, Math.max(4, Math.floor(bodyLen / spacing)));
    if (n > this.cap) this.grow(Math.max(n, this.cap * 2));
    const got = this.trail.sample(rs.x, surf, rs.z, spacing, n, this.pts);
    const m = this.mats;
    const c = this.cols;
    const A = this.colA;
    const B = this.colB;
    for (let k = 0; k < got; k++) {
      const f = k / got;
      const taper = f < 0.7 ? 1 - f * 0.08 : 0.944 - ((f - 0.7) / 0.3) * 0.58;
      const s = r * taper;
      const o = k * 16;
      m[o] = s; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = s * 0.86; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = s; m[o + 11] = 0;
      m[o + 12] = this.pts[k * 3];
      m[o + 13] = this.pts[k * 3 + 1] + s * 0.78;
      m[o + 14] = this.pts[k * 3 + 2];
      m[o + 15] = 1;
      const stripe = 1 + 0.22 * Math.sin(k * spacing * 1.25);
      c[k * 4] = (A.r + (B.r - A.r) * f) * stripe;
      c[k * 4 + 1] = (A.g + (B.g - A.g) * f) * stripe;
      c[k * 4 + 2] = (A.b + (B.b - A.b) * f) * stripe;
      c[k * 4 + 3] = 1;
    }
    this.body.thinInstanceCount = got;
    this.body.thinInstanceBufferUpdated("matrix");
    this.body.thinInstanceBufferUpdated("color");

    // Kopf
    const ahead = terrain.surfaceAt(rs.x + Math.sin(rs.angle) * 1.5, rs.z + Math.cos(rs.angle) * 1.5);
    const behind = terrain.surfaceAt(rs.x - Math.sin(rs.angle) * 1.5, rs.z - Math.cos(rs.angle) * 1.5);
    this.headY = surf + r * 0.85;
    this.head.position.set(rs.x, this.headY, rs.z);
    this.head.rotation.set(-Math.atan2(ahead - behind, 3) * 0.8, rs.angle, 0);
    this.head.scaling.set(r * 1.18, r * 0.98, r * 1.32);

    // Zustände
    const boosting = (rs.flags & F_BOOST) !== 0;
    const target = boosting ? 1 : 0;
    this.emissive += (target - this.emissive) * 0.15;
    const e = this.emissive * 0.9 + 0.05;
    this.mat.emissiveColor.set(this.colA.r * e, this.colA.g * e, this.colA.b * e);
    this.headMat.emissiveColor.copyFrom(this.mat.emissiveColor);
    const ghost = (rs.flags & F_GHOST) !== 0;
    const protect = (rs.flags & F_PROTECT) !== 0;
    const alpha = ghost ? 0.35 : protect ? 0.45 + 0.25 * Math.sin(time * 14) : 1;
    this.mat.alpha = alpha;
    this.headMat.alpha = alpha;
    const sh = (rs.flags & F_SHIELD) !== 0;
    this.shield.setEnabled(sh);
    if (sh) {
      this.shield.position.copyFrom(this.head.position);
      this.shield.scaling.setAll(r * 1.9 + Math.sin(time * 5) * 0.05);
    }
    if (got > 0) {
      const t = (got - 1) * 3;
      this.lastTail.set(this.pts[t], this.pts[t + 1] + r * 0.6, this.pts[t + 2]);
    }
    this.boostPs.emitRate = boosting ? 140 : 0;
  }

  dispose() {
    this.boostPs.dispose();
    this.body.dispose();
    this.head.dispose(false, true);
    this.shield.dispose();
    this.mat.dispose();
  }
}
