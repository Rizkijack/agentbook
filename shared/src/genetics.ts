import { clamp } from "./types.js";

export const HairCuts = ["shaggy", "mop", "bowl", "mohawk", "curly", "bob", "afro"] as const;
export const EarStyles = ["up", "droop", "alert", "flop"] as const;
export const EyeStyles = ["round", "squint", "wide", "dot", "sleepy"] as const;
export const Accessories = ["none", "bell", "hat", "glasses", "scarf", "flower"] as const;

export interface Genes {
  wool: number;
  cut: string;
  ears: string;
  eyes: string;
  extra: string;
  hue: number;
  build: number;
  neck: number;
  gen: number;
}

export function seededRandom(seed: string | number): () => number {
  let s: number;
  if (typeof seed === "number") s = seed >>> 0;
  else {
    s = 0;
    for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function Hc(dnaString: string): Genes {
  const parts = dnaString.split(".").map(Number);
  return {
    wool: parts[0] || 0,
    cut: (HairCuts as readonly string[])[parts[1]] ?? "shaggy",
    ears: (EarStyles as readonly string[])[parts[2]] ?? "up",
    eyes: (EyeStyles as readonly string[])[parts[3]] ?? "round",
    extra: (Accessories as readonly string[])[parts[4]] ?? "none",
    hue: Number.isFinite(parts[5]) ? parts[5] : 0,
    build: clamp(0.1, 0.95, (parts[6] || 50) / 100),
    neck: clamp(0.1, 0.95, (parts[7] || 50) / 100),
    gen: parts[8] || 0,
  };
}

export function encodeGenes(g: Genes): string {
  const cutIdx = (HairCuts as readonly string[]).indexOf(g.cut);
  const earIdx = (EarStyles as readonly string[]).indexOf(g.ears);
  const eyeIdx = (EyeStyles as readonly string[]).indexOf(g.eyes);
  const extraIdx = (Accessories as readonly string[]).indexOf(g.extra);
  return `${g.wool}.${cutIdx === -1 ? 0 : cutIdx}.${earIdx === -1 ? 0 : earIdx}.${eyeIdx === -1 ? 0 : eyeIdx}.${extraIdx === -1 ? 0 : extraIdx}.${Math.round(g.hue) % 360}.${Math.round(g.build * 100)}.${Math.round(g.neck * 100)}.${g.gen}`;
}

function randomFrom<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

export function rf(parentGenes: Genes, seedName: string): Genes {
  const rng = seededRandom(seedName);
  const child: Genes = { ...parentGenes };
  child.gen = Math.min(9, parentGenes.gen + 1);
  const hueShift = (rng() < 0.5 ? -1 : 1) * (14 + rng() * 26);
  child.hue = (parentGenes.hue + hueShift + 360) % 360;
  if (rng() < 0.4) child.cut = randomFrom(HairCuts, rng);
  if (rng() < 0.3) child.eyes = randomFrom(EyeStyles, rng);
  if (rng() < 0.45) child.extra = randomFrom(Accessories, rng);
  child.build = clamp(0.1, 0.95, parentGenes.build + (rng() - 0.5) * 0.25);
  child.neck = clamp(0.1, 0.95, parentGenes.neck + (rng() - 0.5) * 0.25);
  return child;
}
