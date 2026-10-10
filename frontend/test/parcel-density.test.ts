import { describe, it, expect } from "vitest";
import { LOCATIONS } from "../src/canvas/locationsData.js";
import { Pe, vt } from "../src/canvas/constants.js";
import { ROADS, DISTRICT_PARCELS, GROVE_SPECS } from "@slopagentbook/shared";
import { HOMES, FORESTS, TREES, PAVED } from "../src/canvas/scenery.js";

// The map read as one dense core with nothing around it: measured across the nine
// district parcels, the named buildings covered 7.3% of the ground they stand on.
// Housing is now spread over every parcel and each parcel owes itself a grove.
// These pin the properties that make that safe rather than the exact counts, which
// follow the map.

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const roadRect = (r: typeof ROADS[number]) => ({
  x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2),
  w: Math.abs(r.x2 - r.x1) + 1, h: Math.abs(r.y2 - r.y1) + 1,
});

describe("parcel housing", () => {
  it("is not empty, and is not only in the middle", () => {
    expect(HOMES.length).toBeGreaterThan(300);
    for (const p of DISTRICT_PARCELS) {
      const inside = HOMES.filter(
        (h) => h.x >= p.x && h.x < p.x + p.w && h.y >= p.y && h.y < p.y + p.h,
      );
      expect(inside.length, `${p.name} has no housing`).toBeGreaterThan(5);
    }
  });

  it("never overlaps a named location or a road", () => {
    // collect, then assert once. Asserting per comparison is ~63k expect() calls
    // and blows the 5s timeout once the suite runs in parallel with the others.
    const clashes: string[] = [];
    for (const h of HOMES) {
      for (const l of LOCATIONS) {
        if (overlaps(h, l)) clashes.push(`home ${h.x},${h.y} overlaps ${l.id}`);
      }
      for (const r of ROADS) {
        if (overlaps(h, roadRect(r))) clashes.push(`home ${h.x},${h.y} sits on ${r.name}`);
      }
    }
    expect(clashes.slice(0, 10), `${clashes.length} home clash(es)`).toEqual([]);
  });

  it("never overlaps another home", () => {
    const clashes: string[] = [];
    for (let i = 0; i < HOMES.length; i++) {
      for (let j = i + 1; j < HOMES.length; j++) {
        if (overlaps(HOMES[i]!, HOMES[j]!)) {
          clashes.push(`${HOMES[i]!.x},${HOMES[i]!.y} vs ${HOMES[j]!.x},${HOMES[j]!.y}`);
        }
      }
    }
    expect(clashes.slice(0, 10), `${clashes.length} home-on-home overlap(s)`).toEqual([]);
  });
});

describe("parcel groves", () => {
  const groves = () => FORESTS.filter((f) => f.name.endsWith("Grove"));

  it("one per district parcel, and the parcel each names really has one", () => {
    expect(groves().length).toBe(GROVE_SPECS.length);
    for (const spec of GROVE_SPECS) {
      const p = DISTRICT_PARCELS.find((d) => d.name === spec.parcel)!;
      expect(p, `no parcel named ${spec.parcel}`).toBeTruthy();
      const g = groves().find((x) => x.name === spec.name);
      expect(g, `${spec.name} was not emitted`).toBeTruthy();
      // inside its own parcel, or it is not that parcel's grove
      expect(g!.x).toBeGreaterThanOrEqual(p.x);
      expect(g!.y).toBeGreaterThanOrEqual(p.y);
      expect(g!.x + g!.w).toBeLessThanOrEqual(p.x + p.w);
      expect(g!.y + g!.h).toBeLessThanOrEqual(p.y + p.h);
    }
  });

  it("clears every building and every road", () => {
    // scenery.test.ts already asserts forest vs road; this pins forest vs building,
    // which is what actually strands a building when a grove lands on it.
    const clashes: string[] = [];
    for (const g of groves()) {
      for (const l of LOCATIONS) {
        if (overlaps(g, l)) clashes.push(`${g.name} overlaps ${l.id}`);
      }
      for (const r of ROADS) {
        if (overlaps(g, roadRect(r))) clashes.push(`${g.name} sits on ${r.name}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it("leaves every built building touching pavement", () => {
    // The defect that hand-placed groves caused: PAVED skips forest tiles, so a grove
    // drawn over a building deletes the apron that used to reach the street.
    const stranded: string[] = [];
    for (const l of LOCATIONS) {
      if (l.category === "Food" || l.category === "Water") continue;
      let touches = false;
      for (let y = l.y - 1; y <= l.y + l.h && !touches; y++) {
        for (let x = l.x - 1; x <= l.x + l.w; x++) {
          if (x < 0 || y < 0 || x >= Pe || y >= vt) continue;
          if (PAVED[y * Pe + x]) { touches = true; break; }
        }
      }
      if (!touches) stranded.push(l.id);
    }
    expect(stranded).toEqual([]);
  });

  it("actually grows trees on every parcel", () => {
    for (const p of DISTRICT_PARCELS) {
      const trees = TREES.filter(
        (t) => {
          const tx = Math.floor(t.x / 16), ty = Math.floor(t.y / 16);
          return tx >= p.x && tx < p.x + p.w && ty >= p.y && ty < p.y + p.h;
        },
      );
      expect(trees.length, `${p.name} has no trees`).toBeGreaterThan(5);
    }
  });
});

describe("built outweighs green across the parcels", () => {
  it("holds near the 70/30 split the map was tuned to", () => {
    const TREE_TILES = 4;
    let built = 0;
    let green = 0;
    for (const p of DISTRICT_PARCELS) {
      const inP = (x, y) => x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h;
      for (const l of LOCATIONS) if (inP(l.x + l.w / 2, l.y + l.h / 2)) built += l.w * l.h;
      for (const h of HOMES) if (inP(h.x + h.w / 2, h.y + h.h / 2)) built += h.w * h.h;
      for (const t of TREES) if (inP(Math.floor(t.x / 16), Math.floor(t.y / 16))) green += TREE_TILES;
      for (const g of FORESTS) {
        const ox = Math.max(p.x, g.x), oy = Math.max(p.y, g.y);
        const ox2 = Math.min(p.x + p.w, g.x + g.w), oy2 = Math.min(p.y + p.h, g.y + g.h);
        if (ox2 > ox && oy2 > oy) green += (ox2 - ox) * (oy2 - oy);
      }
    }
    const pct = (built / (built + green)) * 100;
    // wide band on purpose: this is a look, not a constant to re-pin on every nudge
    expect(pct, `built share is ${pct.toFixed(1)}%`).toBeGreaterThan(60);
    expect(pct, `built share is ${pct.toFixed(1)}%`).toBeLessThan(80);
  });
});