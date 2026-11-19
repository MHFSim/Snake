// Spur des Kopfes. Der Körper liegt in festen Abständen auf dieser Spur.
// Wird von der Spiellogik (Kollision) und der Grafik (Darstellung) benutzt.
export class Trail {
  xs: number[] = [];
  ys: number[] = [];
  zs: number[] = [];
  private start = 0;

  get count(): number {
    return this.xs.length - this.start;
  }

  clear() {
    this.xs.length = 0;
    this.ys.length = 0;
    this.zs.length = 0;
    this.start = 0;
  }

  push(x: number, z: number, y = 0) {
    this.xs.push(x);
    this.zs.push(z);
    this.ys.push(y);
  }

  lastX(): number {
    return this.xs[this.xs.length - 1];
  }
  lastZ(): number {
    return this.zs[this.zs.length - 1];
  }

  // Gerade Spur hinter dem Kopf (beim Spawnen)
  resetStraight(x: number, z: number, angle: number, length: number, yAt?: (x: number, z: number) => number) {
    this.clear();
    const dx = -Math.sin(angle);
    const dz = -Math.cos(angle);
    const step = 0.3;
    const n = Math.ceil(length / step) + 2;
    for (let i = n; i >= 0; i--) {
      const px = x + dx * i * step;
      const pz = z + dz * i * step;
      this.push(px, pz, yAt ? yAt(px, pz) : 0);
    }
  }

  // Punkte setzen (z. B. aus dem Netzwerk). pts = [x,z, x,z, ...] vom Kopf zum Schwanz.
  setFromPoints(pts: number[], yAt?: (x: number, z: number) => number) {
    this.clear();
    for (let i = pts.length - 2; i >= 0; i -= 2) {
      const x = pts[i];
      const z = pts[i + 1];
      this.push(x, z, yAt ? yAt(x, z) : 0);
    }
  }

  // Liefert Körperpunkte. Segment k liegt (k+1)*spacing hinter dem Kopf.
  // out bekommt [x,y,z, x,y,z, ...]. Rückgabe: Anzahl Segmente.
  sample(hx: number, hy: number, hz: number, spacing: number, count: number, out: Float32Array): number {
    let idx = this.xs.length - 1;
    let px = hx;
    let py = hy;
    let pz = hz;
    let need = spacing;
    let k = 0;
    const max = Math.min(count, Math.floor(out.length / 3));
    while (k < max && idx >= this.start) {
      const qx = this.xs[idx];
      const qy = this.ys[idx];
      const qz = this.zs[idx];
      const dx = qx - px;
      const dz = qz - pz;
      const seg = Math.sqrt(dx * dx + dz * dz);
      if (seg >= need && seg > 1e-6) {
        const t = need / seg;
        px += dx * t;
        py += (qy - py) * t;
        pz += dz * t;
        out[k * 3] = px;
        out[k * 3 + 1] = py;
        out[k * 3 + 2] = pz;
        k++;
        need = spacing;
      } else {
        need -= seg;
        px = qx;
        py = qy;
        pz = qz;
        idx--;
      }
    }
    // Spur zu kurz: Rest auf den letzten Punkt legen
    while (k < max) {
      out[k * 3] = px;
      out[k * 3 + 1] = py;
      out[k * 3 + 2] = pz;
      k++;
    }
    return k;
  }

  // Alte Punkte entfernen, die weiter als maxLen hinter dem Kopf liegen
  trim(maxLen: number) {
    let idx = this.xs.length - 1;
    let dist = 0;
    while (idx > this.start) {
      const dx = this.xs[idx] - this.xs[idx - 1];
      const dz = this.zs[idx] - this.zs[idx - 1];
      dist += Math.sqrt(dx * dx + dz * dz);
      if (dist > maxLen + 2) break;
      idx--;
    }
    if (idx > this.start + 1) this.start = idx - 1;
    if (this.start > 1024) {
      this.xs.splice(0, this.start);
      this.ys.splice(0, this.start);
      this.zs.splice(0, this.start);
      this.start = 0;
    }
  }

  // Punkte für das Netzwerk: [x,z,...] vom Kopf zum Schwanz, ungefähr alle step Meter
  exportPoints(step: number, maxLen: number): number[] {
    const res: number[] = [];
    let idx = this.xs.length - 1;
    if (idx < this.start) return res;
    let acc = step;
    let dist = 0;
    let lx = this.xs[idx];
    let lz = this.zs[idx];
    while (idx >= this.start) {
      const x = this.xs[idx];
      const z = this.zs[idx];
      const d = Math.hypot(x - lx, z - lz);
      acc += d;
      dist += d;
      lx = x;
      lz = z;
      if (acc >= step) {
        res.push(Math.round(x * 50) / 50, Math.round(z * 50) / 50);
        acc = 0;
      }
      if (dist > maxLen + 1) break;
      idx--;
    }
    return res;
  }
}
