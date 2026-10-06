import type { Resident } from "@hermesbook/shared";

export function tickNeeds(needs: Resident["needs"], act: string, dtSec: number): Resident["needs"] {
  const next = { ...needs };
  // idle drift: slow increase
  const drift = 0.0008 * dtSec;
  next.hunger = Math.min(1, next.hunger + drift * 0.9);
  next.thirst = Math.min(1, next.thirst + drift * 1.1);
  next.tired = Math.min(1, next.tired + drift * 0.7);
  next.lonely = Math.min(1, next.lonely + drift * 0.6);

  switch (act) {
    case "graze":
      next.hunger = Math.max(0, next.hunger - 0.12);
      next.tired = Math.min(1, next.tired + 0.02);
      break;
    case "drink":
      next.thirst = Math.max(0, next.thirst - 0.18);
      break;
    case "sleep":
      next.tired = Math.max(0, next.tired - 0.15);
      next.hunger = Math.min(1, next.hunger + 0.01);
      break;
    case "argue":
    case "talk":
      next.lonely = Math.max(0, next.lonely - 0.14);
      next.tired = Math.min(1, next.tired + 0.01);
      break;
    case "work":
      next.hunger = Math.min(1, next.hunger + 0.015);
      next.tired = Math.min(1, next.tired + 0.02);
      break;
    case "wander":
    case "stroll":
    case "explore":
      next.lonely = Math.max(0, next.lonely - 0.06);
      next.tired = Math.min(1, next.tired + 0.015);
      next.hunger = Math.min(1, next.hunger + 0.008);
      break;
    case "spit":
      next.lonely = Math.min(1, next.lonely + 0.05);
      break;
  }
  // clamp
  for (const k of Object.keys(next) as Array<keyof typeof next>) {
    next[k] = Math.max(0, Math.min(1, next[k]));
  }
  return next;
}

export function isNight(clock: number): boolean {
  // clock 0..1, night approx >0.72 && <0.92 per doc lighting (night >0.01)
  // simpler: clock >0.75 is night, <0.25 dawn
  return clock > 0.72;
}

export { dayClock } from "@hermesbook/shared";
