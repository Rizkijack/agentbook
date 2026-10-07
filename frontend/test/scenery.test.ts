import { describe, it, expect } from "vitest";
import { LOCATIONS } from "../src/canvas/locationsData.js";
import { WorldWidth, WorldHeight, Pe, vt, V } from "../src/canvas/constants.js";
import { MIN_ZOOM } from "../src/canvas/engine.js";
import {
  ROADS, TREES, PROPS, LIGHTS, VEHICLES, VEHICLE_COUNT, FORESTS, DISTRICTS, type District,
  tickScenery, lightState, drawTerrainDecor, pushScenery, drawQueue, runItem, type QueueItem,
  TUFTS_MIN_ZOOM, TUFTS_MIN_PX, TREE_DETAIL_MIN_ZOOM,
} from "../src/canvas/scenery.js";

function mockCtx(): [CanvasRenderingContext2D, Record<string, number>] {
  const calls: Record<string, number> = {};
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get(_t, prop) {
      const key = String(prop);
      calls[key] = (calls[key] ?? 0) + 1;
      if (key === "createRadialGradient" || key === "createLinearGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "measureText") return () => ({ width: 10 });
      return typeof prop === "string" ? () => undefined : undefined;
    },
    set() { return true; },
  });
  return [ctx, calls];
}

function rectHit(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  m = 0,
): boolean {
  return a.x < b.x + b.w + m && a.x + a.w > b.x - m && a.y < b.y + b.h + m && a.y + a.h > b.y - m;
}

describe("scenery", () => {
  it("roads never overlap a building footprint", () => {
    for (const r of ROADS) {
      const road = { x: r.x1, y: r.y1, w: r.x2 - r.x1 + 1, h: r.y2 - r.y1 + 1 };
      for (const l of LOCATIONS) {
        expect(
          rectHit(road, { x: l.x, y: l.y, w: l.w, h: l.h }),
          `road ${r.x1},${r.y1} overlaps ${l.id}`,
        ).toBe(false);
      }
    }
  });

  it("generates forest, props and traffic lights", () => {
    expect(TREES.length).toBeGreaterThan(60);
    expect(TREES.length).toBeGreaterThanOrEqual(1023); // ≥2.5x the original baseline (409)
    expect(FORESTS.length).toBeGreaterThanOrEqual(9);
    // the forest must cover the whole world, not the corner it used to be boxed
    // into: at least one tree outside the old 210x128 grid in every quadrant
    for (const [name, tx, ty] of [
      ["north", 500, 200],
      ["south", 500, 600],
      ["east", 900, 500],
      ["west", 100, 500],
    ] as const) {
      const near = TREES.some((t) => Math.abs(t.x - tx * V) < 400 && Math.abs(t.y - ty * V) < 400);
      expect(near, `no trees in the ${name} of the 5x map`).toBe(true);
    }
    expect(TREES.some((t) => t.kind === "birch"), "birch trees should exist").toBe(true);
    // pine/bush only became reachable after the h2 rescale — keep all kinds alive
    for (const kind of ["oak", "pine", "bush", "birch"] as const) {
      expect(TREES.some((t) => t.kind === kind), `no ${kind} tree`).toBe(true);
    }

    // forest zones must not overlap each other
    for (let i = 0; i < FORESTS.length; i++) {
      for (let j = i + 1; j < FORESTS.length; j++) {
        const a = FORESTS[i]!, b = FORESTS[j]!;
        expect(
          rectHit(a, b),
          `${a.name} overlaps ${b.name}`,
        ).toBe(false);
      }
    }

    // Forest zones must not cover a building footprint or a road. This used to
    // exempt the four original corner forests, which crossed asphalt from the
    // start; the rebuild replaced every zone with one that sits inside a single
    // block of the street grid, so the exemption is gone and ALL of them are
    // road-checked. If a zone has to be exempted to pass, it has become a wood.
    for (const f of FORESTS) {
      for (const l of LOCATIONS) {
        expect(
          rectHit(f, { x: l.x, y: l.y, w: l.w, h: l.h }),
          `${f.name} overlaps building ${l.id}`,
        ).toBe(false);
      }
      for (const r of ROADS) {
        expect(
          rectHit(f, { x: r.x1, y: r.y1, w: r.x2 - r.x1 + 1, h: r.y2 - r.y1 + 1 }),
          `${f.name} overlaps a road`,
        ).toBe(false);
      }
    }
    expect(PROPS.length).toBeGreaterThan(30);
    // Traffic lights are derived from CORE_ROADS, so the count follows the size of
    // the town-centre grid. It was pinned at 10 when the core was eight streets;
    // an exact number now would only mean re-pinning it every time a block edge is
    // added. What matters is that the core grid has real junctions and that
    // signals stay a minority of all crossings.
    expect(LIGHTS.length).toBeGreaterThan(20);
    let crossings = 0;
    for (let i = 0; i < ROADS.length; i++) {
      for (let j = i + 1; j < ROADS.length; j++) {
        const a = ROADS[i]!, b = ROADS[j]!;
        if (rectHit(
          { x: a.x1, y: a.y1, w: a.x2 - a.x1 + 1, h: a.y2 - a.y1 + 1 },
          { x: b.x1, y: b.y1, w: b.x2 - b.x1 + 1, h: b.y2 - b.y1 + 1 },
        )) crossings++;
      }
    }
    expect(LIGHTS.length, "signalled share of all crossings").toBeLessThan(crossings / 2);
  });

  it("the 16 buildings never overlap another footprint", () => {
    // pairwise-old overlaps are pre-existing by design (square/board, pond/dock),
    // so only the appended buildings are checked against the whole catalog.
    const NEW_IDS = ["stables", "granary", "warehouse", "chapel", "inn", "smithy", "farmhouse", "theatre", "depot", "garage", "tower", "arcade", "forge", "lodge", "observatory", "exchange"];
    for (const id of NEW_IDS) {
      const b = LOCATIONS.find((l) => l.id === id);
      expect(b, `missing building ${id}`).toBeDefined();
      for (const l of LOCATIONS) {
        if (l.id === id) continue;
        expect(
          rectHit({ x: b!.x, y: b!.y, w: b!.w, h: b!.h }, { x: l.x, y: l.y, w: l.w, h: l.h }),
          `${id} overlaps ${l.id}`,
        ).toBe(false);
      }
      // arrival spot sits on the row right below the footprint
      expect(b!.spot[1], `${id} spot not below footprint`).toBe(b!.y + b!.h + 1);
      expect(["Food", "Water"], `${id} must not be Food/Water (renders as field)`).not.toContain(b!.category);
    }
  });

  it("no tree sits on a road or building", () => {
    // Blocked tiles are baked once into a Set. This test was a nested loop over
    // every tree against every location and every road, which was fine at 409
    // trees and took 45 seconds at the ~20k the 5x map produces — 2.5M rect
    // comparisons. The invariant is per-tile, so the tiles are the right shape
    // for it. `blk` is the expected reason a tree was placed illegally.
    const blocked = new Map<string, string>();
    for (const l of LOCATIONS) {
      for (let y = l.y - 1; y < l.y + l.h + 1; y++) {
        for (let x = l.x - 1; x < l.x + l.w + 1; x++) blocked.set(`${x},${y}`, l.id);
      }
    }
    for (const r of ROADS) {
      for (let y = r.y1 - 1; y <= r.y2 + 1; y++) {
        for (let x = r.x1 - 1; x <= r.x2 + 1; x++) blocked.set(`${x},${y}`, `road ${r.x1},${r.y1}`);
      }
    }
    for (const t of TREES) {
      const tileX = Math.floor(t.x / V);
      const tileY = Math.floor((t.y - 14) / V);
      const why = blocked.get(`${tileX},${tileY}`);
      expect(why, `tree at ${tileX},${tileY} is on ${why}`).toBeUndefined();
    }
  });

  it("the forest and the road network cover the whole 5x map", () => {
    // A census rather than a screenshot. Growing the map 5x per axis left the
    // scenery pinned to the old grid: the forest loop ran `gx < 209, gy < 127`,
    // so 96% of the world was bare grass and the roads stopped at the town wall.
    // These are the numbers a regenerate must still produce, per quadrant, so a
    // district cannot quietly come back empty.
    // tree coordinates are world px, so the split is against the world size
    const quadrant = (x: number, y: number) =>
      `${y < WorldHeight / 2 ? "N" : "S"}${x < WorldWidth / 2 ? "W" : "E"}`;
    const trees: Record<string, number> = { NW: 0, NE: 0, SW: 0, SE: 0 };
    for (const t of TREES) trees[quadrant(t.x, t.y)]! += 1;
    for (const [q, n] of Object.entries(trees)) {
      expect(n, `no trees in the ${q} quadrant`).toBeGreaterThan(200);
    }

    const forestArea = FORESTS.reduce((s, f) => s + f.w * f.h, 0);
    // The intent changed with the data. This used to demand the map stay a fifth
    // green, which is what the 30 wilderness zones produced; a city is not a
    // fifth wood. The zones are now parks, green belts and a cemetery, each one
    // inside a block of the street grid, and the band is 6-9%: enough green that
    // the town reads as built-with-gardens, not enough that it reads as a forest
    // with roads through it.
    expect(forestArea / (Pe * vt), "forest coverage band").toBeGreaterThan(0.06);
    expect(forestArea / (Pe * vt), "forest coverage band").toBeLessThan(0.09);

    // every road reaches inside the town, not just around the rim
    const reachesCore = ROADS.some((r) => r.x1 < 620 && r.x2 > 430 && r.y1 < 370 && r.y2 > 270);
    expect(reachesCore, "no road serves the town core").toBe(true);
    // and one road exists in each quarter of the world
    for (const [name, ok] of [
      ["north", ROADS.some((r) => r.y2 < 210)],
      ["south", ROADS.some((r) => r.y1 > 420)],
      ["west", ROADS.some((r) => r.x2 < 360)],
      ["east", ROADS.some((r) => r.x1 > 700)],
    ] as const) {
      expect(ok, `no road in the ${name} of the map`).toBe(true);
    }
  });

  it("district parcels enclose their buildings and never overlap", () => {
    // The districts sat on bare grass, so they read as a few huts in a field.
    // Each one now has a parcel: a tinted apron, a dashed boundary and a name.
    // These assertions pin what makes that legible rather than decorative — a
    // parcel that misses its own buildings or overlaps a neighbour is worse
    // than no parcel at all.
    const hit = (a: District, b: { x: number; y: number; w: number; h: number }) =>
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    // no two parcels overlap
    for (let i = 0; i < DISTRICTS.length; i++) {
      for (let j = i + 1; j < DISTRICTS.length; j++) {
        expect(
          hit(DISTRICTS[i]!, DISTRICTS[j]!),
          `${DISTRICTS[i]!.name} overlaps ${DISTRICTS[j]!.name}`,
        ).toBe(false);
      }
    }
    // every parcel contains enough buildings to be worth drawing. 3 is Ashen
    // Moor's real size (peat works, charcoal kiln, bog hut) — the smallest of
    // the nine — so anything under that means the parcel missed its district.
    for (const d of DISTRICTS) {
      const inside = LOCATIONS.filter((l) => hit(d, l));
      expect(inside.length, `parcel ${d.name} contains too few buildings`).toBeGreaterThanOrEqual(3);
    }
    // and every BUILT location sits inside exactly one parcel. This is the rule
    // that stops the map growing orphan buildings in the gaps between them.
    // Open ground (Food/Water — meadows, the pond, the river, the fen) is
    // deliberately exempt: a wheat field between two districts belongs to
    // neither, and that is what countryside is.
    const BUILT_LOCS = LOCATIONS.filter((l) => l.category !== "Food" && l.category !== "Water");
    for (const l of BUILT_LOCS) {
      const inside = DISTRICTS.filter((d) => hit(d, l));
      expect(inside.length, `building ${l.id} is in ${inside.length} parcels`).toBe(1);
    }
  });

  it("traffic light cycles green/yellow/red per axis", () => {
    expect(lightState(0, "h")).toBe("green");
    expect(lightState(0, "v")).toBe("red");
    expect(lightState(5.5, "h")).toBe("yellow");
    expect(lightState(7, "v")).toBe("green");
    expect(lightState(11.5, "v")).toBe("yellow");
    // never green on both axes at once
    for (let t = 0; t < 12; t += 0.1) {
      expect(lightState(t, "h") === "green" && lightState(t, "v") === "green").toBe(false);
    }
  });

  it("vehicles stay in the world and keep moving", () => {
    // A fixed fleet, sized for the frame budget rather than for the road count.
    // This used to be one unit per road per direction — 738, which was never
    // measured until it cost 851 us/frame.
    expect(VEHICLES.length).toBe(VEHICLE_COUNT);
    expect(VEHICLE_COUNT).toBe(150);
    const kinds = new Set(VEHICLES.map((v) => (v as unknown as { kind: string }).kind));
    for (const k of ["car", "bus", "truck", "taxi", "van", "pickup"] as const) {
      expect(kinds.has(k), `inventory missing ${k}`).toBe(true);
    }
    const before = VEHICLES.map((v) => ({ x: v.x, y: v.y }));
    for (let i = 0; i < 600; i++) tickScenery(1 / 30, i / 30);
    VEHICLES.forEach((v, i) => {
      expect(v.x).toBeGreaterThanOrEqual(0);
      expect(v.x).toBeLessThanOrEqual(WorldWidth);
      expect(v.y).toBeGreaterThanOrEqual(0);
      expect(v.y).toBeLessThanOrEqual(WorldHeight);
      const moved = Math.hypot(v.x - before[i]!.x, v.y - before[i]!.y);
      expect(moved, `vehicle ${i} never moved`).toBeGreaterThan(0);
    });
  });

  it("vehicles drive on road tiles (lane check)", () => {
    for (const v of VEHICLES) {
      const onSomeRoad = ROADS.some((r) => {
        const left = r.x1 * V + 5, right = (r.x2 + 1) * V - 5;
        const top = r.y1 * V + 5, bottom = (r.y2 + 1) * V - 5;
        return v.x >= left && v.x <= right && v.y >= top && v.y <= bottom;
      });
      expect(onSomeRoad, `vehicle at ${Math.round(v.x)},${Math.round(v.y)} off road`).toBe(true);
    }
  });

  it("draws terrain decor without a DOM canvas (smoke via mock ctx)", () => {
    const [ctx, calls] = mockCtx();
    const view = { l: 0, r: WorldWidth, t: 0, b: WorldHeight };
    expect(() => drawTerrainDecor(ctx, view, { isDark: false, night: 0, time: 0 })).not.toThrow();
    const total = Object.values(calls).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(100);
  });

  it("drops grass tufts below the zoom where they would be sub-pixel", () => {
    // The tuft LOD gate, locked. Measured motivation: a tuft is 4 world px and
    // at MIN_ZOOM it renders 0.22 screen px, while costing 29,557 path ops a
    // frame — 85% of everything the frame drew. So MIN_ZOOM has to sit below the
    // gate, or the optimisation never runs at the zoom the complaint came from.
    //
    // Asserted by comparing op counts either side of the threshold on a whole-
    // world view, so deleting the gate fails this instead of quietly costing
    // 29k ops a frame again.
    const wholeWorld = { l: 0, r: WorldWidth, t: 0, b: WorldHeight };
    const opsAt = (zoom: number): number => {
      const [ctx, calls] = mockCtx();
      drawTerrainDecor(ctx, { ...wholeWorld, zoom }, { isDark: false, night: 0, time: 0 });
      return Object.values(calls).reduce((a, b) => a + b, 0);
    };

    const below = opsAt(TUFTS_MIN_ZOOM * 0.5);
    const above = opsAt(TUFTS_MIN_ZOOM * 2);

    expect(above - below, "tufts are not dropped below the gate at all").toBeGreaterThan(1000);
    expect(MIN_ZOOM, "whole-town zoom sits above the tuft gate, so the gate never fires").toBeLessThan(
      TUFTS_MIN_ZOOM,
    );
    // The threshold is derived, not chosen: 0.5 screen px over a 4 world px tuft.
    expect(TUFTS_MIN_ZOOM).toBeCloseTo(TUFTS_MIN_PX / 4, 10);
  });

  it("draws one ellipse per tree below the detail threshold, not tiers", () => {
    // The tree LOD gate, locked. Two throttle commits both measured a 22x jump in
    // beginPath between zoom 0.109 and 0.219 - that was SCENERY_MIN_ZOOM (0.125)
    // turning full tree detail on across a third of the world. Drawing the full
    // three-tier form for every crown that small is what made that frame cost
    // more than the rest of the draw path put together.
    //
    // Asserted by how many sub-shapes the trees emit either side of the threshold,
    // so deleting the gate fails this instead of quietly re-making the 22x jump.
    const scope = { l: 0, r: WorldWidth, t: 0, b: WorldHeight };
    const shapes = (zoom: number): number => {
      const [ctx, calls] = mockCtx();
      const queue: QueueItem[] = [];
      const d = { isDark: false, night: 0, time: 0 };
      pushScenery(queue, ctx, { ...scope, zoom }, d);
      drawQueue(queue, ctx, d, zoom >= TREE_DETAIL_MIN_ZOOM, zoom);
      let shapes = 0;
      for (const [key, n] of Object.entries(calls)) {
        if (key === "beginPath" || key === "ellipse" || key === "arc" || key === "fill") shapes += n;
      }
      return shapes;
    };

    const below = shapes(TREE_DETAIL_MIN_ZOOM * 0.5);
    const above = shapes(TREE_DETAIL_MIN_ZOOM * 2);
    // Below the threshold the cheap form runs; above, full detail. If someone
    // deletes the gate the cheap column and the full column become equal.
    expect(below, "no cheap form is running below the threshold").toBeLessThan(above);
  });

  it("pushes traffic lights into the draw queue and renders 3 bulbs + pole", () => {
    const target = LIGHTS[0]!;
    const view = { l: target.x - 60, r: target.x + 60, t: target.y - 80, b: target.y + 60 };
    const [ctx, calls] = mockCtx();
    const queue: QueueItem[] = [];
    pushScenery(queue, ctx, view, { isDark: false, night: 0, time: 0 });
    expect(queue.length).toBeGreaterThan(0);

    // execute ONLY the item anchored at the traffic light's base y
    const lightItems = queue.filter((q) => Math.abs(q.y - target.y) < 0.01);
    expect(lightItems.length, "traffic light not pushed to queue").toBeGreaterThanOrEqual(1);
    const before = { ...(calls as Record<string, number>) };
    for (const item of lightItems) runItem(ctx, item, { isDark: false, night: 0, time: 0 }, true);
    const arcs = (calls["arc"] ?? 0) - (before["arc"] ?? 0);
    const rects = (calls["fillRect"] ?? 0) - (before["fillRect"] ?? 0);
    expect(arcs, "signal head should draw 3 bulbs (+glow rings)").toBeGreaterThanOrEqual(3);
    expect(rects, "signal head + v-indicator rects").toBeGreaterThanOrEqual(2);
  });

  it("pushes vehicles and trees near an intersection view", () => {
    const target = LIGHTS[0]!;
    const view = { l: target.x - 200, r: target.x + 200, t: target.y - 200, b: target.y + 200 };
    const [ctx] = mockCtx();
    const queue: QueueItem[] = [];
    const d = { isDark: true, night: 0.8, time: 5 };
    pushScenery(queue, ctx, view, d);
    expect(queue.length).toBeGreaterThanOrEqual(1);
    expect(() => drawQueue(queue, ctx, d, true, 1)).not.toThrow();
  });
});
