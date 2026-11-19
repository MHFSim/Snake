import type { PowerKind } from "../core/config";
import type { Terrain } from "../sim/terrain";
import type { SimEvent } from "../sim/world";
import type { PlayerInfo } from "./protocol";

// Gemeinsame Sicht auf ein laufendes Spiel, egal ob Host oder Client.
// Die Grafik liest nur von hier.

export interface RSnake {
  id: number;
  alive: boolean;
  x: number;
  z: number;
  angle: number;
  score: number;
  kills: number;
  flags: number;
}

export interface SessionListener {
  orbAdd(id: number, x: number, z: number, v: number, hue: number): void;
  orbRemove(id: number, eater: number): void;
  powAdd(id: number, x: number, z: number, kind: PowerKind): void;
  powRemove(id: number): void;
  event(ev: SimEvent): void;
  snakeInit(id: number, x: number, z: number, a: number, pts: number[]): void;
  players(list: PlayerInfo[]): void;
  disconnected(reason: string): void;
}

export interface Session {
  readonly isHost: boolean;
  readonly myId: number;
  readonly seed: number;
  readonly terrain: Terrain;
  roomCode: string;
  players: PlayerInfo[];
  // Darstellungszustand aller Schlangen (interpoliert bzw. vorhergesagt)
  readonly snakes: Map<number, RSnake>;
  ping: number;
  setInput(angle: number, boost: boolean, jump?: boolean): void;
  sendEmote(k: number): void;
  // Wird jeden Frame aufgerufen; aktualisiert snakes
  update(nowMs: number): void;
  // Spielzeit in Sekunden, für alle Spieler gleich (z. B. für Tag und Nacht)
  serverTime(nowMs: number): number;
  dispose(): void;
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
