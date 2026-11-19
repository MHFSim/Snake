// Touch-Joystick (linke Hälfte, erscheint unter dem Daumen), Boost-Taste, Tastatur.

export class Controls {
  boost = false;
  private stickId = -1;
  private ox = 0;
  private oy = 0;
  private dx = 0;
  private dy = 0;
  private keys = new Set<string>();
  private boostPointers = new Set<number>();
  enabled = true;

  constructor(
    private area: HTMLElement,
    private base: HTMLElement,
    private knob: HTMLElement,
    boostBtn: HTMLElement,
  ) {
    area.addEventListener("pointerdown", (e) => this.down(e));
    area.addEventListener("pointermove", (e) => this.move(e));
    area.addEventListener("pointerup", (e) => this.up(e));
    area.addEventListener("pointercancel", (e) => this.up(e));
    // Maus/Stift: Pointer Events
    boostBtn.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") return; // Finger laufen über Touch Events (siehe unten)
      e.preventDefault();
      this.boostPointers.add(e.pointerId);
      boostBtn.classList.add("on");
    });
    const off = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      this.boostPointers.delete(e.pointerId);
      boostBtn.classList.toggle("on", this.boostPointers.size > 0 || this.touchBoost);
    };
    window.addEventListener("pointerup", off);
    window.addEventListener("pointercancel", off);

    // Finger: Der Zustand wird bei jeder Änderung aus den aktiven Berührungen neu berechnet.
    // So kann der Knopf nicht hängen bleiben, auch wenn iOS bei langem Drücken ein Ende-Ereignis verschluckt.
    const sync = (e: TouchEvent) => {
      let boost = false;
      let stick = false;
      for (let i = 0; i < e.touches.length; i++) {
        const t = e.touches[i].target as Node | null;
        if (t && boostBtn.contains(t)) boost = true;
        if (t === area) stick = true;
      }
      this.touchBoost = boost;
      boostBtn.classList.toggle("on", boost || this.boostPointers.size > 0);
      if (!stick && this.stickId >= 0 && this.stickIsTouch) this.release();
    };
    // preventDefault verhindert Lupe, Textauswahl und Kontextmenü bei langem Drücken auf iOS
    boostBtn.addEventListener("touchstart", (e) => { e.preventDefault(); sync(e); }, { passive: false });
    boostBtn.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    window.addEventListener("touchstart", sync, { passive: true });
    window.addEventListener("touchend", sync, { passive: true });
    window.addEventListener("touchcancel", sync, { passive: true });
    boostBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    area.addEventListener("contextmenu", (e) => e.preventDefault());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.reset(boostBtn);
    });
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => this.reset(boostBtn));
  }
  private touchBoost = false;
  private stickIsTouch = false;

  private reset(boostBtn: HTMLElement) {
    this.keys.clear();
    this.boostPointers.clear();
    this.touchBoost = false;
    boostBtn.classList.remove("on");
    this.release();
  }

  private release() {
    this.stickId = -1;
    this.dx = this.dy = 0;
    this.base.classList.remove("show");
    this.knob.classList.remove("show");
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.stickId >= 0) return;
    // ganze Fläche außer der Boost-Ecke steuert
    this.stickId = e.pointerId;
    this.stickIsTouch = e.pointerType === "touch";
    try {
      this.area.setPointerCapture(e.pointerId);
    } catch { /* manche Browser erlauben das nicht */ }
    this.ox = e.clientX;
    this.oy = e.clientY;
    this.dx = this.dy = 0;
    this.base.style.transform = `translate(${this.ox}px, ${this.oy}px)`;
    this.knob.style.transform = `translate(${this.ox}px, ${this.oy}px)`;
    this.base.classList.add("show");
    this.knob.classList.add("show");
  }

  private move(e: PointerEvent) {
    if (e.pointerId !== this.stickId) return;
    let dx = e.clientX - this.ox;
    let dy = e.clientY - this.oy;
    const max = 56;
    const d = Math.hypot(dx, dy);
    if (d > max) {
      // Basis folgt dem Daumen, damit man nicht "ausläuft"
      this.ox += (dx / d) * (d - max);
      this.oy += (dy / d) * (d - max);
      dx = e.clientX - this.ox;
      dy = e.clientY - this.oy;
      this.base.style.transform = `translate(${this.ox}px, ${this.oy}px)`;
    }
    this.dx = dx;
    this.dy = dy;
    this.knob.style.transform = `translate(${this.ox + dx}px, ${this.oy + dy}px)`;
  }

  private up(e: PointerEvent) {
    if (e.pointerId !== this.stickId) return;
    this.release();
  }

  // Zielrichtung in Weltkoordinaten. camYaw = Blickrichtung der Kamera, current = aktuelle Richtung der Schlange.
  target(camYaw: number, current: number): number {
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft");
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight");
    if (left !== right) return current + (right ? 1.2 : -1.2);
    if (this.stickId >= 0 && Math.hypot(this.dx, this.dy) > 12) {
      return camYaw + Math.atan2(this.dx, -this.dy);
    }
    return current;
  }

  isBoost(): boolean {
    return (
      this.boostPointers.size > 0 || this.touchBoost ||
      this.keys.has("Space") || this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ||
      this.keys.has("KeyW") || this.keys.has("ArrowUp")
    );
  }
}
