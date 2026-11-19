// Soundeffekte, komplett per WebAudio erzeugt (keine Dateien).

export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private boostGain: GainNode | null = null;
  private boostFilter: BiquadFilterNode | null = null;
  private lastEat = 0;
  private combo = 0;
  enabled = true;

  constructor() {
    try {
      this.enabled = localStorage.getItem("sa3d-sound") !== "0";
    } catch { /* egal */ }
  }

  // Muss aus einem Klick/Tipp heraus aufgerufen werden (Browser-Regel)
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.55 : 0;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem("sa3d-sound", on ? "1" : "0");
    } catch { /* egal */ }
    if (this.ctx) this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.05);
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number, delay = 0) {
    const c = this.ctx;
    if (!c || !this.enabled) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol: number, from: number, to: number, delay = 0, type: BiquadFilterType = "bandpass") {
    const c = this.ctx;
    if (!c || !this.enabled) return;
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  // Fressen: Tonhöhe steigt, wenn man viele Orbs schnell hintereinander frisst
  eat(value: number) {
    const now = performance.now();
    if (now - this.lastEat < 45) return;
    this.combo = now - this.lastEat < 450 ? Math.min(this.combo + 1, 14) : 0;
    this.lastEat = now;
    const f = 520 * Math.pow(1.06, this.combo);
    if (value >= 40) return this.goldEaten();
    if (value >= 3) {
      this.tone(f, 0.12, "triangle", 0.22);
      this.tone(f * 1.5, 0.16, "triangle", 0.18, undefined, 0.05);
    } else {
      this.tone(f, 0.07, "sine", 0.16, f * 1.4);
    }
  }

  kill() {
    this.tone(330, 0.12, "square", 0.12);
    this.tone(660, 0.22, "square", 0.12, 990, 0.08);
    this.noise(0.25, 0.25, 3000, 600);
  }

  die() {
    this.tone(320, 0.7, "sawtooth", 0.18, 50);
    this.noise(0.6, 0.35, 1800, 120, 0, "lowpass");
  }

  power() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.14, "triangle", 0.16, undefined, i * 0.06));
  }

  shield() {
    this.tone(880, 0.3, "sine", 0.2, 440);
    this.noise(0.3, 0.2, 4000, 800);
  }

  pad() {
    this.noise(0.45, 0.3, 300, 3500);
    this.tone(220, 0.35, "sine", 0.12, 660);
  }

  goldSpawn() {
    for (let r = 0; r < 2; r++) {
      this.tone(1046, 0.6, "sine", 0.18, undefined, r * 0.35);
      this.tone(1568, 0.6, "sine", 0.1, undefined, r * 0.35 + 0.02);
    }
  }

  goldEaten() {
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => this.tone(f, 0.25, "triangle", 0.2, undefined, i * 0.07));
    this.noise(0.8, 0.15, 6000, 1500, 0.1);
  }

  fanfare() {
    [392, 523, 659, 784].forEach((f, i) => this.tone(f, i === 3 ? 0.5 : 0.14, "square", 0.1, undefined, i * 0.1));
  }

  spawn() {
    this.tone(260, 0.35, "sine", 0.15, 780);
  }

  // Dauerrauschen während Boost
  setBoost(on: boolean) {
    const c = this.ctx;
    if (!c) return;
    if (!this.boostGain) {
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      this.boostFilter = c.createBiquadFilter();
      this.boostFilter.type = "bandpass";
      this.boostFilter.frequency.value = 900;
      this.boostFilter.Q.value = 0.8;
      this.boostGain = c.createGain();
      this.boostGain.gain.value = 0;
      src.connect(this.boostFilter).connect(this.boostGain).connect(this.master);
      src.start();
    }
    const target = on && this.enabled ? 0.12 : 0;
    this.boostGain.gain.setTargetAtTime(target, c.currentTime, on ? 0.05 : 0.12);
    this.boostFilter!.frequency.setTargetAtTime(on ? 1400 : 700, c.currentTime, 0.2);
  }
}
