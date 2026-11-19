import {
  AbstractEngine, CascadedShadowGenerator, Color3, Color4, DefaultRenderingPipeline, DirectionalLight, HemisphericLight,
  ImageProcessingConfiguration, Matrix, Mesh, MeshBuilder, PBRMaterial, StandardMaterial, Texture, ReflectionProbe, RenderTargetTexture, Scene, SSAO2RenderingPipeline,
  ShadowGenerator, UniversalCamera, Vector3,
} from "@babylonjs/core";
import { CFG, PowerKind, SNAKE_COLORS, lengthFromScore, radiusFromLength } from "../core/config";
import type { SimEvent } from "../sim/world";
import type { PlayerInfo } from "../net/protocol";
import { F_BOOST, F_FAST } from "../net/protocol";
import type { RSnake, Session, SessionListener } from "../net/session";
import { lerpAngle } from "../net/session";
import { Effects } from "./effects";
import { OrbView, POWER_COLORS } from "./orbView";
import { SnakeView } from "./snakeView";
import { TerrainView } from "./terrainView";
import { makeCloudTexture, makeFlareUrl, makeParticleTexture, makeSkyTexture, makeStarTexture, makeSunTexture } from "./textures";
import { LensFlare, LensFlareSystem, ParticleSystem, PointLight } from "@babylonjs/core";
import type { Terrain } from "../sim/terrain";

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
  eat(value: number): void; // eigene Schlange hat gefressen
}

export class GameRenderer implements SessionListener {
  readonly scene: Scene;
  readonly camera: UniversalCamera;
  terrainView!: TerrainView;
  private sun: DirectionalLight;
  private hemi: HemisphericLight;
  private skyMat!: PBRMaterial;
  private sunDisc!: Mesh;
  private sunMat!: StandardMaterial;
  private sunDir!: Vector3;
  private starMat!: PBRMaterial;
  private stars!: Mesh;
  private crown!: Mesh;
  night = 0; // 0 = Tag, 1 = Nacht
  private killCam = -1;
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
    const hemi = (this.hemi = new HemisphericLight("hemi", new Vector3(0.1, 1, 0.2), scene));
    hemi.intensity = 0.45;
    hemi.diffuse = new Color3(0.75, 0.85, 1);
    hemi.groundColor = new Color3(0.35, 0.3, 0.22);

    // Himmel: Farbverlauf-Kugel + leuchtende Sonne (Bloom)
    const skybox = MeshBuilder.CreateSphere("skyBox", { diameter: 900, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    // unbeleuchtet: Farbe = albedoColor x Textur, so lässt sich der Himmel einfärben
    const skyMat = new PBRMaterial("skyMat", scene);
    skyMat.unlit = true;
    skyMat.albedoColor = Color3.White();
    skyMat.albedoTexture = makeSkyTexture(scene);
    skyMat.fogEnabled = false;
    skyMat.backFaceCulling = false;
    skybox.material = skyMat;
    this.skyMat = skyMat;
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
    this.sunDisc = sunDisc;
    this.sunMat = sunMat;
    this.sunDir = dir.clone();

    // Sterne (nur nachts sichtbar)
    const stars = MeshBuilder.CreateSphere("stars", { diameter: 880, segments: 16, sideOrientation: Mesh.BACKSIDE }, scene);
    const starMat = new PBRMaterial("starMat", scene);
    starMat.unlit = true;
    starMat.albedoTexture = makeStarTexture(scene, 7);
    starMat.opacityTexture = starMat.albedoTexture;
    starMat.albedoColor = new Color3(2.2, 2.2, 2.5);
    starMat.backFaceCulling = false;
    starMat.fogEnabled = false;
    starMat.alpha = 0;
    stars.material = starMat;
    stars.infiniteDistance = true;
    stars.applyFog = false;
    stars.isPickable = false;
    this.starMat = starMat;
    this.stars = stars;

    // Krone für den Anführer
    this.crown = this.makeCrown();

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

    // Wolken: drehende Kuppel, wird mit der Tageszeit eingefärbt
    const clouds = MeshBuilder.CreateSphere("clouds", { diameter: 860, segments: 24, sideOrientation: Mesh.BACKSIDE }, scene);
    const cloudMat = new PBRMaterial("cloudMat", scene);
    cloudMat.unlit = true;
    cloudMat.albedoTexture = makeCloudTexture(scene, 31);
    cloudMat.opacityTexture = cloudMat.albedoTexture;
    (cloudMat.albedoTexture as Texture).uScale = 2;
    cloudMat.backFaceCulling = false;
    cloudMat.fogEnabled = false;
    clouds.material = cloudMat;
    clouds.infiniteDistance = true;
    clouds.applyFog = false;
    clouds.isPickable = false;
    this.clouds = clouds;
    this.cloudMat = cloudMat;

    // Linsenreflexe der Sonne
    const fl = new LensFlareSystem("flares", this.sunDisc, scene);
    const soft = makeFlareUrl(false);
    const ring = makeFlareUrl(true);
    new LensFlare(0.22, 0, new Color3(1, 0.92, 0.75), soft, fl);
    new LensFlare(0.07, 0.35, new Color3(1, 0.7, 0.4), soft, fl);
    new LensFlare(0.14, 0.6, new Color3(0.5, 0.8, 1), ring, fl);
    new LensFlare(0.05, 0.8, new Color3(0.7, 1, 0.8), soft, fl);
    new LensFlare(0.26, 1.15, new Color3(1, 0.6, 0.5), ring, fl);
    this.flares = fl;

    // Schwebeteilchen: tagsüber Pollen, nachts Glühwürmchen
    const amb = new ParticleSystem("ambient", 260, scene);
    amb.particleTexture = this.particleTex;
    amb.emitter = this.ambPos;
    amb.minEmitBox = new Vector3(-32, 0.3, -32);
    amb.maxEmitBox = new Vector3(32, 7, 32);
    amb.minLifeTime = 3;
    amb.maxLifeTime = 6;
    amb.minSize = 0.06;
    amb.maxSize = 0.16;
    amb.emitRate = 45;
    amb.minEmitPower = 0.1;
    amb.maxEmitPower = 0.5;
    amb.direction1 = new Vector3(-1, 0.3, -1);
    amb.direction2 = new Vector3(1, 0.6, 1);
    amb.gravity = new Vector3(0.3, 0.02, 0.1);
    amb.blendMode = ParticleSystem.BLENDMODE_ADD;
    amb.colorDead = new Color4(0, 0, 0, 0);
    amb.start();
    this.ambient = amb;

    // Licht am eigenen Kopf: nachts leuchtet die Schlange den Boden an
    this.headLight = new PointLight("headLight", new Vector3(0, 5, 0), scene);
    this.headLight.intensity = 0;
    this.headLight.range = 26;
  }
  private clouds!: Mesh;
  private cloudMat!: PBRMaterial;
  private flares!: LensFlareSystem;
  private ambient!: ParticleSystem;
  private ambPos = new Vector3();
  private headLight!: PointLight;
  private boostFx = 0;
  private menuMode = false;

  // Menü-Hintergrund: Welt ohne Spiel, Kamera kreist
  attachMenu(terrain: Terrain) {
    this.menuMode = true;
    this.terrainView = new TerrainView(this.scene, terrain);
    this.initQuality();
  }

  frameMenu(dtMs: number) {
    if (!this.menuMode) return;
    const dt = Math.min(0.1, dtMs / 1000);
    this.time += dt;
    this.updateDayNight(this.time * 4 + 150); // schneller Zeitraffer, startet am Nachmittag
    this.terrainView.night = this.night;
    this.terrainView.update(dt, this.time);
    const a = this.time * 0.05;
    const cx = Math.cos(a) * 95;
    const cz = Math.sin(a) * 95;
    const y = this.terrainView.surfaceAt(cx, cz) + 16;
    this.camera.position.set(cx, y, cz);
    this.camera.setTarget(new Vector3(Math.cos(a + 0.9) * 40, 6, Math.sin(a + 0.9) * 40));
    this.ambPos.set(cx, y - 12, cz);
  }

  private initQuality() {
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

  // Welt aufbauen, sobald das Spiel (und damit der Seed) bekannt ist
  attach(session: Session) {
    this.session = session;
    this.terrainView = new TerrainView(this.scene, session.terrain);
    this.orbs = new OrbView(this.scene, this.terrainView);
    this.effects = new Effects(this.scene, this.particleTex);
    this.ready = true;
    for (const f of this.pending) f();
    this.pending = [];
    this.initQuality();
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
    this.later(() => {
      const v = this.orbs.remove(id, eater);
      if (eater >= 0 && eater === this.session?.myId && v > 0) this.hooks.eat(v);
    });
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
        if (ev.id === me) {
          this.camInit = false;
          this.killCam = -1;
        }
        break;
      }
      case "die": {
        const v = this.views.get(ev.id);
        if (v && v.visible) {
          const p = v.head.position;
          this.effects.burst(p.x, p.y, p.z, this.colorOf(ev.id), 220, 1.4);
          this.effects.ring(p.x, p.y - 0.4, p.z, this.colorOf(ev.id));
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
        if (ev.victim === me) this.killCam = ev.killer; // Killcam: zeigt den Gegner
        break;
      case "goldEaten": {
        const v = this.views.get(ev.id);
        if (v) {
          const p = v.head.position;
          this.effects.burst(p.x, p.y + 1, p.z, new Color3(1, 0.75, 0.2), 300, 1.6);
          this.effects.ring(p.x, p.y - 0.5, p.z, new Color3(1, 0.8, 0.2));
        }
        break;
      }
      case "pad": {
        const v = this.views.get(ev.id);
        if (v) {
          const p = v.head.position;
          this.effects.burst(p.x, p.y, p.z, new Color3(1, 0.5, 0.1), 60, 0.8);
        }
        break;
      }
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
    // Farbsäume beim Boost (Stärke wird pro Frame gesetzt), Schärfe auf Hoch
    pp.chromaticAberrationEnabled = q !== "low";
    pp.chromaticAberration.aberrationAmount = 0;
    pp.chromaticAberration.radialIntensity = 1.2;
    pp.sharpenEnabled = q === "high";
    pp.sharpen.edgeAmount = 0.22;
    this.ambient.emitRate = q === "low" ? 15 : 45;
    for (const m of this.terrainView.flora) m.setEnabled(q !== "low");
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

    this.updateDayNight(s.serverTime(performance.now()));
    for (const rs of s.snakes.values()) this.view(rs.id)?.update(rs, this.time, this.terrainView, this.night);
    this.updateCrown();
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
    this.terrainView.night = this.night;
    this.terrainView.update(dt, this.time);
    this.updateCamera(dt);
    this.updateAtmosphere(dt);
    this.measure(dt);
  }

  private updateCamera(dt: number) {
    const s = this.session!;
    const me = s.snakes.get(s.myId);
    const target = me && me.alive ? me : this.killCam >= 0 ? s.snakes.get(this.killCam) : undefined;
    if (target && target.alive) {
      if (target !== me) this.camInit = this.camInit && this.followId === target.id;
      this.followId = target.id;
      this.follow(target, dt, target === me ? 1 : 1.5);
    } else {
      // Tot ohne Gegner: Kamera steigt langsam
      this.camera.position.y += dt * 2.5;
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 2.5);
    }
  }
  private followId = -1;

  private follow(t: RSnake, dt: number, distMul: number) {
    const cam = this.camera;
    const len = lengthFromScore(t.score);
    const r = radiusFromLength(len);
    const v = this.views.get(t.id);
    const hy = v ? v.headY : this.terrainView.surfaceAt(t.x, t.z) + r;
    if (!this.camInit) {
      this.camYaw = t.angle;
      this.camInit = true;
    }
    this.camYaw = lerpAngle(this.camYaw, t.angle, 1 - Math.exp(-dt * 3.2));
    const targetDist = (10 + r * 5 + Math.sqrt(len) * 0.55) * distMul;
    this.camDist += (targetDist - this.camDist) * (1 - Math.exp(-dt * 2));
    const h = 3 + this.camDist * 0.32;
    const fx = Math.sin(this.camYaw);
    const fz = Math.cos(this.camYaw);
    const px = t.x - fx * this.camDist;
    const pz = t.z - fz * this.camDist;
    const py = Math.max(hy + h, this.terrainView.surfaceAt(px, pz) + 2.5);
    const k = 1 - Math.exp(-dt * (distMul > 1 ? 4 : 10));
    cam.position.x += (px - cam.position.x) * k;
    cam.position.y += (py - cam.position.y) * k;
    cam.position.z += (pz - cam.position.z) * k;
    const boosting = (t.flags & (F_BOOST | F_FAST)) !== 0;
    cam.fov += ((boosting ? 1.08 : 0.95) - cam.fov) * (1 - Math.exp(-dt * 4));
    const look = new Vector3(t.x + fx * 7, hy + 1.6, t.z + fz * 7);
    if (this.shake > 0) {
      look.x += (Math.random() - 0.5) * this.shake * 0.8;
      look.y += (Math.random() - 0.5) * this.shake * 0.8;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }
    cam.setTarget(look);
  }

  // Schwebeteilchen, Kopflicht, Boost-Effekt
  private updateAtmosphere(dt: number) {
    const s = this.session!;
    const me = s.snakes.get(s.myId);
    const v = me ? this.views.get(me.id) : null;
    const cam = this.camera.position;
    const f = this.camera.getDirection(this.fwd);
    this.ambPos.set(cam.x + f.x * 22, this.terrainView.surfaceAt(cam.x + f.x * 22, cam.z + f.z * 22), cam.z + f.z * 22);
    if (me && me.alive && v) {
      this.headLight.position.set(v.head.position.x, v.headY + 2.2, v.head.position.z);
      const c = this.colorOf(me.id);
      this.headLight.diffuse.set(0.5 + c.r * 0.5, 0.5 + c.g * 0.5, 0.5 + c.b * 0.5);
      this.headLight.intensity = this.night * 70;
    } else this.headLight.intensity = 0;
    const fast = !!me && me.alive && (me.flags & (F_BOOST | F_FAST)) !== 0;
    this.boostFx += ((fast ? 1 : 0) - this.boostFx) * (1 - Math.exp(-dt * 6));
    if (this.pipeline && this.pipeline.chromaticAberrationEnabled) {
      this.pipeline.chromaticAberration.aberrationAmount = this.boostFx * 28;
    }
  }

  // ---------- Tag und Nacht ----------

  private updateDayNight(seconds: number) {
    const fixed = Number(new URLSearchParams(location.search).get("daytime") ?? NaN); // Test: feste Tageszeit
    const t = Number.isFinite(fixed) ? fixed : ((seconds / CFG.dayLength) % 1 + 1) % 1;
    const sm = (a: number, b: number, x: number) => {
      const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return u * u * (3 - 2 * u);
    };
    // Tag 0–0,5 · Abend 0,5–0,62 · Nacht 0,62–0,88 · Morgen 0,88–1
    const n = sm(0.5, 0.62, t) * (1 - sm(0.88, 1, t));
    this.night = n;
    const dusk = 4 * n * (1 - n);
    const L = (a: number, b: number, k: number) => a + (b - a) * k;
    const mix3 = (day: number[], duskC: number[], nightC: number[]) => {
      const c = day.map((d, i) => L(d, duskC[i], dusk));
      return c.map((d, i) => L(d, nightC[i], n));
    };
    // Sonne wandert langsam, Mond steht nachts am selben Platz
    const az = t * Math.PI * 0.6;
    const d = this.sunDir;
    const dir = new Vector3(d.x * Math.cos(az) - d.z * Math.sin(az), d.y, d.x * Math.sin(az) + d.z * Math.cos(az));
    this.sun.direction.copyFrom(dir);
    this.sunDisc.position.copyFrom(dir.scale(-400));
    this.sun.intensity = L(3.4, 0.7, n);
    const sc = mix3([1, 0.9, 0.76], [1, 0.62, 0.4], [0.55, 0.66, 1]);
    this.sun.diffuse.set(sc[0], sc[1], sc[2]);
    this.hemi.intensity = L(0.45, 0.22, n);
    const hc = mix3([0.75, 0.85, 1], [0.9, 0.7, 0.6], [0.35, 0.45, 0.8]);
    this.hemi.diffuse.set(hc[0], hc[1], hc[2]);
    const sky = mix3([1, 1, 1], [1, 0.72, 0.55], [0.07, 0.09, 0.2]);
    this.skyMat.albedoColor.set(sky[0], sky[1], sky[2]);
    const fog = mix3([0.8, 0.85, 0.88], [0.86, 0.62, 0.48], [0.04, 0.06, 0.12]);
    this.scene.fogColor.set(fog[0], fog[1], fog[2]);
    this.scene.clearColor.set(fog[0], fog[1], fog[2], 1);
    this.scene.environmentIntensity = L(0.9, 0.22, n);
    const moon = 1 - sm(0.3, 0.7, n);
    this.sunMat.emissiveColor.set(L(0.9, 3, moon), L(1.0, 2.6, moon), L(1.4, 2.1, moon));
    this.sunDisc.scaling.setAll(L(0.45, 1, moon));
    this.starMat.alpha = sm(0.45, 0.9, n);
    this.stars.setEnabled(this.starMat.alpha > 0.01);
    this.stars.rotation.y = seconds * 0.004;
    const cc = mix3([1, 1, 1], [1.1, 0.62, 0.45], [0.1, 0.12, 0.22]);
    this.cloudMat.albedoColor.set(cc[0], cc[1], cc[2]);
    this.clouds.rotation.y = seconds * 0.006;
    this.flares.isEnabled = n < 0.25;
    // nachts Glühwürmchen (gelbgrün, größer), tags feine Pollen
    this.ambient.color1.set(L(1, 0.9, n), L(1, 1.6, n), L(0.9, 0.3, n), L(0.35, 1, n));
    this.ambient.color2.set(L(1, 1.4, n), L(0.95, 1.5, n), L(0.8, 0.2, n), L(0.25, 1, n));
    this.ambient.maxSize = L(0.16, 0.34, n);
    if (this.pipeline) {
      this.pipeline.bloomWeight = L(0.45, 0.7, n);
      this.pipeline.imageProcessing.exposure = L(1.05, 1.3, n);
    }
  }

  // ---------- Krone für den Anführer ----------

  private makeCrown(): Mesh {
    const sc = this.scene;
    const parts: Mesh[] = [];
    const band = MeshBuilder.CreateCylinder("crownBand", { height: 0.5, diameter: 1.4, tessellation: 20, cap: Mesh.NO_CAP }, sc);
    parts.push(band);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const spike = MeshBuilder.CreateCylinder("spike", { height: 0.7, diameterTop: 0, diameterBottom: 0.35, tessellation: 6 }, sc);
      spike.position.set(Math.cos(a) * 0.62, 0.55, Math.sin(a) * 0.62);
      parts.push(spike);
      const gem = MeshBuilder.CreateSphere("gem", { diameter: 0.18, segments: 6 }, sc);
      gem.position.set(Math.cos(a) * 0.62, 0.95, Math.sin(a) * 0.62);
      parts.push(gem);
    }
    const crown = Mesh.MergeMeshes(parts, true, true)!;
    crown.name = "crown";
    const mat = new PBRMaterial("crownMat", sc);
    mat.albedoColor = new Color3(1, 0.72, 0.15);
    mat.metallic = 1;
    mat.roughness = 0.2;
    mat.emissiveColor = new Color3(1.2, 0.8, 0.15);
    mat.backFaceCulling = false;
    crown.material = mat;
    crown.isPickable = false;
    crown.setEnabled(false);
    return crown;
  }

  private updateCrown() {
    const s = this.session!;
    let best: RSnake | null = null;
    let alive = 0;
    for (const r of s.snakes.values()) {
      if (!r.alive) continue;
      alive++;
      if (!best || r.score > best.score) best = r;
    }
    const v = best ? this.views.get(best.id) : null;
    if (!best || alive < 2 || best.score <= 0 || !v || !v.visible) {
      this.crown.setEnabled(false);
      return;
    }
    const r = radiusFromLength(lengthFromScore(best.score));
    this.crown.setEnabled(true);
    this.crown.position.set(v.head.position.x, v.headY + r * 1.3 + 0.5 + Math.sin(this.time * 3) * 0.15, v.head.position.z);
    this.crown.scaling.setAll(0.7 + r * 0.35);
    this.crown.rotation.y = this.time * 1.2;
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

  goldPos(): { x: number; z: number } | null {
    return this.orbs ? this.orbs.goldPos : null;
  }

  powList() {
    return this.orbs ? this.orbs.powList() : [];
  }

  dispose() {
    this.scene.dispose();
  }
}

const IDENTITY = Matrix.Identity();
