import { describe, it, expect } from "vitest";
import { LOCATIONS } from "../src/canvas/locationsData.js";
import { Pe, vt, V } from "../src/canvas/constants.js";
import { ROADS, DISTRICT_PARCELS, ACCESS_SPURS } from "@slopagentbook/shared";
import { TREES, PAVED, PAVED_RECTS } from "../src/canvas/scenery.js";

/**
 * Canopy colours from drawTree, against the two grounds a tree can stand on.
 *
 * Kept here as data rather than read out of the canvas module, because drawTree
 * is a draw function: the literals are inside it and there is no way to assert
 * against them from a test. Duplicating them is the price; a wrong copy fails
 * nothing, which is stated here rather than glossed over.
 *
 * The measured defect: three of the seven dark canopies sat within 1.43:1 of the
 * ground under them, and the pine at 1.17:1 was effectively invisible on the dark
 * theme. Values under ~1.3 read as a smudge rather than a tree.
 */
const DARK_CANOPY = {
  pine: "#35603a",
  bush: "#3f6b39",
  bushHighlight: "#3c6234",
  birch: "#3f7a4a",
  birchHighlight: "#5a9a5f",
  oak: "#3f6b39",
  oakHighlight: "#3c6234",
};
const DARK_GROUNDS = { parkFloor: "#1c3524", field: "#1e2e22" };

/** WCAG relative luminance. */
function luminance(hexColor: string): number {
  const v = [1, 3, 5].map((i) => {
    const c = parseInt(hexColor.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}

function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The tile a tree is standing on: x is its column, y its base row. */
function tileOf(t: { x: number; y: number }): [number, number] {
  return [Math.floor(t.x / V), Math.floor((t.y - 14) / V)];
}

describe("scenery paving", () => {
  it("no tree stands on a paved tile", () => {
    // The property the block-interior survival rate violated. 0.03 looked
    // invisible in the count and put hundreds of pines on asphalt on screen, and
    // a probability cannot express "a tree on pavement is wrong" — so this is a
    // gate in the tree loop and this is the assertion that keeps it a gate.
    for (const t of TREES) {
      const [tx, ty] = tileOf(t);
      if (tx < 0 || ty < 0 || tx >= Pe || ty >= vt) continue;
      expect(PAVED[ty * Pe + tx], `tree at ${tx},${ty} stands on paved ground`).toBe(0);
    }
  });

  it("pavement is always within reach of a road or a footprint", () => {
    // An empty paved rectangle with nothing built inside it is what defect 1
    // was. PAVED is built as a dilation of the roads and footprints clipped to a
    // parcel, so this cannot hold by construction — which is the point: the
    // invariant is structural, not a convention somebody has to remember.
    const REACH = 12;
    // The built ground itself, marked tile-wise first. Scanning all 300+ rects
    // per tile is 200M comparisons; marking the rects once is the same answer
    // for a few hundred thousand writes.
    const built = new Uint8Array(Pe * vt);
    const mark = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = Math.max(0, y0); y <= Math.min(vt - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(Pe - 1, x1); x++) built[y * Pe + x] = 1;
      }
    };
    for (const r of ROADS) mark(r.x1 - 1, r.y1 - 1, r.x2 + 1, r.y2 + 1);
    for (const l of LOCATIONS) mark(l.x - 1, l.y - 1, l.x + l.w, l.y + l.h);
    // then grown outwards by REACH, separably: a tile is near if its own row has
    // built ground within REACH columns, and so do REACH rows either side of it.
    // Two passes over the grid instead of a 25x25 window per built tile.
    const row = new Uint8Array(Pe * vt);
    for (let ty = 0; ty < vt; ty++) {
      let last = -REACH * 2;
      for (let tx = 0; tx < Pe; tx++) {
        if (built[ty * Pe + tx]) last = tx;
        if (tx - last <= REACH) row[ty * Pe + tx] = 1;
      }
      last = Pe + REACH;
      for (let tx = Pe - 1; tx >= 0; tx--) {
        if (built[ty * Pe + tx]) last = tx;
        if (last - tx <= REACH) row[ty * Pe + tx] = 1;
      }
    }
    const near = new Uint8Array(Pe * vt);
    for (let ty = 0; ty < vt; ty++) {
      for (let tx = 0; tx < Pe; tx++) {
        let n = 0;
        for (let dy = -REACH; dy <= REACH && !n; dy++) {
          const y = ty + dy;
          if (y < 0 || y >= vt) continue;
          if (row[y * Pe + tx]) n = 1;
        }
        near[ty * Pe + tx] = n;
      }
    }
    const orphans: string[] = [];
    let paved = 0;
    for (let ty = 0; ty < vt; ty++) {
      for (let tx = 0; tx < Pe; tx++) {
        if (!PAVED[ty * Pe + tx]) continue;
        paved++;
        if (!near[ty * Pe + tx] && orphans.length < 5) orphans.push(`${tx},${ty}`);
      }
    }
    expect(orphans, `paved tiles with no road or footprint within ${REACH} tiles`).toEqual([]);
    // and the bake is not vacuously true
    expect(paved).toBeGreaterThan(10000);
  });

  it("paved ground does not cover a whole district parcel", () => {
    // The regression, stated as a number per district: each parcel must keep some
    // unbuilt ground. University Quarter's parcel is 184x46 tiles around two
    // buildings, so a parcel that is still ~fully paved is the car park coming
    // back.
    for (const p of DISTRICT_PARCELS) {
      let unpaved = 0;
      for (let ty = p.y; ty < p.y + p.h; ty++) {
        for (let tx = p.x; tx < p.x + p.w; tx++) {
          if (!PAVED[ty * Pe + tx]) unpaved++;
        }
      }
      expect(unpaved, `parcel ${p.name} is paved end to end`).toBeGreaterThan(0);
    }
  });

  it("every dark canopy is a visible mass on the ground beneath it", () => {
    // The dark theme drew trees in colours barely distinguishable from the park
    // floor: pine at 1.17:1, bush and oak at 1.31:1. On the light theme the
    // canopy is DARKER than the floor, which is what makes it read; inverting
    // that relationship without lifting the value made the trees vanish.
    for (const [name, canopy] of Object.entries(DARK_CANOPY)) {
      for (const [groundName, ground] of Object.entries(DARK_GROUNDS)) {
        const ratio = contrastRatio(canopy, ground);
        expect(
          ratio,
          `dark canopy ${name} (${canopy}) on ${groundName} (${ground}) is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(1.5);
      }
    }
  });

  it("every built building stands on or beside pavement", () => {
    // What the access spurs exist for. PAVED grows from road tiles, so a building
    // with no tarmac near it gets pavement only in the ring around its own walls
    // and the gap to the street stays grass — the district then reads as a field
    // with sheds in it. 41 of 87 built locations were in that state before.
    const built = LOCATIONS.filter((l) => l.category !== "Food" && l.category !== "Water");
    const stranded: string[] = [];
    for (const l of built) {
      let touches = false;
      for (let y = l.y - 1; y <= l.y + l.h && !touches; y++) {
        for (let x = l.x - 1; x <= l.x + l.w; x++) {
          if (x < 0 || y < 0 || x >= Pe || y >= vt) continue;
          if (PAVED[y * Pe + x]) {
            touches = true;
            break;
          }
        }
      }
      if (!touches) stranded.push(l.id);
    }
    expect(stranded, "buildings with no pavement touching them").toEqual([]);
  });

  it("no access spur runs off the map", () => {
    // A spur is derived from the road and location tables, so a coordinate error
    // in either would quietly produce a driveway into the void. Cheap to catch.
    for (const s of ACCESS_SPURS) {
      for (const [x, y] of [
        [s.x1, s.y1],
        [s.x2, s.y2],
      ]) {
        expect(
          x >= 0 && y >= 0 && x < Pe && y < vt,
          `spur for ${s.building} ends off-map at ${x},${y}`,
        ).toBe(true);
      }
    }
  });

  it("every access spur begins on a road, so none can orphan", () => {
    // The whole reason the spurs may be derived rather than hand-authored. If a
    // spur started on grass it would be a lane to nowhere, and nothing else in
    // the pipeline would notice.
    const onRoad = new Set<string>();
    for (const r of ROADS) {
      for (let y = Math.min(r.y1, r.y2); y <= Math.max(r.y1, r.y2); y++) {
        for (let x = Math.min(r.x1, r.x2); x <= Math.max(r.x1, r.x2); x++) onRoad.add(`${x},${y}`);
      }
    }
    const seen = new Set<string>();
    for (const s of ACCESS_SPURS) {
      if (seen.has(s.building)) continue; // only the first leg leaves the road
      seen.add(s.building);
      expect(onRoad.has(`${s.x1},${s.y1}`), `spur for ${s.building} starts on grass`).toBe(true);
    }
  });

  it("PAVED_RECTS covers exactly the paved tiles", () => {
    // The ground fill draws the rects, not the mask, so the two drifting apart
    // would paint pavement where no tree is excluded. The check is a pass over
    // the paved area plus a tile count, not an assertion per fillRect.
    let covered = 0;
    const seen = new Uint8Array(Pe * vt);
    const bad: string[] = [];
    for (const r of PAVED_RECTS) {
      for (let y = r.y; y < r.y + r.h; y++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          const i = y * Pe + x;
          if (bad.length < 5 && !PAVED[i]) bad.push(`rect paints unpaved ${x},${y}`);
          if (seen[i] && bad.length < 5) bad.push(`rects overlap at ${x},${y}`);
          seen[i] = 1;
          covered++;
        }
      }
    }
    expect(bad).toEqual([]);
    let paved = 0;
    for (let i = 0; i < PAVED.length; i++) paved += PAVED[i]!;
    expect(covered, "rects must cover the whole paved area").toBe(paved);
    expect(PAVED_RECTS.length, "rect count should stay merged, not one per tile").toBeLessThan(400);
  });
});
