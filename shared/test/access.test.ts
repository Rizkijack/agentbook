import { describe, it, expect } from "vitest";
import { accessSpurs, pruneDegenerate, type AccessSpur } from "../src/access.js";

// Access spurs are the driveways that join a building to its street. The
// property that matters is that every spur touches both ends - starts on
// carriageway, ends on a building - because the pavement bake grows from road
// tiles, so a spur floating in the grass paves nothing.

const R = (id: string, x: number, y: number, w: number, h: number, category = "Work") =>
  ({ id, x, y, w, h, category });

describe("accessSpurs", () => {
  it("gives a building beside a street no spur at all", () => {
    const roads = [{ x1: 10, y1: 10, x2: 10, y2: 20 }];
    // building's left edge is tile 12, road ends at x=10 -> already touching
    const spurs = accessSpurs(roads, [R("flush", 10, 12, 4, 4)]);
    expect(spurs).toHaveLength(0);
  });

  it("reaches a building set back from the street, and both ends land where they should", () => {
    const roads = [{ x1: 10, y1: 10, x2: 10, y2: 20 }];
    const [first] = accessSpurs(roads, [R("setback", 22, 14, 6, 6)]);
    // starts on the carriageway
    expect(first!.x1).toBe(10);
    // ends on the building's west face, not in its middle
    expect(first!.x2).toBe(22);
  });

  it("starts on carriageway, so a spur cannot orphan the network", () => {
    const roads = [
      { x1: 10, y1: 10, x2: 10, y2: 20 },
      { x1: 40, y1: 40, x2: 60, y2: 40 },
    ];
    const spurs = accessSpurs(roads, [R("a", 24, 15, 5, 5), R("b", 50, 50, 5, 5)]);
    const onRoad = new Set<string>();
    for (const s of roads)
      for (let y = Math.min(s.y1, s.y2); y <= Math.max(s.y1, s.y2); y++)
        for (let x = Math.min(s.x1, s.x2); x <= Math.max(s.x1, s.x2); x++) onRoad.add(`${x},${y}`);

    // Only the FIRST leg of each driveway leaves the carriageway; the second
    // leg runs from the turn to the building. Asserting every leg would be
    // asserting that driveways are one segment long, which they are not.
    // Map keyed on id, keeping only the FIRST leg seen for it: Map overwrites,
    // so building the map from every spur would hand back the second leg, which
    // by definition starts on the building rather than on the street.
    const firstLeg = new Map<string, AccessSpur>();
    for (const s of spurs) if (!firstLeg.has(s.building)) firstLeg.set(s.building, s);
    for (const [id, s] of firstLeg) {
      expect(`${id}:${onRoad.has(`${s.x1},${s.y1}`)}`).toBe(`${id}:true`);
    }
  });

  it("skips fields and water - a driveway to a wheat field is wrong", () => {
    const roads = [{ x1: 10, y1: 10, x2: 10, y2: 20 }];
    const spurs = accessSpurs(roads, [R("field", 30, 14, 8, 8, "Food"), R("pond", 31, 14, 8, 8, "Water")]);
    expect(spurs).toHaveLength(0);
  });

  it("leaves a building in open country alone rather than cutting a lane across it", () => {
    const roads = [{ x1: 10, y1: 10, x2: 10, y2: 20 }];
    const spurs = accessSpurs(roads, [R("faraway", 500, 400, 5, 5)]);
    expect(spurs).toHaveLength(0);
  });

  it("is deterministic - same inputs, same spurs, every time", () => {
    const roads = [{ x1: 10, y1: 10, x2: 10, y2: 20 }, { x1: 5, y1: 40, x2: 60, y2: 40 }];
    const locs = [R("a", 24, 15, 5, 5), R("b", 30, 60, 4, 4), R("c", 70, 20, 5, 5)];
    expect(accessSpurs(roads, locs)).toEqual(accessSpurs(roads, locs));
  });

  it("makes an L of two legs rather than one diagonal", () => {
    const roads = [{ x1: 10, y1: 10, x2: 10, y2: 20 }];
    const spurs = pruneDegenerate(accessSpurs(roads, [R("corner", 22, 30, 6, 6)]));
    expect(spurs.length).toBeGreaterThanOrEqual(1);
    for (const s of spurs) {
      // every leg is axis-aligned: one of the two deltas is zero
      expect(s.x1 === s.x2 || s.y1 === s.y2).toBe(true);
    }
  });

  it("drops the zero-length half of an L, which would mark one tile for nothing", () => {
    const roads = [{ x1: 10, y1: 10, x2: 10, y2: 20 }];
    // aligned in y with the road's midpoint, so one leg collapses
    const spurs = pruneDegenerate(accessSpurs(roads, [R("aligned", 22, 14, 6, 6)]));
    for (const s of spurs) expect(s.x1 !== s.x2 || s.y1 !== s.y2).toBe(true);
  });

  it("sends the spur to the face the approach comes from", () => {
    // road at x=35, building spans x 20..25 -> 10 tiles, inside the gap
    const roads = [{ x1: 35, y1: 10, x2: 35, y2: 30 }];
    const spurs: AccessSpur[] = accessSpurs(roads, [R("west", 20, 14, 6, 6)]);
    expect(spurs.length).toBeGreaterThan(0);
    const last = spurs[spurs.length - 1]!;
    // arriving from x=35 means the east face, x=25, not the middle
    expect(last.x2).toBe(25);
  });
});