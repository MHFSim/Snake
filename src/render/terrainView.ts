import {
  Color3, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial, Texture, VertexBuffer, VertexData, Vector3, Matrix, Quaternion,
} from "@babylonjs/core";
import { HALF } from "../core/config";
import { Rng } from "../core/rng";
import { Terrain, WATER_LEVEL, ObstacleKind } from "../sim/terrain";
import { makeDetailTexture, makeGridTexture, makeNormalMap } from "./textures";

// Gelände, Wasser, Grenze, Bäume, Felsen, Kristalle, Gras.

const STEP = 1.5; // Rasterabstand der Höhenkarte in Metern
const CHUNKS = 8; // 8 x 8 Chunks à 75 m
const CHUNK = (HALF * 2) / CHUNKS;
const CELLS = Math.round(CHUNK / STEP); // 50 Zellen pro Chunk

const hex = (h: string) => Color3.FromHexString(h);
const C = {
  grassA: hex("#4e8a2c"), grassB: hex("#86b83f"),
  forestA: hex("#355a22"), forestB: hex("#5b4a2b"),
  sandA: hex("#d4ad6a"), sandB: hex("#f0d9a2"),
  shore: hex("#e2c88f"), under: hex("#1f4f4c"),
  island: hex("#4f9a62"), rock: hex("#7a7166"),
};

export class TerrainView {
  readonly gridN: number;
  heights!: Float32Array;
  private colors!: Float32Array;
  readonly meshes: Mesh[] = [];
  readonly shadowCasters: Mesh[] = [];
  grass: Mesh | null = null;
  water!: Mesh;
  private waterBump!: Texture;
  private wallTex!: Texture;
  readonly crystalMat: PBRMaterial;

  constructor(private scene: Scene, private terrain: Terrain) {
    this.gridN = Math.round((HALF * 2) / STEP) + 1;
    this.computeGrid();
    this.buildChunks();
    this.buildWater();
    this.buildWall();
    this.crystalMat = this.buildObstacles();
    this.buildGrass();
  }

  // ---------- Höhenraster + Farben ----------

  private computeGrid() {
    const N = this.gridN;
    this.heights = new Float32Array(N * N);
    this.colors = new Float32Array(N * N * 3);
    const rng = new Rng(this.terrain.seed ^ 77);
    const t = this.terrain;
    const tmp = new Color3();
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const x = -HALF + i * STEP;
        const z = -HALF + j * STEP;
        const b = t.biome(x, z);
        const h = t.heightWithBiome(x, z, b);
        this.heights[j * N + i] = h;
        const n = rng.next();
        // Grundfarbe aus den Biomen mischen
        const r = { r: 0, g: 0, b: 0 };
        const add = (c: Color3, w: number) => { r.r += c.r * w; r.g += c.g * w; r.b += c.b * w; };
        Color3.LerpToRef(C.grassA, C.grassB, n * 0.6 + 0.2, tmp);
        add(tmp, b.meadow);
        Color3.LerpToRef(C.forestA, C.forestB, n * 0.45, tmp);
        add(tmp, b.forest);
        Color3.LerpToRef(C.sandA, C.sandB, Math.min(1, Math.max(0, (h - 3) / 6)) * 0.7 + n * 0.3, tmp);
        add(tmp, b.dunes);
        Color3.LerpToRef(C.island, C.grassB, n * 0.4, tmp);
        add(tmp, b.lake);
        let col = new Color3(r.r, r.g, r.b);
        // Ufer und Unterwasser
        if (h < WATER_LEVEL + 0.9) {
          const k = Math.min(1, Math.max(0, (WATER_LEVEL + 0.9 - h) / 0.9));
          col = Color3.Lerp(col, C.shore, k);
        }
        if (h < WATER_LEVEL) {
          col = Color3.Lerp(C.shore, C.under, Math.min(1, (WATER_LEVEL - h) / 2.2));
        }
        this.colors.set([col.r, col.g, col.b], (j * N + i) * 3);
      }
    }
    // Steile Stellen: Fels
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        const dx = (this.heights[k + 1] - this.heights[k - 1]) / (2 * STEP);
        const dz = (this.heights[k + N] - this.heights[k - N]) / (2 * STEP);
        const slope = Math.hypot(dx, dz);
        if (slope > 0.45 && this.heights[k] > WATER_LEVEL) {
          const w = Math.min(1, (slope - 0.45) * 3);
          for (let c = 0; c < 3; c++) {
            const rc = c === 0 ? C.rock.r : c === 1 ? C.rock.g : C.rock.b;
            this.colors[k * 3 + c] = this.colors[k * 3 + c] * (1 - w) + rc * w;
          }
        }
      }
    }
  }

  private h(i: number, j: number): number {
    const N = this.gridN;
    i = Math.max(0, Math.min(N - 1, i));
    j = Math.max(0, Math.min(N - 1, j));
    return this.heights[j * N + i];
  }

  // Höhe aus dem Raster (bilinear), schnell für die Darstellung
  heightAt(x: number, z: number): number {
    const fx = (x + HALF) / STEP;
    const fz = (z + HALF) / STEP;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const a = this.h(i, j) + (this.h(i + 1, j) - this.h(i, j)) * tx;
    const b = this.h(i, j + 1) + (this.h(i + 1, j + 1) - this.h(i, j + 1)) * tx;
    return a + (b - a) * tz;
  }
  surfaceAt(x: number, z: number): number {
    return Math.max(WATER_LEVEL, this.heightAt(x, z));
  }

  // ---------- Chunks mit LOD ----------

  private buildChunk(ci: number, cj: number, stride: number, skirt: boolean): VertexData {
    const N = this.gridN;
    const n = CELLS / stride;
    const i0 = ci * CELLS;
    const j0 = cj * CELLS;
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const vert = (gi: number, gj: number, drop: number) => {
      const x = -HALF + gi * STEP;
      const z = -HALF + gj * STEP;
      const y = this.h(gi, gj) - drop;
      pos.push(x, y, z);
      const nx = this.h(gi - 1, gj) - this.h(gi + 1, gj);
      const nz = this.h(gi, gj - 1) - this.h(gi, gj + 1);
      const ny = 2 * STEP;
      const l = Math.hypot(nx, ny, nz);
      nor.push(nx / l, ny / l, nz / l);
      const k = (Math.min(N - 1, gj) * N + Math.min(N - 1, gi)) * 3;
      col.push(
        Math.pow(this.colors[k], 2.2), Math.pow(this.colors[k + 1], 2.2), Math.pow(this.colors[k + 2], 2.2), 1,
      );
      uv.push(x, z);
      return pos.length / 3 - 1;
    };
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vert(i0 + i * stride, j0 + j * stride, 0);
    const at = (i: number, j: number) => j * (n + 1) + i;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
        idx.push(a, b, c, b, d, c);
      }
    }
    if (skirt) {
      // Schürze nach unten, damit zwischen LOD-Stufen keine Lücken sichtbar sind
      const edge = (list: [number, number][], flip: boolean) => {
        for (let k = 0; k < list.length - 1; k++) {
          const [ia, ja] = list[k];
          const [ib, jb] = list[k + 1];
          const top0 = at(ia, ja), top1 = at(ib, jb);
          const b0 = vert(i0 + ia * stride, j0 + ja * stride, 3);
          const b1 = vert(i0 + ib * stride, j0 + jb * stride, 3);
          if (flip) idx.push(top0, b0, top1, top1, b0, b1);
          else idx.push(top0, top1, b0, top1, b1, b0);
        }
      };
      const s1: [number, number][] = [], s2: [number, number][] = [], s3: [number, number][] = [], s4: [number, number][] = [];
      for (let k = 0; k <= n; k++) { s1.push([k, 0]); s2.push([k, n]); s3.push([0, k]); s4.push([n, k]); }
      edge(s1, false); edge(s2, true); edge(s3, true); edge(s4, false);
    }
    const vd = new VertexData();
    vd.positions = pos;
    vd.normals = nor;
    vd.colors = col;
    vd.uvs = uv;
    vd.indices = idx;
    return vd;
  }

  private buildChunks() {
    const mat = new PBRMaterial("terrainMat", this.scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.92;
    mat.environmentIntensity = 0.55;
    const detail = makeDetailTexture(this.scene, 256, this.terrain.seed);
    detail.uScale = detail.vScale = 1 / 7;
    mat.albedoTexture = detail;
    const bump = makeNormalMap(this.scene, "terrainBump", 256, this.terrain.seed ^ 5, 3.5);
    bump.uScale = bump.vScale = 1 / 5;
    bump.level = 0.6;
    mat.bumpTexture = bump;
    mat.maxSimultaneousLights = 4;

    for (let cj = 0; cj < CHUNKS; cj++) {
      for (let ci = 0; ci < CHUNKS; ci++) {
        const m0 = new Mesh(`chunk_${ci}_${cj}`, this.scene);
        this.buildChunk(ci, cj, 1, true).applyToMesh(m0);
        const m1 = new Mesh(`chunk_${ci}_${cj}_l1`, this.scene);
        this.buildChunk(ci, cj, 2, true).applyToMesh(m1);
        const m2 = new Mesh(`chunk_${ci}_${cj}_l2`, this.scene);
        this.buildChunk(ci, cj, 5, true).applyToMesh(m2);
        for (const m of [m0, m1, m2]) {
          m.material = mat;
          m.receiveShadows = true;
          m.isPickable = false;
          m.freezeWorldMatrix();
          m.doNotSyncBoundingInfo = true;
        }
        m0.addLODLevel(140, m1);
        m0.addLODLevel(280, m2);
        this.meshes.push(m0);
      }
    }
    mat.freeze();
  }

  // ---------- Wasser ----------

  private buildWater() {
    const water = MeshBuilder.CreateGround("water", { width: HALF * 2, height: HALF * 2, subdivisions: 1 }, this.scene);
    water.position.y = WATER_LEVEL;
    const mat = new PBRMaterial("waterMat", this.scene);
    mat.albedoColor = new Color3(0.01, 0.09, 0.11);
    mat.metallic = 0;
    mat.roughness = 0.08;
    mat.alpha = 0.78;
    mat.environmentIntensity = 1.1;
    mat.reflectivityColor = new Color3(0.4, 0.4, 0.4);
    this.waterBump = makeNormalMap(this.scene, "waterBump", 256, 99, 6, [4, 8, 16], [1, 0.5, 0.3]);
    this.waterBump.uScale = this.waterBump.vScale = 60;
    this.waterBump.level = 0.35;
    mat.bumpTexture = this.waterBump;
    mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    water.material = mat;
    water.receiveShadows = true;
    water.isPickable = false;
    this.water = water;
  }

  // ---------- Energiewand am Kartenrand ----------

  private buildWall() {
    const mat = new StandardMaterial("wallMat", this.scene);
    this.wallTex = makeGridTexture(this.scene);
    this.wallTex.uScale = 60;
    this.wallTex.vScale = 1;
    mat.diffuseTexture = this.wallTex;
    mat.opacityTexture = this.wallTex;
    mat.emissiveColor = new Color3(0.4, 1.6, 2.2);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 0.9;
    const H = 14;
    const L = HALF * 2;
    const sides = [
      { x: 0, z: HALF, r: 0 }, { x: 0, z: -HALF, r: Math.PI },
      { x: HALF, z: 0, r: Math.PI / 2 }, { x: -HALF, z: 0, r: -Math.PI / 2 },
    ];
    for (const s of sides) {
      const p = MeshBuilder.CreatePlane("wall", { width: L, height: H }, this.scene);
      p.position.set(s.x, H / 2 - 2, s.z);
      p.rotation.y = s.r;
      p.material = mat;
      p.isPickable = false;
    }
  }

  // ---------- Hindernisse ----------

  private jitter(mesh: Mesh, amount: number, seed: number) {
    const pos = mesh.getVerticesData(VertexBuffer.PositionKind)!;
    for (let i = 0; i < pos.length; i += 3) {
      const key = Math.round(pos[i] * 100) * 73856093 ^ Math.round(pos[i + 1] * 100) * 19349663 ^ Math.round(pos[i + 2] * 100) * 83492791 ^ seed;
      const r = ((key >>> 0) % 1000) / 1000 - 0.5;
      const r2 = (((key * 31) >>> 0) % 1000) / 1000 - 0.5;
      pos[i] += r * amount;
      pos[i + 1] += r2 * amount;
      pos[i + 2] += (r - r2) * amount * 0.7;
    }
    mesh.updateVerticesData(VertexBuffer.PositionKind, pos);
  }

  private colorize(mesh: Mesh, c: Color3, vary = 0.08) {
    const n = mesh.getTotalVertices();
    const cols: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = 1 + (((i * 2654435761) >>> 0) % 1000 / 1000 - 0.5) * vary * 2;
      cols.push(Math.pow(c.r * f, 2.2), Math.pow(c.g * f, 2.2), Math.pow(c.b * f, 2.2), 1);
    }
    mesh.setVerticesData(VertexBuffer.ColorKind, cols);
  }

  private template(kind: ObstacleKind): Mesh {
    const sc = this.scene;
    const parts: Mesh[] = [];
    if (kind === "tree") {
      const trunk = MeshBuilder.CreateCylinder("t", { height: 2.4, diameterTop: 0.28, diameterBottom: 0.45, tessellation: 6 }, sc);
      trunk.position.y = 1.2;
      this.colorize(trunk, hex("#6b4a2b"));
      const crown = MeshBuilder.CreateIcoSphere("c", { radius: 1.7, subdivisions: 1, flat: true }, sc);
      crown.position.y = 3.3;
      crown.scaling.set(1, 0.85, 1);
      this.jitter(crown, 0.5, 1);
      this.colorize(crown, hex("#4c8f2e"), 0.15);
      const crown2 = MeshBuilder.CreateIcoSphere("c2", { radius: 1.1, subdivisions: 1, flat: true }, sc);
      crown2.position.set(0.7, 4.2, -0.3);
      this.jitter(crown2, 0.35, 2);
      this.colorize(crown2, hex("#65a838"), 0.15);
      parts.push(trunk, crown, crown2);
    } else if (kind === "pine") {
      const trunk = MeshBuilder.CreateCylinder("t", { height: 1.8, diameterTop: 0.25, diameterBottom: 0.4, tessellation: 6 }, sc);
      trunk.position.y = 0.9;
      this.colorize(trunk, hex("#5a3d24"));
      parts.push(trunk);
      const tiers = [[1.9, 3.4, 2.4], [3.1, 2.6, 2.0], [4.1, 1.8, 1.7]];
      tiers.forEach(([y, d, h], i) => {
        const cone = MeshBuilder.CreateCylinder("p", { height: h, diameterTop: 0, diameterBottom: d, tessellation: 7 }, sc);
        cone.position.y = y;
        cone.rotation.y = i * 0.5;
        this.colorize(cone, i === 2 ? hex("#3d7a3a") : hex("#2f6532"), 0.12);
        parts.push(cone);
      });
    } else if (kind === "rock") {
      const r = MeshBuilder.CreateIcoSphere("r", { radius: 1.4, subdivisions: 1, flat: true }, sc);
      r.scaling.set(1.1, 0.7, 0.9);
      r.position.y = 0.3;
      this.jitter(r, 0.6, 3);
      this.colorize(r, hex("#8a8278"), 0.12);
      parts.push(r);
    } else {
      const angles = [[0, 0, 3.2], [0.45, 1.8, 2.2], [-0.4, 3.9, 1.7]];
      angles.forEach(([tilt, yaw, h]) => {
        const c = MeshBuilder.CreateCylinder("k", { height: h, diameterTop: 0.05, diameterBottom: 0.75, tessellation: 6 }, sc);
        c.position.y = h / 2 - 0.2;
        c.rotation.set(tilt, yaw, tilt * 0.5);
        this.colorize(c, hex("#9ff6ff"), 0.1);
        parts.push(c);
      });
    }
    const merged = Mesh.MergeMeshes(parts, true, true)!;
    merged.convertToFlatShadedMesh();
    return merged;
  }

  private buildObstacles(): PBRMaterial {
    const mat = new PBRMaterial("obstMat", this.scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.85;
    mat.environmentIntensity = 0.6;

    const crystalMat = new PBRMaterial("crystalMat", this.scene);
    crystalMat.albedoColor = new Color3(0.4, 0.8, 0.9);
    crystalMat.metallic = 0.1;
    crystalMat.roughness = 0.15;
    crystalMat.emissiveColor = new Color3(0.25, 1.1, 1.5);
    crystalMat.emissiveIntensity = 1.4;

    const kinds: ObstacleKind[] = ["tree", "pine", "rock", "crystal"];
    for (const kind of kinds) {
      const list = this.terrain.obstacles.filter((o) => o.kind === kind);
      if (!list.length) continue;
      const mesh = this.template(kind);
      mesh.name = "obst_" + kind;
      mesh.material = kind === "crystal" ? crystalMat : mat;
      const buf = new Float32Array(list.length * 16);
      const m = new Matrix();
      const q = new Quaternion();
      const s = new Vector3();
      const p = new Vector3();
      list.forEach((o, i) => {
        Quaternion.RotationYawPitchRollToRef(o.rot, 0, 0, q);
        s.setAll(o.scale);
        p.set(o.x, this.heightAt(o.x, o.z) - 0.15, o.z);
        Matrix.ComposeToRef(s, q, p, m);
        m.copyToArray(buf, i * 16);
      });
      mesh.thinInstanceSetBuffer("matrix", buf, 16, true);
      mesh.receiveShadows = true;
      mesh.isPickable = false;
      mesh.alwaysSelectAsActiveMesh = true;
      this.shadowCasters.push(mesh);
    }
    return crystalMat;
  }

  // ---------- Gras ----------

  private buildGrass() {
    const parts: Mesh[] = [];
    for (let b = 0; b < 5; b++) {
      const blade = new Mesh("blade", this.scene);
      const w = 0.09;
      const h = 0.55 + (b % 3) * 0.15;
      const vd = new VertexData();
      vd.positions = [-w, 0, 0, w, 0, 0, 0.08 * (b - 2), h, 0.05];
      vd.indices = [0, 1, 2];
      vd.normals = [0, 0.3, 1, 0, 0.3, 1, 0, 0.6, 1];
      const base = hex("#3e7a25"), tip = hex("#a8cf55");
      vd.colors = [
        Math.pow(base.r, 2.2), Math.pow(base.g, 2.2), Math.pow(base.b, 2.2), 1,
        Math.pow(base.r, 2.2), Math.pow(base.g, 2.2), Math.pow(base.b, 2.2), 1,
        Math.pow(tip.r, 2.2), Math.pow(tip.g, 2.2), Math.pow(tip.b, 2.2), 1,
      ];
      vd.applyToMesh(blade);
      blade.rotation.y = (b / 5) * Math.PI;
      blade.position.x = (b - 2) * 0.07;
      parts.push(blade);
    }
    const grass = Mesh.MergeMeshes(parts, true, true)!;
    grass.name = "grass";
    const mat = new PBRMaterial("grassMat", this.scene);
    mat.albedoColor = Color3.White();
    mat.metallic = 0;
    mat.roughness = 0.9;
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    mat.environmentIntensity = 0.5;
    grass.material = mat;

    const rng = new Rng(this.terrain.seed ^ 4242);
    const mats: number[] = [];
    const m = new Matrix();
    const q = new Quaternion();
    const s = new Vector3();
    const p = new Vector3();
    let tries = 0;
    while (mats.length / 16 < 16000 && tries < 120000) {
      tries++;
      const x = rng.range(-HALF + 5, HALF - 5);
      const z = rng.range(-HALF + 5, HALF - 5);
      const b = this.terrain.biome(x, z);
      const green = b.meadow + b.forest * 0.8 + b.lake * 0.5;
      if (rng.next() > green) continue;
      const y = this.heightAt(x, z);
      if (y < WATER_LEVEL + 0.4) continue;
      Quaternion.RotationYawPitchRollToRef(rng.range(0, Math.PI * 2), 0, 0, q);
      s.setAll(rng.range(0.7, 1.4));
      p.set(x, y - 0.05, z);
      Matrix.ComposeToRef(s, q, p, m);
      m.toArray().forEach((v) => mats.push(v));
    }
    grass.thinInstanceSetBuffer("matrix", new Float32Array(mats), 16, true);
    grass.receiveShadows = true;
    grass.isPickable = false;
    grass.alwaysSelectAsActiveMesh = true;
    this.grass = grass;
  }

  update(dt: number, time: number) {
    this.waterBump.uOffset = time * 0.004;
    this.waterBump.vOffset = time * 0.0025;
    this.wallTex.vOffset = -time * 0.15;
    void dt;
  }

  // Kleines Bild der Karte für die Minimap
  minimapImage(size: number): ImageData {
    const img = new ImageData(size, size);
    const N = this.gridN;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gi = Math.floor((x / size) * (N - 1));
        const gj = Math.floor(((size - 1 - y) / size) * (N - 1));
        const k = gj * N + gi;
        let r = this.colors[k * 3], g = this.colors[k * 3 + 1], b = this.colors[k * 3 + 2];
        if (this.heights[k] < WATER_LEVEL) { r = 0.1; g = 0.35; b = 0.45; }
        const i = (y * size + x) * 4;
        img.data[i] = r * 230; img.data[i + 1] = g * 230; img.data[i + 2] = b * 230; img.data[i + 3] = 235;
      }
    }
    return img;
  }
}
