import {
  AbstractEngine, CascadedShadowGenerator, Color3, Color4, DefaultRenderingPipeline, DirectionalLight, HemisphericLight,
  ImageProcessingConfiguration, Matrix, Mesh, MeshBuilder, StandardMaterial, ReflectionProbe, RenderTargetTexture, Scene, SSAO2RenderingPipeline,
  ShadowGenerator, UniversalCamera, Vector3,
} from "@babylonjs/core";
import { PowerKind, SNAKE_COLORS, lengthFromScore, radiusFromLength } from "../core/config";
import type { SimEvent } from "../sim/world";
import type { PlayerInfo } from "../net/protocol";
import { F_BOOST } from "../net/protocol";
import type { Session, SessionListener } from "../net/session";
import { lerpAngle } from "../net/session";
import { Effects } from "./effects";
import { OrbView, POWER_COLORS } from "./orbView";
import { SnakeView } from "./snakeView";
import { TerrainView } from "./terrainView";
import { makeParticleTexture, makeSkyTexture, makeSunTexture } from "./textures";

export type Quality = "low" | "medium" | "high";

const QUALITY: Record<Quality, { ratio: number; shadow: number; cascades: number; maxZ: number; ssao: boolean; grass: boolean }> = {
  low: { ratio: 0.75, shadow: 1024, cascades: 2, maxZ: 50, ssao: false, grass: false },
  medium: { ratio: 1.25, shadow: 1024, cascades: 2, maxZ: 80, ssao: false, grass: true },
  high: { ratio: 2, shadow: 2048, cascades: 3, maxZ: 110, ssao: true, grass: true },
};

export interface RendererHooks {
  event(ev: SimEvent): void;
  players(list: PlayerInfo[]): void;
  disconnected(reason: string): void;
  qualityChanged(q: Quality): void;
}

export class GameRenderer implements SessionListener {
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  terrainView!: TerrainView;
  private sun: DirectionalLight;
  private csm: CascadedShadowGenerator | null = null;
  private pipeline: DefaultRenderingPipeline | null = null;
  private ssao: SSAO2RenderingPipeline | null = null;
  private orbs!: OrbView;
  private effects!: Effects;
  private views = new Map<number, SnakeView>();
  private colors = new Map<number, number>();
  private particleTex;
  private session: Session | null = null;
  private time = 0;
  private camYaw = 0;
  private camDist = 12;
  private shake = 0;
  private camInit = false;
  quality: Quality = "medium";
  autoQuality = true;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private sinceStart = 0;
  fps = 60;
  private pending: (() => void)[] = [];
  private ready = false;

  constructor(readonly engine: AbstractEngine, private hooks: RendererHooks) {
    const scene = (this.scene = new Scene(engine));
    scene.skipPointerMovePicking = true;
    scene.clearColor = new Color4(0.75, 0.8, 0.86, 1);
    scene.fogMode = Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.0033;
    scene.fogColor = new Color3(0.8, 0.85, 0.88);
    scene.ambientColor = new Color3(0.2, 0.2, 0.2);

    const cam = (this.camera = new UniversalCamera("cam", new Vector3(0, 30, -40), scene));
    cam.inputs.clear();
    cam.minZ = 0.3;
    cam.maxZ = 1000;
    cam.fov = 0.95;

    // Sonne bei goldener Stunde
    const dir = new Vector3(-0.55, -0.4, -0.72).normalize();
    this.sun = new DirectionalLight("sun", dir, scene);
    this.sun.intensity = 3.4;
    this.sun.diffuse = new Color3(1, 0.9, 0.76);
    this.sun.specular = new Color3(1, 0.92, 0.8);
    this.sun.position = dir.scale(-200);
    const hemi = new HemisphericLight("hemi", new Vector3(0.1, 1, 0.2), scene);
    hemi.intensity = 0.45;
    hemi.diffuse = new Color3(0.75, 0.85, 1);
    hemi.groundColor = new Color3(0.35, 0.3, 0.22);

    // Himmel: Farbverlauf-Kugel + leuchtende Sonne (Bloom)
    const skybox = MeshBuilder.CreateSphere("skyBox", { diameter: 900, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    const skyMat = new StandardMaterial("skyMat", scene);
    skyMat.disableLighting = true;
    skyMat.diffuseColor = Color3.Black();
    skyMat.specularColor = Color3.Black();
    skyMat.emissiveTexture = makeSkyTexture(scene);
    skyMat.fogEnabled = false;
    skyMat.backFaceCulling = false;
    skybox.material = skyMat;
    skybox.infiniteDistance = true;
    skybox.applyFog = false;
    skybox.isPickable = false;
    const sunDisc = MeshBuilder.CreatePlane("sun", { size: 90 }, scene);
    const sunMat = new StandardMaterial("sunMat", scene);
    sunMat.disableLighting = true;
    sunMat.diffuseColor = Color3.Black();
    sunMat.emissiveTexture = makeSunTexture(scene);
    sunMat.opacityTexture = sunMat.emissiveTexture;
    sunMat.emissiveColor = new Color3(3, 2.6, 2.1);
    sunMat.fogEnabled = false;
    sunDisc.material = sunMat;
    sunDisc.position = dir.scale(-400);
    sunDisc.billboardMode = Mesh.BILLBOARDMODE_ALL;
    sunDisc.infiniteDistance = true;
    sunDisc.applyFog = false;
    sunDisc.isPickable = false;

    // Umgebungslicht (IBL) aus dem Himmel erzeugen: kein Download nötig
    const probe = new ReflectionProbe("envProbe", 128, scene, true, true);
    probe.renderList!.push(skybox);
    probe.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    probe.position = new Vector3(0, 30, 0);
    scene.environmentTexture = probe.cubeTexture;
    scene.environmentIntensity = 0.9;

    const ip = scene.imageProcessingConfiguration;
    ip.toneMappingEnabled = true;
    ip.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    ip.exposure = 1.05;
    ip.contrast = 1.18;

    this.particleTex = makeParticleTexture(scene);
  }

  // Welt aufbauen, sobald das Spiel (und damit der Seed) bekannt ist
  attach(session: Session) {
    this.session = session;
    this.terrainView = new TerrainView(this.scene, session.terrain);
    this.orbs = new OrbView(this.scene, this.terrainView);
    this.effects = new Effects(this.scene, this.particleTex);
    this.ready = true;
    for (const f of this.pending) f();
    this.pending = [];
    let q = this.quality;
    try {
      const saved = localStorage.getItem("sa3d-quality") as Quality | null;
      if (saved && QUALITY[saved]) {
        q = saved;
        this.autoQuality = localStorage.getItem("sa3d-quality-auto") !== "0";
      }
    } catch { /* egal */ }
    this.applyQuality(q);
  }

  private later(f: () => void) {
    if (this.ready) f();
    else this.pending.push(f);
  }

  // ---------- SessionListener ----------

  orbAdd(id: number, x: number, z: number, v: number, hue: number) {
    this.later(() => this.orbs.add(id, x, z, v, hue));
  }
  orbRemove(id: number, eater: number) {
    this.later(() => this.orbs.remove(id, eater));
  }
  powAdd(id: number, x: number, z: number, kind: PowerKind) {
    this.later(() => this.orbs.powAdd(id, x, z, kind));
  }
  powRemove(id: number) {
    this.later(() => this.orbs.powRemove(id));
  }
  snakeInit(id: number, x: number, z: number, a: number, pts: number[]) {
    this.later(() => this.view(id)?.reset(x, z, a, this.terrainView, pts));
  }
  players(list: PlayerInfo[]) {
    for (const p of list) this.colors.set(p.id, p.color);
    this.hooks.players(list);
  }
  disconnected(reason: string) {
    this.hooks.disconnected(reason);
  }
  event(ev: SimEvent) {
    this.later(() => this.handleEvent(ev));
    this.hooks.event(ev);
  }

  private colorOf(id: number): Color3 {
    const c = this.colors.get(id) ?? id;
    return Color3.FromHexString(SNAKE_COLORS[c % SNAKE_COLORS.length][0]);
  }

  private handleEvent(ev: SimEvent) {
    const me = this.session?.myId;
    switch (ev.t) {
      case "spawn": {
        const v = this.view(ev.id);
        v?.reset(ev.x, ev.z, ev.a, this.terrainView);
        this.effects.ring(ev.x, this.terrainView.surfaceAt(ev.x, ev.z), ev.z, this.colorOf(ev.id));
        if (ev.id === me) this.camInit = false;
        break;
      }
      case "die": {
        const v = this.views.get(ev.id);
        if (v && v.visible) {
          const p = v.head.position;
          this.effects.burst(p.x, p.y, p.z, this.colorOf(ev.id), 220, 1.4);
          v.hide();
        }
        if (ev.id === me) this.shake = 1;
        break;
      }
      case "power":
      case "shield": {
        const v = this.views.get(ev.id);
        if (v) {
          const p = v.head.position;
          const col = ev.t === "power" ? POWER_COLORS[ev.kind] : POWER_COLORS.shield;
          this.effects.burst(p.x, p.y, p.z, new Color3(col.r / 2.5, col.g / 2.5, col.b / 2.5), 90);
        }
        break;
      }
      case "kill":
        if (ev.killer === me) this.shake = Math.max(this.shake, 0.4);
        break;
    }
  }

  private view(id: number): SnakeView | null {
    let v = this.views.get(id);
    if (v) return v;
    if (!this.colors.has(id) || !this.ready) return null;
    v = new SnakeView(this.scene, id, this.colors.get(id)!, this.particleTex);
    this.views.set(id, v);
    if (this.csm) for (const m of v.shadowMeshes) this.csm.addShadowCaster(m);
    return v;
  }

  // ---------- Qualität ----------

  applyQuality(q: Quality, manual = false) {
    this.quality = q;
    if (manual) {
      this.autoQuality = false;
      try {
        localStorage.setItem("sa3d-quality", q);
        localStorage.setItem("sa3d-quality-auto", "0");
      } catch { /* egal */ }
    }
    const Q = QUALITY[q];
    const dpr = Math.min(window.devicePixelRatio || 1, Q.ratio);
    this.engine.setHardwareScalingLevel(1 / dpr);

    this.csm?.dispose();
    const csm = new CascadedShadowGenerator(Q.shadow, this.sun);
    csm.numCascades = Q.cascades;
    csm.shadowMaxZ = Q.maxZ;
    csm.lambda = 0.85;
    csm.stabilizeCascades = true;
    csm.filteringQuality = q === "high" ? ShadowGenerator.QUALITY_HIGH : ShadowGenerator.QUALITY_MEDIUM;
    csm.usePercentageCloserFiltering = true;
    csm.bias = 0.004;
    csm.normalBias = 0.03;
    csm.darkness = 0.25;
    csm.cascadeBlendPercentage = 0.1;
    for (const m of this.terrainView.shadowCasters) csm.addShadowCaster(m);
    for (const v of this.views.values()) for (const m of v.shadowMeshes) csm.addShadowCaster(m);
    this.csm = csm;

    this.terrainView.grass?.setEnabled(Q.grass);

    this.ssao?.dispose();
    this.ssao = null;
    this.pipeline?.dispose();
    const pp = new DefaultRenderingPipeline("pp", true, this.scene, [this.camera]);
    pp.samples = 1;
    pp.fxaaEnabled = true;
    pp.bloomEnabled = true;
    pp.bloomThreshold = 0.85;
    pp.bloomWeight = 0.45;
    pp.bloomKernel = q === "low" ? 32 : 64;
    pp.bloomScale = 0.5;
    pp.imageProcessingEnabled = true;
    pp.imageProcessing.vignetteEnabled = q !== "low";
    pp.imageProcessing.vignetteWeight = 1.6;
    pp.imageProcessing.vignetteColor = new Color4(0.1, 0.05, 0.02, 0);
    pp.imageProcessing.toneMappingEnabled = true;
    pp.imageProcessing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
    pp.imageProcessing.exposure = 1.05;
    pp.imageProcessing.contrast = 1.18;
    this.pipeline = pp;

    if (Q.ssao) {
      try {
        const ssao = new SSAO2RenderingPipeline("ssao", this.scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [this.camera]);
        ssao.radius = 1.5;
        ssao.totalStrength = 1.1;
        ssao.samples = 12;
        ssao.maxZ = 120;
        this.ssao = ssao;
      } catch {
        this.ssao = null;
      }
    }
    this.hooks.qualityChanged(q);
  }

  // ---------- Pro Frame ----------

  frame(dtMs: number) {
    if (!this.session || !this.ready) return;
    const dt = Math.min(0.1, dtMs / 1000);
    this.time += dt;
    const s = this.session;

    for (const rs of s.snakes.values()) this.view(rs.id)?.update(rs, this.time, this.terrainView);
    for (const [id, v] of this.views) {
      if (!s.snakes.has(id)) {
        v.dispose();
        this.views.delete(id);
      }
    }
    this.orbs.update(dt, this.time, (id) => {
      const v = this.views.get(id);
      return v && v.visible ? v.head.position : null;
    });
    this.effects.update(dt);
    this.terrainView.update(dt, this.time);
    this.updateCamera(dt);
    this.measure(dt);
  }

  private updateCamera(dt: number) {
    const s = this.session!;
    const me = s.snakes.get(s.myId);
    const cam = this.camera;
    if (me && me.alive) {
      const len = lengthFromScore(me.score);
      const r = radiusFromLength(len);
      const v = this.views.get(me.id);
      const hy = v ? v.headY : this.terrainView.surfaceAt(me.x, me.z) + r;
      if (!this.camInit) {
        this.camYaw = me.angle;
        this.camInit = true;
      }
      this.camYaw = lerpAngle(this.camYaw, me.angle, 1 - Math.exp(-dt * 3.2));
      const targetDist = 10 + r * 5 + Math.sqrt(len) * 0.55;
      this.camDist += (targetDist - this.camDist) * (1 - Math.exp(-dt * 2));
      const h = 3 + this.camDist * 0.32;
      const fx = Math.sin(this.camYaw);
      const fz = Math.cos(this.camYaw);
      const px = me.x - fx * this.camDist;
      const pz = me.z - fz * this.camDist;
      const py = Math.max(hy + h, this.terrainView.surfaceAt(px, pz) + 2.5);
      const k = 1 - Math.exp(-dt * 10);
      cam.position.x += (px - cam.position.x) * k;
      cam.position.y += (py - cam.position.y) * k;
      cam.position.z += (pz - cam.position.z) * k;
      const boosting = (me.flags & F_BOOST) !== 0;
      cam.fov += ((boosting ? 1.08 : 0.95) - cam.fov) * (1 - Math.exp(-dt * 4));
      const look = new Vector3(me.x + fx * 7, hy + 1.6, me.z + fz * 7);
      if (this.shake > 0) {
        look.x += (Math.random() - 0.5) * this.shake * 0.8;
        look.y += (Math.random() - 0.5) * this.shake * 0.8;
        this.shake = Math.max(0, this.shake - dt * 2.5);
      }
      cam.setTarget(look);
    } else {
      // Tot: Kamera steigt langsam und schaut auf die Stelle
      cam.position.y += dt * 2.5;
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.5);
    }
  }

  private measure(dt: number) {
    this.sinceStart += dt;
    this.fpsAcc += dt;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 1) {
      this.fps = this.fpsFrames / this.fpsAcc;
      this.fpsTime = 0;
    }
    if (this.fpsAcc >= 3) {
      const avg = this.fpsFrames / this.fpsAcc;
      this.fpsAcc = 0;
      this.fpsFrames = 0;
      if (this.autoQuality && this.sinceStart > 5 && avg < 45) {
        if (this.quality === "high") this.applyQuality("medium");
        else if (this.quality === "medium") this.applyQuality("low");
      }
    }
  }

  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean } {
    this.tmpV.set(x, y, z);
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    Vector3.ProjectToRef(this.tmpV, IDENTITY, this.scene.getTransformMatrix(), this.camera.viewport.toGlobal(w, h), this.tmpOut);
    const scale = this.engine.getHardwareScalingLevel();
    return { x: this.tmpOut.x * scale, y: this.tmpOut.y * scale, visible: this.tmpOut.z > 0 && this.tmpOut.z < 1 };
  }
  private tmpV = new Vector3();
  private tmpOut = new Vector3();

  get cameraYaw(): number {
    const f = this.camera.getDirection(this.fwd);
    return Math.atan2(f.x, f.z);
  }
  private fwd = new Vector3(0, 0, 1);

  headOf(id: number): Vector3 | null {
    const v = this.views.get(id);
    return v && v.visible ? v.head.position : null;
  }

  minimapImage(size: number): ImageData {
    return this.terrainView.minimapImage(size);
  }

  powList() {
    return this.orbs ? this.orbs.powList() : [];
  }

  dispose() {
    this.scene.dispose();
  }
}

const IDENTITY = Matrix.Identity();
