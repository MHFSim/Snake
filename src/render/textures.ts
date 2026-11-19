import { DynamicTexture, Scene, Texture } from "@babylonjs/core";

// Prozedurale Texturen: keine Downloads nötig.

// Kachelbares Value-Noise (periodisch), Werte 0..1
function tileNoise(size: number, period: number, seed: number): Float32Array {
  const lat = new Float32Array(period * period);
  let s = seed >>> 0;
  for (let i = 0; i < lat.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    lat[i] = s / 4294967296;
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * period;
      const fy = (y / size) * period;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const g = (xx: number, yy: number) => lat[((yy % period) * period + (xx % period))];
      const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
      const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
      out[y * size + x] = a + (b - a) * sy;
    }
  }
  return out;
}

function fbmTile(size: number, seed: number, periods: number[], weights: number[]): Float32Array {
  const res = new Float32Array(size * size);
  let norm = 0;
  periods.forEach((p, i) => {
    const n = tileNoise(size, p, seed + i * 977);
    for (let k = 0; k < res.length; k++) res[k] += n[k] * weights[i];
    norm += weights[i];
  });
  for (let k = 0; k < res.length; k++) res[k] /= norm;
  return res;
}

// Normal Map aus Höhen-Noise
export function makeNormalMap(scene: Scene, name: string, size: number, seed: number, strength: number, periods = [4, 8, 16, 32], weights = [1, 0.6, 0.35, 0.2]): Texture {
  const h = fbmTile(size, seed, periods, weights);
  const tex = new DynamicTexture(name, { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = h[y * size + ((x - 1 + size) % size)];
      const r = h[y * size + ((x + 1) % size)];
      const u = h[((y - 1 + size) % size) * size + x];
      const d = h[((y + 1) % size) * size + x];
      let nx = (l - r) * strength;
      let ny = (u - d) * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.update(false);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

// Helligkeits-Detail für den Boden (grau, um 1.0 herum)
export function makeDetailTexture(scene: Scene, size: number, seed: number): Texture {
  const h = fbmTile(size, seed, [8, 16, 32, 64], [1, 0.7, 0.5, 0.35]);
  const tex = new DynamicTexture("detail", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  for (let k = 0; k < h.length; k++) {
    const v = Math.max(0, Math.min(255, (0.78 + (h[k] - 0.5) * 0.55) * 255));
    img.data[k * 4] = v;
    img.data[k * 4 + 1] = v;
    img.data[k * 4 + 2] = v;
    img.data[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  tex.update(true);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

// Weicher runder Punkt für Partikel
export function makeParticleTexture(scene: Scene): Texture {
  const size = 64;
  const tex = new DynamicTexture("particle", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

// Energie-Gitter für die Kartengrenze
export function makeGridTexture(scene: Scene): Texture {
  const size = 128;
  const tex = new DynamicTexture("grid", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.fillStyle = "rgba(0,0,0,0)";
  ctx.clearRect(0, 0, size, size);
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, "rgba(255,255,255,0.05)");
  g.addColorStop(1, "rgba(255,255,255,0.35)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = 3;
  // Sechseck-artiges Muster
  ctx.beginPath();
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size / 4, 0);
  ctx.lineTo((size * 3) / 4, 0);
  ctx.lineTo(size, size / 2);
  ctx.lineTo((size * 3) / 4, size);
  ctx.lineTo(size / 4, size);
  ctx.closePath();
  ctx.stroke();
  tex.hasAlpha = true;
  tex.update(true);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

// Himmel: vertikaler Farbverlauf (oben = Zenit)
export function makeSkyTexture(scene: Scene): Texture {
  const h = 256;
  const tex = new DynamicTexture("skyGrad", { width: 4, height: h }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0.0, "#2559b0");
  g.addColorStop(0.3, "#3f82d4");
  g.addColorStop(0.45, "#7fb6e8");
  g.addColorStop(0.486, "#bcdaf0");
  g.addColorStop(0.496, "#f2dfc2");
  g.addColorStop(0.503, "#ead3ae");
  g.addColorStop(0.52, "#b9ad98");
  g.addColorStop(1.0, "#8c8577");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, h);
  tex.update(false);
  tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
  return tex;
}

// Sonnenscheibe mit Glühen
export function makeSunTexture(scene: Scene): Texture {
  const size = 256;
  const tex = new DynamicTexture("sunTex", { width: size, height: size }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,250,235,1)");
  g.addColorStop(0.12, "rgba(255,240,200,1)");
  g.addColorStop(0.2, "rgba(255,210,150,0.55)");
  g.addColorStop(0.5, "rgba(255,180,110,0.12)");
  g.addColorStop(1, "rgba(255,160,90,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  tex.hasAlpha = true;
  tex.update(false);
  return tex;
}
