import { Color3, Color4, Mesh, MeshBuilder, ParticleSystem, Scene, StandardMaterial, Texture, Vector3 } from "@babylonjs/core";

// Einmal-Effekte: Funken, Explosionen, Spawn-Ringe.

export class Effects {
  private pool: { ps: ParticleSystem; pos: Vector3 }[] = [];
  private next = 0;
  private rings: { mesh: Mesh; mat: StandardMaterial; t: number }[] = [];

  constructor(private scene: Scene, tex: Texture) {
    for (let i = 0; i < 12; i++) {
      const pos = new Vector3();
      const ps = new ParticleSystem("burst" + i, 400, scene);
      ps.particleTexture = tex;
      ps.emitter = pos;
      ps.blendMode = ParticleSystem.BLENDMODE_ADD;
      ps.minEmitBox = new Vector3(-0.4, 0, -0.4);
      ps.maxEmitBox = new Vector3(0.4, 0.4, 0.4);
      ps.direction1 = new Vector3(-1, 1, -1);
      ps.direction2 = new Vector3(1, 3, 1);
      ps.gravity = new Vector3(0, -6, 0);
      ps.minLifeTime = 0.4;
      ps.maxLifeTime = 1.1;
      ps.minSize = 0.15;
      ps.maxSize = 0.6;
      ps.minEmitPower = 2;
      ps.maxEmitPower = 7;
      ps.emitRate = 0;
      ps.colorDead = new Color4(0, 0, 0, 0);
      ps.start();
      this.pool.push({ ps, pos });
    }
  }

  burst(x: number, y: number, z: number, color: Color3, count: number, power = 1) {
    const slot = this.pool[this.next];
    this.next = (this.next + 1) % this.pool.length;
    slot.pos.set(x, y, z);
    slot.ps.color1 = new Color4(color.r * 2.5, color.g * 2.5, color.b * 2.5, 1);
    slot.ps.color2 = new Color4(2, 2, 2, 1);
    slot.ps.minEmitPower = 2 * power;
    slot.ps.maxEmitPower = 7 * power;
    slot.ps.manualEmitCount = count;
  }

  ring(x: number, y: number, z: number, color: Color3) {
    const mesh = MeshBuilder.CreateTorus("spawnRing", { diameter: 2, thickness: 0.12, tessellation: 48 }, this.scene);
    const mat = new StandardMaterial("ringMat", this.scene);
    mat.disableLighting = true;
    mat.emissiveColor = new Color3(color.r * 2.5, color.g * 2.5, color.b * 2.5);
    mesh.material = mat;
    mesh.position.set(x, y + 0.3, z);
    mesh.isPickable = false;
    this.rings.push({ mesh, mat, t: 0 });
  }

  private meteors: { mesh: Mesh; x: number; z: number; ground: number; t: number }[] = [];
  private meteorMat: StandardMaterial | null = null;

  // Meteorschauer: Leuchtstreifen fallen vom Himmel und schlagen ein
  meteorShower(cx: number, cz: number, radius: number, groundAt: (x: number, z: number) => number) {
    if (!this.meteorMat) {
      this.meteorMat = new StandardMaterial("meteorMat", this.scene);
      this.meteorMat.disableLighting = true;
      this.meteorMat.emissiveColor = new Color3(3, 1.6, 0.5);
    }
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const mesh = MeshBuilder.CreateSphere("meteor", { diameter: 0.9, segments: 6 }, this.scene);
      mesh.material = this.meteorMat;
      mesh.scaling.set(1, 7, 1);
      mesh.isPickable = false;
      mesh.setEnabled(false);
      this.meteors.push({ mesh, x, z, ground: groundAt(x, z), t: -(0.8 + Math.random() * 7.2) });
    }
  }

  update(dt: number) {
    for (let i = this.meteors.length - 1; i >= 0; i--) {
      const m = this.meteors[i];
      m.t += dt;
      if (m.t < 0) continue;
      const fall = 0.55;
      if (m.t >= fall) {
        this.burst(m.x, m.ground + 0.5, m.z, new Color3(1, 0.55, 0.15), 70, 1.2);
        m.mesh.dispose();
        this.meteors.splice(i, 1);
        continue;
      }
      m.mesh.setEnabled(true);
      const k = 1 - m.t / fall;
      m.mesh.position.set(m.x + k * 18, m.ground + k * 70, m.z + k * 6);
      m.mesh.rotation.z = 0.25;
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const s = 1 + r.t * 14;
      r.mesh.scaling.set(s, 1, s);
      r.mat.alpha = Math.max(0, 1 - r.t / 0.9);
      if (r.t > 0.9) {
        r.mesh.dispose();
        r.mat.dispose();
        this.rings.splice(i, 1);
      }
    }
  }
}
