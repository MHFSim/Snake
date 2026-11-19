// Zentrale Spielwerte. Spiellogik und Darstellung lesen von hier.
export const CFG = {
  tickRate: 30,
  mapSize: 600, // Meter, Karte geht von -300 bis +300
  maxPlayers: 8,

  baseSpeed: 8,
  boostSpeed: 14,
  turnRate: Math.PI, // 180 °/s
  startLength: 10,
  pointsPerSegment: 1, // jeder Punkt = 1 Segment (5x schnelleres Wachstum)
  segmentSpacing: 0.6,
  minBoostScore: 2,
  boostDrainPerSec: 2, // 1 Segment pro 0,5 s
  boostDropInterval: 0.5,
  boostDropValue: 1,

  orbTarget: 1500,
  orbSmallValue: 1,
  deathShare: 0.5, // tote Schlange wird zu Orbs im Wert ihrer halben Länge
  maxPowerUps: 6,
  powerUpInterval: 8,
  respawnDelay: 3,
  spawnProtect: 3,

  powerDur: { magnet: 8, ghost: 5, turbo: 6, shield: 0, double: 10 },
  magnetRange: 10,

  // Goldener Orb: großes Event mit Lichtsäule
  goldValue: 40,
  goldFirst: 40, // Sekunden bis zum ersten Gold-Orb
  goldInterval: 75,

  // Boost-Pads auf der Karte
  padCount: 26,
  padRadius: 2.8,
  padSpeed: 20,
  padDuration: 1.2,

  // Tag-Nacht-Zyklus (Sekunden pro Tag)
  dayLength: 360,

  snapshotRate: 15,
  interpDelayMs: 100,
  protocolVersion: 4,
} as const;

export const HALF = CFG.mapSize / 2;

export type PowerKind = "magnet" | "ghost" | "turbo" | "shield" | "double";
export const POWER_KINDS: PowerKind[] = ["magnet", "ghost", "turbo", "shield", "double"];

// Farbpaare (Kopf -> Schwanz) für die 8 Spielerfarben
export const SNAKE_COLORS: [string, string][] = [
  ["#36f1cd", "#1b6cff"],
  ["#ff5f6d", "#ffc371"],
  ["#a855f7", "#ec4899"],
  ["#facc15", "#f97316"],
  ["#22c55e", "#0ea5e9"],
  ["#f472b6", "#8b5cf6"],
  ["#e2e8f0", "#64748b"],
  ["#fb923c", "#dc2626"],
];

// Muster der Schlange. Im Feld "color" steckt Farbe + 8 * Muster.
export const SKINS = ["Verlauf", "Streifen", "Tiger", "Regenbogen"];
export const EMOTES = ["😂", "😡", "👋", "💀", "🔥", "👑"];
export const colorOf = (c: number) => ((c % 8) + 8) % 8;
export const skinOf = (c: number) => Math.floor(c / 8) % SKINS.length;

export function lengthFromScore(score: number): number {
  return CFG.startLength + Math.floor(score / CFG.pointsPerSegment);
}

export function radiusFromLength(len: number): number {
  return 0.5 + Math.min(0.9, Math.sqrt(Math.max(0, len - CFG.startLength)) * 0.045);
}

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
