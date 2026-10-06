import { describe, it, expect } from "vitest";
import { ROADS } from "../src/map.js";
import {
  reachFromBox,
  adjacency,
  edgeDisjointTo,
  walkReachable,
  MARGIN,
} from "../src/netcheck.js";
import { ROAD_SEGMENTS, FOREST_ZONES, DISTRICT_PARCELS } from "../src/mapdata.js";
import { LOCATIONS } from "../../backend/src/locations.js";

/**
 * The network invariants, asserted against the real network.
 *
 * These are the checks three comments used to claim existed. The verifier that did
 * them was a scratch file under the OS temp directory; when it was deleted the
 * claim stayed in the comments and nothing enforced it — the pre-rebuild network
 * had a 990-tile "North Ring" and 86 of the 100 locations with no road within a
 * tile of them. scripts/emit-scenery-data.mjs runs the same checks and refuses to
 * write a broken map; this file is the version that runs in CI.
 *
 * Everything is measured on TILES, with the 1-tile clearance scenery.ts bakes into
 * BLOCKED, not on segment endpoints. Two roads whose ends line up on the same row
 * are not connected unless their expanded tile rects actually meet.
 */

/** The town core, in tiles. The seed for every reachability walk. */
const CORE = { x: 415, y: 195, w: 255, h: 275 };
const SEGMENTS = ROADS.map((r) => ({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 }));
const NAMES = ROAD_SEGMENTS.map((s) => s.name);
const ADJ = adjacency(SEGMENTS, 1050, 640);
const REACH = reachFromBox(SEGMENTS, CORE, 1050, 640);

describe("road network", () => {
  it("criterion 8: every segment lies inside the world", () => {
    for (const [i, s] of SEGMENTS.entries()) {
      expect(s.x1, `${NAMES[i]} x1`).toBeGreaterThanOrEqual(0);
      expect(s.y1, `${NAMES[i]} y1`).toBeGreaterThanOrEqual(0);
      expect(s.x2, `${NAMES[i]} x2`).toBeLessThan(1050);
      expect(s.y2, `${NAMES[i]} y2`).toBeLessThan(640);
    }
  });

  it("criterion 4: no orphan segments — every road is reachable from the core", () => {
    const orphans = REACH.orphans.map((i) =>
      `${NAMES[i]} at ${SEGMENTS[i]!.x1},${SEGMENTS[i]!.y1}`);
    expect(orphans, `unreachable road segments:\n${orphans.join("\n")}`).toEqual([]);
    expect(REACH.reachable.size, "reachable segment count").toBe(SEGMENTS.length);
  });

  it("criterion 6: connectivity holds on the tile graph, not on endpoints", () => {
    // scenery.ts blocks x1-1..x2+1 around every road, so two segments are joined
    // when their EXPANDED tile rects share a tile. A road at y=100..101 expands
    // to 99..102:
    //   - a road starting at y=103 expands to 102..105 and shares tile 102 -> joined
    //   - a road starting at y=104 expands to 103..106 and shares nothing -> separate
    // Both roads cover the same x-range, so an endpoint-proximity test would call
    // them connected in either case and never notice the difference.
    const a = { x1: 100, y1: 100, x2: 160, y2: 101 };
    const seed = { x: 95, y: 95, w: 5, h: 5 };
    const oneTile = reachFromBox([a, { x1: 100, y1: 103, x2: 160, y2: 104 }], seed, 1050, 640);
    expect(oneTile.reachable.size, "a one-tile gap does connect, as BLOCKED implies").toBe(2);
    const twoTiles = reachFromBox([a, { x1: 100, y1: 104, x2: 160, y2: 105 }], seed, 1050, 640);
    expect(twoTiles.reachable.size, "a two-tile gap shares no expanded tile").toBe(1);
    expect(MARGIN, "the margin is the one scenery.ts uses").toBe(1);
  });

  it("criterion 7: every location can be walked to from the core", () => {
    const { unreachable } = walkReachable({
      roads: SEGMENTS,
      locations: LOCATIONS.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h })),
      core: CORE,
      worldW: 1050,
      worldH: 640,
    });
    expect(unreachable, `not reachable on foot:\n${unreachable.join("\n")}`).toEqual([]);
    expect(LOCATIONS.length, "the location table is the full 100").toBe(100);
  });

  it("criterion 9: no road runs through a building footprint", () => {
    const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const offenders: string[] = [];
    for (const [i, s] of SEGMENTS.entries()) {
      const road = { x: s.x1, y: s.y1, w: s.x2 - s.x1 + 1, h: s.y2 - s.y1 + 1 };
      for (const l of LOCATIONS) {
        if (hit(road, { x: l.x, y: l.y, w: l.w, h: l.h })) offenders.push(`${NAMES[i]} / ${l.id}`);
      }
    }
    expect(offenders, `roads through buildings:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("criterion 5: no district hangs off a single bridge", () => {
    // Max edge-disjoint paths from the district's own segments to the core set. A
    // value of 2 is the certificate that deleting any one road cannot isolate it.
    const coreSet = new Set(SEGMENTS.map((s, i) => i).filter((i) => {
      const s = SEGMENTS[i]!;
      return s.x1 >= CORE.x && s.x2 <= CORE.x + CORE.w && s.y1 >= CORE.y && s.y2 <= CORE.y + CORE.h;
    }));
    expect(coreSet.size, "the core has roads in it").toBeGreaterThan(0);

    const report: string[] = [];
    for (const d of DISTRICT_PARCELS) {
      const touching = SEGMENTS.map((_, i) => i).filter((i) => {
        const s = SEGMENTS[i]!;
        return s.x1 <= d.x + d.w && s.x2 >= d.x && s.y1 <= d.y + d.h && s.y2 >= d.y;
      });
      expect(touching.length, `${d.name} has no road at all`).toBeGreaterThan(0);
      if (touching.every((i) => coreSet.has(i))) continue;   // the core itself
      const paths = edgeDisjointTo(SEGMENTS, ADJ, touching, coreSet);
      report.push(`${d.name}: ${paths}`);
      expect(paths, `${d.name} has only ${paths} independent route(s) to the core`).toBeGreaterThanOrEqual(2);
    }
    expect(report.length, "every non-core district was checked").toBeGreaterThanOrEqual(8);
  });

  it("has real blocks rather than stubs", () => {
    // A street grid is closed loops. Every segment end that is not on a street
    // corner must still touch another carriageway, or it is a dead end.
    const dead: string[] = [];
    for (const [i, s] of SEGMENTS.entries()) {
      for (const [ex, ey, horiz] of [
        [s.x1, s.y1, true], [s.x2, s.y2, true], [s.x1, s.y1, false], [s.x2, s.y2, false],
      ] as const) {
        let touches = 0;
        for (let j = 0; j < SEGMENTS.length; j++) {
          if (j === i) continue;
          const o = SEGMENTS[j]!;
          const box = { x: o.x1, y: o.y1, w: o.x2 - o.x1 + 1, h: o.y2 - o.y1 + 1 };
          const inside = horiz
            ? ex >= box.x - MARGIN && ex <= box.x + box.w + MARGIN && ey >= box.y - MARGIN && ey <= box.y + box.h + MARGIN
            : ey >= box.y - MARGIN && ey <= box.y + box.h + MARGIN && ex >= box.x - MARGIN && ex <= box.x + box.w + MARGIN;
          if (inside) touches++;
        }
        if (touches === 0) dead.push(`${NAMES[i]} ${horiz ? "h" : "v"} at ${ex},${ey}`);
      }
    }
    expect(dead, `dead-end road ends:\n${dead.join("\n")}`).toEqual([]);
  });

  it("keeps core roads a small minority", () => {
    // Signalling every rural crossroads made the map read like an airport. The
    // ratio is allowed to move, but it must stay a minority by a wide margin.
    const core = ROAD_SEGMENTS.filter((s) => s.core).length;
    expect(core).toBeGreaterThan(0);
    expect(core / ROAD_SEGMENTS.length, "core share of the network").toBeLessThan(0.45);
  });

  it("the network reads as a grid, not as roads through country", () => {
    const lengths = ROAD_SEGMENTS.map((s) => Math.max(s.x2 - s.x1, s.y2 - s.y1) + 1);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    expect(ROAD_SEGMENTS.length, "segment count").toBeGreaterThanOrEqual(200);
    expect(mean, "mean segment length is one block edge").toBeLessThan(80);
    expect(Math.max(...lengths), "no arterial spans the map").toBeLessThan(220);
    // two ring levels: the outer ring at the map edge, the inner orbital at ~x420
    const outer = ROAD_SEGMENTS.some((s) => s.y1 === 60 && s.x1 === 30);
    const inner = ROAD_SEGMENTS.some((s) => s.x1 === 420 && s.y1 === 201);
    expect(outer, "outer ring present").toBe(true);
    expect(inner, "inner orbital present").toBe(true);
  });

  it("forest zones are parks, not wilderness", () => {
    const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    expect(FOREST_ZONES.length, "zone count").toBeGreaterThanOrEqual(8);
    expect(FOREST_ZONES.length, "zone count").toBeLessThanOrEqual(12);
    for (let i = 0; i < FOREST_ZONES.length; i++) {
      for (let j = i + 1; j < FOREST_ZONES.length; j++) {
        expect(hit(FOREST_ZONES[i]!, FOREST_ZONES[j]!), `${FOREST_ZONES[i]!.name}/${FOREST_ZONES[j]!.name}`).toBe(false);
      }
    }
    // A park sits inside a block: it must not have a carriageway through it, and
    // it must not be sitting on a roof.
    for (const f of FOREST_ZONES) {
      for (const l of LOCATIONS) {
        expect(hit(f, { x: l.x, y: l.y, w: l.w, h: l.h }), `${f.name} covers ${l.id}`).toBe(false);
      }
      for (const s of SEGMENTS) {
        expect(
          hit(f, { x: s.x1, y: s.y1, w: s.x2 - s.x1 + 1, h: s.y2 - s.y1 + 1 }),
          `${f.name} is paved over`,
        ).toBe(false);
      }
    }
    const area = FOREST_ZONES.reduce((a, f) => a + f.w * f.h, 0);
    const share = area / (1050 * 640);
    expect(share, "forest covers too little to be a green city").toBeGreaterThan(0.05);
    expect(share, "forest still covers wilderness").toBeLessThan(0.1);
  });
});
