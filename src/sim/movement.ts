import { CFG, radiusFromLength, wrapAngle } from "../core/config";
import type { Terrain } from "./terrain";

// Kopfbewegung eines Ticks. Gleiche Funktion beim Host (Wahrheit) und beim Client (Vorhersage).
export interface HeadState {
  x: number;
  z: number;
  angle: number;
}

const tmp = { x: 0, z: 0 };

export function stepHead(
  st: HeadState,
  targetAngle: number,
  boosting: boolean,
  len: number,
  dt: number,
  terrain: Terrain,
) {
  const turn = CFG.turnRate * (1 - Math.min(0.35, (len - CFG.startLength) / 900));
  const diff = wrapAngle(targetAngle - st.angle);
  const maxTurn = turn * dt;
  st.angle = wrapAngle(st.angle + Math.max(-maxTurn, Math.min(maxTurn, diff)));
  const speed = boosting ? CFG.boostSpeed : CFG.baseSpeed;
  let nx = st.x + Math.sin(st.angle) * speed * dt;
  let nz = st.z + Math.cos(st.angle) * speed * dt;
  if (terrain.pushOut(nx, nz, radiusFromLength(len) * 0.7, tmp)) {
    nx = tmp.x;
    nz = tmp.z;
  }
  st.x = nx;
  st.z = nz;
}
