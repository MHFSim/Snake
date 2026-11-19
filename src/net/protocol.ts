import type { PowerKind } from "../core/config";
import type { SimEvent } from "../sim/world";

// ---------- Zuverlässiger Kanal (Objekte, PeerJS "binary") ----------

export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
  ping: number;
}

export interface SnakeInit {
  id: number;
  flags: number;
  x: number;
  z: number;
  a: number;
  score: number;
  kills: number;
  pts: number[]; // Körperpunkte [x,z,...] vom Kopf zum Schwanz
}

export type ReliableMsg =
  | { t: "hello"; v: number; name: string; color: number; token: string }
  | {
      t: "welcome";
      id: number;
      seed: number;
      tick: number;
      players: PlayerInfo[];
      snakes: SnakeInit[];
      orbs: number[]; // [id,x,z,v,hue, ...]
      pows: (number | string)[]; // [id,x,z,kind, ...]
    }
  | { t: "reject"; reason: "full" | "version" | "name" }
  | { t: "players"; list: PlayerInfo[] }
  | {
      t: "d"; // Änderungen eines Ticks
      ev: SimEvent[];
      oa: number[];
      or: number[];
      pa: (number | string)[];
      pr: number[];
    }
  | { t: "emote"; k: number }
  | { t: "ping"; ts: number; rtt?: number }
  | { t: "pong"; ts: number };

// ---------- Schneller Kanal (binär, unzuverlässig) ----------

export const MSG_INPUT = 1;
export const MSG_SNAPSHOT = 2;

export const F_ALIVE = 1;
export const F_BOOST = 2;
export const F_PROTECT = 4;
export const F_GHOST = 8;
export const F_SHIELD = 16;
export const F_MAGNET = 32;
export const F_TURBO = 64;
export const F_FAST = 128; // auf einem Boost-Pad
export const F_DOUBLE = 256;

const POS = 50; // 1/50 m
const ANG = 10000;

export interface InputRec {
  seq: number;
  angle: number;
  boost: boolean;
}

export function encodeInputs(list: InputRec[]): ArrayBuffer {
  const buf = new ArrayBuffer(2 + list.length * 7);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_INPUT);
  dv.setUint8(1, list.length);
  let o = 2;
  for (const r of list) {
    dv.setUint32(o, r.seq);
    dv.setInt16(o + 4, Math.round(r.angle * ANG));
    dv.setUint8(o + 6, r.boost ? 1 : 0);
    o += 7;
  }
  return buf;
}

export function decodeInputs(buf: ArrayBuffer): InputRec[] {
  const dv = new DataView(buf);
  const n = dv.getUint8(1);
  const res: InputRec[] = [];
  let o = 2;
  for (let i = 0; i < n && o + 7 <= buf.byteLength; i++) {
    res.push({ seq: dv.getUint32(o), angle: dv.getInt16(o + 4) / ANG, boost: dv.getUint8(o + 6) === 1 });
    o += 7;
  }
  return res;
}

export interface SnapSnake {
  id: number;
  flags: number;
  x: number;
  z: number;
  a: number;
  score: number;
  kills: number;
}

export interface Snapshot {
  tick: number;
  ack: number;
  snakes: SnapSnake[];
}

const SNAKE_BYTES = 14;

export function encodeSnapshot(tick: number, ack: number, snakes: SnapSnake[]): ArrayBuffer {
  const buf = new ArrayBuffer(10 + snakes.length * SNAKE_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, MSG_SNAPSHOT);
  dv.setUint32(1, tick);
  dv.setUint32(5, ack);
  dv.setUint8(9, snakes.length);
  let o = 10;
  for (const s of snakes) {
    dv.setUint8(o, s.id);
    dv.setUint16(o + 1, s.flags);
    dv.setInt16(o + 3, Math.round(s.x * POS));
    dv.setInt16(o + 5, Math.round(s.z * POS));
    dv.setInt16(o + 7, Math.round(s.a * ANG));
    dv.setUint32(o + 9, Math.min(0xffffffff, Math.max(0, Math.round(s.score))));
    dv.setUint8(o + 13, Math.min(255, s.kills));
    o += SNAKE_BYTES;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): Snapshot {
  const dv = new DataView(buf);
  const tick = dv.getUint32(1);
  const ack = dv.getUint32(5);
  const n = dv.getUint8(9);
  const snakes: SnapSnake[] = [];
  let o = 10;
  for (let i = 0; i < n; i++) {
    snakes.push({
      id: dv.getUint8(o),
      flags: dv.getUint16(o + 1),
      x: dv.getInt16(o + 3) / POS,
      z: dv.getInt16(o + 5) / POS,
      a: dv.getInt16(o + 7) / ANG,
      score: dv.getUint32(o + 9),
      kills: dv.getUint8(o + 13),
    });
    o += SNAKE_BYTES;
  }
  return { tick, ack, snakes };
}

export function powToArr(p: { id: number; x: number; z: number; kind: PowerKind }[]): (number | string)[] {
  const res: (number | string)[] = [];
  for (const q of p) res.push(q.id, Math.round(q.x * 100) / 100, Math.round(q.z * 100) / 100, q.kind);
  return res;
}

export function orbsToArr(o: { id: number; x: number; z: number; v: number; hue: number }[]): number[] {
  const res: number[] = [];
  for (const q of o) res.push(q.id, Math.round(q.x * 100) / 100, Math.round(q.z * 100) / 100, q.v, q.hue);
  return res;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function makeRoomCode(): string {
  let s = "";
  const arr = new Uint32Array(6);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 6; i++) s += CODE_CHARS[arr[i] % CODE_CHARS.length];
  return s;
}
export function normalizeCode(c: string): string {
  return c.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}
export const PEER_PREFIX = "snakearena3d-v1-";
