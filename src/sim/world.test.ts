import { describe, expect, it } from "vitest";
import { CFG, wrapAngle } from "../core/config";
import { Trail } from "./trail";
import { World } from "./world";

const DT = 1 / CFG.tickRate;

describe("Trail", () => {
  it("legt Segmente im festen Abstand", () => {
    const t = new Trail();
    t.resetStraight(0, 0, 0, 20);
    const out = new Float32Array(30);
    const n = t.sample(0, 0, 0, 0.6, 10, out);
    expect(n).toBe(10);
    expect(out[2]).toBeCloseTo(-0.6, 3);
    expect(out[29]).toBeCloseTo(-6, 3);
  });
});

describe("World", () => {
  it("ist mit gleichem Seed deterministisch", () => {
    const a = new World(42);
    const b = new World(42);
    expect(a.terrain.heightAt(12, 34)).toBe(b.terrain.heightAt(12, 34));
    expect(a.orbs.size).toBe(CFG.orbTarget);
    expect([...a.orbs.values()][7]).toEqual([...b.orbs.values()][7]);
  });

  it("bewegt die Schlange mit Grundtempo", () => {
    const w = new World(1);
    const s = w.addPlayer(0, "A", 0);
    s.protect = 0;
    const x0 = s.x;
    const z0 = s.z;
    w.setInput(0, { angle: s.angle, boost: false });
    for (let i = 0; i < CFG.tickRate; i++) w.step(DT);
    const d = Math.hypot(s.x - x0, s.z - z0);
    expect(d).toBeGreaterThan(6);
    expect(d).toBeLessThanOrEqual(CFG.baseSpeed + 0.01);
  });

  it("dreht höchstens mit der Drehrate", () => {
    const w = new World(1);
    const s = w.addPlayer(0, "A", 0);
    const a0 = s.angle;
    w.setInput(0, { angle: a0 + Math.PI * 0.9, boost: false });
    w.step(DT);
    expect(Math.abs(wrapAngle(s.angle - a0))).toBeLessThanOrEqual(CFG.turnRate * DT + 1e-6);
  });

  it("wächst durch Fressen", () => {
    const w = new World(3);
    const s = w.addPlayer(0, "A", 0);
    const len0 = s.length;
    // Orbs direkt vor den Kopf legen
    for (let i = 1; i <= 30; i++) {
      (w as any).addOrb(s.x + Math.sin(s.angle) * i * 0.3, s.z + Math.cos(s.angle) * i * 0.3, 1, 0);
    }
    w.setInput(0, { angle: s.angle, boost: false });
    for (let i = 0; i < 40; i++) w.step(DT);
    expect(s.score).toBeGreaterThanOrEqual(20);
    expect(s.length).toBeGreaterThan(len0);
  });

  it("Kopf gegen fremden Körper tötet und zählt den Kill", () => {
    const w = new World(5);
    const a = w.addPlayer(0, "A", 0);
    const b = w.addPlayer(1, "B", 1);
    a.protect = 0;
    b.protect = 0;
    b.score = 100;
    // B liegt quer, A fährt direkt in die Mitte von B
    b.x = 0; b.z = 0; b.angle = Math.PI / 2;
    b.trail.resetStraight(0, 0, Math.PI / 2, 40);
    a.x = -6; a.z = -3; a.angle = 0;
    a.trail.resetStraight(-6, -3, 0, 10);
    w.setInput(0, { angle: 0, boost: false });
    w.setInput(1, { angle: Math.PI / 2, boost: false });
    for (let i = 0; i < 30 && a.alive; i++) w.step(DT);
    expect(a.alive).toBe(false);
    expect(b.kills).toBe(1);
    const ev = w.flush().events;
    expect(ev.some((e) => e.t === "kill" && e.killer === 1 && e.victim === 0)).toBe(true);
  });

  it("Spawnschutz verhindert den Tod", () => {
    const w = new World(5);
    const a = w.addPlayer(0, "A", 0);
    const b = w.addPlayer(1, "B", 1);
    b.protect = 0;
    b.x = 0; b.z = 0; b.angle = Math.PI / 2;
    b.trail.resetStraight(0, 0, Math.PI / 2, 20);
    a.x = -3; a.z = -3; a.angle = 0; a.protect = 3;
    a.trail.resetStraight(-3, -3, 0, 10);
    w.setInput(0, { angle: 0, boost: false });
    w.setInput(1, { angle: Math.PI / 2, boost: false });
    for (let i = 0; i < 20; i++) w.step(DT);
    expect(a.alive).toBe(true);
  });

  it("wächst pro Punkt um ein Segment", () => {
    const w = new World(11);
    const s = w.addPlayer(0, "A", 0);
    s.score = 25;
    expect(s.length).toBe(CFG.startLength + 25);
  });

  it("Boost kostet Punkte", () => {
    const w = new World(7);
    const s = w.addPlayer(0, "A", 0);
    s.score = 50;
    // keine Orbs, damit nur der Boost zählt
    for (const o of [...w.orbs.values()]) (w as any).removeOrb(o, -1);
    (w as any).spawnRandomOrb = () => {};
    w.setInput(0, { angle: s.angle, boost: true });
    for (let i = 0; i < CFG.tickRate; i++) w.step(DT);
    expect(s.score).toBe(50 - CFG.boostDrainPerSec);
  });

  it("Spieler, der geht, wird zu Orbs", () => {
    const w = new World(9);
    w.addPlayer(0, "A", 0);
    w.flush();
    w.removePlayer(0);
    const f = w.flush();
    expect(f.orbAdded.length).toBeGreaterThan(0);
    expect(w.snakes.size).toBe(0);
  });

  it("Kopf an Kopf: die längere Schlange gewinnt und bekommt den Kill", () => {
    const w = new World(13);
    const a = w.addPlayer(0, "A", 0);
    const b = w.addPlayer(1, "B", 1);
    a.protect = b.protect = 0;
    a.score = 40;
    b.score = 10;
    a.x = 0; a.z = -4; a.angle = 0;
    b.x = 0; b.z = 4; b.angle = Math.PI;
    a.trail.resetStraight(a.x, a.z, a.angle, 40);
    b.trail.resetStraight(b.x, b.z, b.angle, 40);
    w.setInput(0, { angle: 0, boost: false });
    w.setInput(1, { angle: Math.PI, boost: false });
    w.flush();
    for (let i = 0; i < 30 && b.alive; i++) w.step(DT);
    expect(b.alive).toBe(false);
    expect(a.alive).toBe(true);
    expect(a.kills).toBe(1);
    const ev = w.flush().events;
    expect(ev.some((e) => e.t === "kill" && e.killer === 0 && e.victim === 1 && e.head)).toBe(true);
  });

  it("Kopf an Kopf bei gleicher Länge: immer genau ein Sieger", () => {
    for (let seed = 1; seed < 8; seed++) {
      const w = new World(seed);
      const a = w.addPlayer(0, "A", 0);
      const b = w.addPlayer(1, "B", 1);
      a.protect = b.protect = 0;
      a.x = 0; a.z = -4; a.angle = 0;
      b.x = 0; b.z = 4; b.angle = Math.PI;
      a.trail.resetStraight(a.x, a.z, a.angle, 20);
      b.trail.resetStraight(b.x, b.z, b.angle, 20);
      w.setInput(0, { angle: 0, boost: false });
      w.setInput(1, { angle: Math.PI, boost: false });
      for (let i = 0; i < 30 && a.alive && b.alive; i++) w.step(DT);
      expect(Number(a.alive) + Number(b.alive)).toBe(1);
    }
  });

  it("Boost-Pad macht schneller", () => {
    const w = new World(17);
    const pad = w.terrain.pads[0];
    expect(w.terrain.pads.length).toBeGreaterThan(10);
    const s = w.addPlayer(0, "A", 0);
    s.x = pad.x; s.z = pad.z;
    s.trail.resetStraight(s.x, s.z, s.angle, 10);
    w.setInput(0, { angle: s.angle, boost: false });
    const x0 = s.x, z0 = s.z;
    w.step(DT);
    expect(Math.hypot(s.x - x0, s.z - z0)).toBeCloseTo(CFG.padSpeed * DT, 1);
  });

  it("Goldener Orb erscheint und gibt viele Punkte", () => {
    const w = new World(19);
    const s = w.addPlayer(0, "A", 0);
    w.flush();
    for (let i = 0; i < CFG.goldFirst * CFG.tickRate + 5; i++) {
      s.protect = 5;
      s.x = 0; s.z = 0;
      w.step(DT);
    }
    const ev = w.flush().events;
    const gold = ev.find((e) => e.t === "gold");
    expect(gold).toBeTruthy();
    expect(w.goldId).toBeGreaterThan(0);
    expect(w.orbs.get(w.goldId)!.v).toBe(CFG.goldValue);
  });
});
