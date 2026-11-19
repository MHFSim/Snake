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
    boostBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      boostBtn.setPointerCapture(e.pointerId);
      this.boostPointers.add(e.pointerId);
      boostBtn.classList.add("on");
    });
    const off = (e: PointerEvent) => {
      this.boostPointers.delete(e.pointerId);
      if (!this.boostPointers.size) boostBtn.classList.remove("on");
    };
    boostBtn.addEventListener("pointerup", off);
    boostBtn.addEventListener("pointercancel", off);
    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      this.keys.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.boostPointers.clear();
      boostBtn.classList.remove("on");
    });
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.stickId >= 0) return;
    // ganze Fläche außer der Boost-Ecke steuert
    this.stickId = e.pointerId;
    this.area.setPointerCapture(e.pointerId);
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
    this.stickId = -1;
    this.dx = this.dy = 0;
    this.base.classList.remove("show");
    this.knob.classList.remove("show");
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
      this.boostPointers.size > 0 ||
      this.keys.has("Space") || this.keys.has("ShiftLeft") || this.keys.has("ShiftRight") ||
      this.keys.has("KeyW") || this.keys.has("ArrowUp")
    );
  }
}
