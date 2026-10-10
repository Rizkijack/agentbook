// Emit the road / forest / route data blocks for shared/src/map.ts and
// frontend/src/canvas/scenery.ts from shared/src/mapdata.ts, so no coordinate is
// ever transcribed by hand and every emitted block has a source you can read.
//
// This script verifies the whole network against the real location table before
// it writes anything: shared/src/netcheck.ts walks the road graph on the same
// 1-tile-expanded tile mask scenery.ts bakes into BLOCKED, and fails the run on
// an orphan segment, an out-of-bounds segment, a road across a building, or a
// location no road can reach. shared/test/road-network.test.ts asserts the same
// invariants (plus per-district route redundancy), so the claim is enforced in
// two places rather than repeated in three comments.
//
// INPUT is repository-local. This script used to read a scratch verifier from
// the OS temp directory and pull the arrays back out with a `new Function`
// evaluation of whatever literals it found between the brackets. That scratch
// file is gone, so the generator threw ENOENT and regeneration had been dead
// ever since; the only surviving copies of the network were the blocks below.
// It now imports the tables directly, which is the whole fix.
import { readFileSync, writeFileSync } from "node:fs";

import { ROAD_SEGMENTS, FOREST_ZONES, DISTRICT_PARCELS, GROVE_SPECS } from "../shared/src/mapdata.ts";
import { Pe, vt } from "../shared/src/map.ts";
import { LOCATIONS } from "../backend/src/locations.ts";
import { checkNetwork, walkReachable, reachFromBox, adjacency, edgeDisjointTo } from "../shared/src/netcheck.ts";
import { accessSpurs, pruneDegenerate } from "../shared/src/access.ts";

// The old generator evaluated the scratch file's arrays through
// `new Function("DX", "DY", ...)(419, 253)`. Those two constants were a one-off
// translation applied when 42 locations were moved into the 5x map, and the
// numbers now in mapdata.ts already have it applied — they are the values as
// emitted. The knob is gone on purpose: feeding 419/253 in again would shift the
// entire network off the map. mapdata.ts carries the same note.

// The derivation below still speaks in the tuple shape the old scratch file
// used, so the route/lamps maths is unchanged from the last good emission.
const ROADS = ROAD_SEGMENTS.map((s) => [s.name, s.x1, s.y1, s.x2, s.y2, s.core]);
const FORESTS = FOREST_ZONES.map((z) => [z.name, z.x, z.y, z.w, z.h]);
const CORE = ROADS.filter((r) => r[5]);

const isH = (r) => (r[3] - r[1]) >= (r[4] - r[2]);
const roadLen = (r) => Math.max(r[3] - r[1], r[4] - r[2]);


// --- street lamps: only the roads short enough to light ---------------------
const LAMPS = [];
const LAMP_MAX = 200;
for (const [, x1, y1, x2, y2] of ROADS) {
  if (roadLen([0, x1, y1, x2, y2]) > LAMP_MAX) continue;
  if (isH([0, x1, y1, x2, y2])) {
    for (let x = x1 + 6; x <= x2 - 6; x += 16) {
      LAMPS.push([x, y1, "n"]);   // north sidewalk
      LAMPS.push([x, y2, "s"]);   // south sidewalk
    }
  } else {
    for (let y = y1 + 6; y <= y2 - 6; y += 16) {
      LAMPS.push([x1, y, "w"]);   // west sidewalk
      LAMPS.push([x2, y, "e"]);   // east sidewalk
    }
  }
}

const out = [];

const roadsBlock = [];
roadsBlock.push("export const ROADS: RoadRect[] = [");
for (const [name, x1, y1, x2, y2] of ROADS) {
  roadsBlock.push(`  { x1: ${x1}, y1: ${y1}, x2: ${x2}, y2: ${y2} }, // ${name}`);
}
roadsBlock.push("];");
out.push(["roads", roadsBlock.join("\n")]);

// --- access spurs: driveways from a building to its nearest carriageway -------
// 41 of the 87 built locations do not front a major street, some up to 30 tiles
// from tarmac, and PAVED grows from road tiles — so those buildings sat alone on
// grass. Derived rather than hand-authored: pure, deterministic, and each spur
// starts on a road tile so it inherits the connectivity the gate below proves.
const SPURS = pruneDegenerate(
  accessSpurs(
    ROAD_SEGMENTS.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
    LOCATIONS,
  ),
);
const spurBlock = ["export const ACCESS_SPURS: RoadRect[] = ["];
for (const s of SPURS) {
  spurBlock.push(`  { x1: ${s.x1}, y1: ${s.y1}, x2: ${s.x2}, y2: ${s.y2} }, // ${s.building}`);
}
spurBlock.push("];");
out.push(["access-spurs", spurBlock.join("\n")]);

const coreBlock = ["export const CORE_ROADS: RoadRect[] = ["];
for (const [name, x1, y1, x2, y2] of CORE) {
  coreBlock.push(`  { x1: ${x1}, y1: ${y1}, x2: ${x2}, y2: ${y2} }, // ${name}`);
}
coreBlock.push("];");
out.push(["core-roads", coreBlock.join("\n")]);

// --- grove placement ---------------------------------------------------------
// Every district parcel is owed a small wood, so the new housing density reads as
// "town among trees" rather than "town in a field". The position is computed, not
// written by hand: a grove tile is never paved (PAVED skips inForest), so a grove
// drawn over a building silently deletes that building's pavement apron and
// strands it from the street. Seven were stranded by hand-placed groves. These
// are placed on ground that is provably clear of every location and road.
const groveOverlapsSomething = (x, y, w, h, placed) => {
  const hits = (r, m) => x + w + m > r.x && x - m < r.x + r.w && y + h + m > r.y && y - m < r.y + r.h;
  if (LOCATIONS.some((l) => hits(l, GROVE_CLEARANCE))) return true;
  if (placed.some((r) => hits(r, 2))) return true;
  // Rect form, matching scenery.test.ts exactly. The narrower "x < x2" test let
// every vertical road through: those segments have x2 === x1, so `x < x2` could
// never be true and a grove parked on one sailed straight through.
  if (ROAD_SEGMENTS.some((s) => {
    const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
    const y1 = Math.min(s.y1, s.y2), y2 = Math.max(s.y1, s.y2);
    return x + w > x1 && x < x2 + 1 && y + h > y1 && y < y2 + 1;
  })) return true;
  return false;
};

// Clearance from a named building, in tiles. Two is the floor that keeps the
// invariant scenery-paving.test.ts asserts: a grove must not cover the building
// or its one-tile border, or the building loses every paved tile it touched and
// strands from the street. Larger values starve the dense parcels - at 9, seven
// of the nine had nowhere legal left to go.
const GROVE_CLEARANCE = 2;

const placedGroves = [];
const unplacedGroves = [];
for (const spec of GROVE_SPECS) {
  const p = DISTRICT_PARCELS.find((d) => d.name === spec.parcel);
  if (!p) { unplacedGroves.push(`${spec.name}: no parcel "${spec.parcel}"`); continue; }
  let best = null;
  let bestScore = Infinity;
  // scan every position in the parcel; prefer the one furthest from built ground,
  // ties broken deterministically by position so the map never wobbles between runs
  for (let y = p.y + 1; y + spec.h <= p.y + p.h - 1; y++) {
    for (let x = p.x + 1; x + spec.w <= p.x + p.w - 1; x++) {
      if (groveOverlapsSomething(x, y, spec.w, spec.h, placedGroves)) continue;
      let nearest = Infinity;
      for (const l of LOCATIONS) {
        const dx = Math.max(l.x - (x + spec.w), x - (l.x + l.w), 0);
        const dy = Math.max(l.y - (y + spec.h), y - (l.y + l.h), 0);
        nearest = Math.min(nearest, dx * dx + dy * dy);
      }
      if (nearest < bestScore) { bestScore = nearest; best = { x, y }; }
    }
  }
  if (!best) { unplacedGroves.push(`${spec.name}: no clear ground in ${spec.parcel}`); continue; }
  placedGroves.push({ x: best.x, y: best.y, w: spec.w, h: spec.h, name: spec.name });
}
if (unplacedGroves.length) {
  console.error("refusing to emit: a parcel grove has nowhere legal to go");
  for (const g of unplacedGroves) console.error(`  ${g}`);
  process.exit(1);
}
FORESTS.push(...placedGroves.map((g) => [g.name, g.x, g.y, g.w, g.h]));
console.log(`groves   ${placedGroves.length} placed, one per parcel`);

// built after the groves land in FORESTS, or they never reach the emitted block
const forestBlock = ["export const FORESTS = ["];
for (const [name, x, y, w, h] of FORESTS) {
  forestBlock.push(`  { x: ${x}, y: ${y}, w: ${w}, h: ${h}, name: ${JSON.stringify(name)} },`);
}
forestBlock.push("];");
out.push(["forests", forestBlock.join("\n")]);

const lampBlock = ['const LAMPS: Array<[number, number, "n" | "s" | "w" | "e"]> = ['];
for (const [a, b, side] of LAMPS) lampBlock.push(`  [${a}, ${b}, ${JSON.stringify(side)}],`);
lampBlock.push("];");
out.push(["lamps", lampBlock.join("\n")]);

// --- decorative housing --------------------------------------------------------
// The 100 named locations are buildings an agent can walk into, and adding more
// of them would mean more places to visit and a broken count assertion in
// world.test.ts. What the map actually lacked was built *texture*: measured over
// the nine district parcels, the named buildings covered 7.3% of the land they
// sit on. So housing here is scenery - solid to pathfinding, paved, drawn, and
// never a destination.
//
// Spread over the whole of every parcel on a fixed slot grid rather than seeded
// around the named buildings, which is what made the town read as one dense core
// with nothing anywhere else. Each slot is dropped if it would touch a road, a
// named location, a grove, or a house already placed.
const HOME_SLOT_W = 9;
const HOME_SLOT_H = 8;
const HOME_MARGIN = 1;

// Corner tests are not enough here. A vertical segment has x2 === x1, so probing
// only (x,y) and (x+w,y+h) walks straight past a street running down the middle of
// a house. Rect overlap, widened by the margin.
const isRoad = (x, y, w, h, m) =>
  ROAD_SEGMENTS.some((s) => {
    const x1 = Math.min(s.x1, s.x2), x2 = Math.max(s.x1, s.x2);
    const y1 = Math.min(s.y1, s.y2), y2 = Math.max(s.y1, s.y2);
    return x + w + m > x1 && x - m < x2 + 1 && y + h + m > y1 && y - m < y2 + 1;
  });
const hits = (x, y, w, h, list, m) =>
  list.some((r) => x + w + m > r.x && x - m < r.x + r.w && y + h + m > r.y && y - m < r.y + r.h);
const inGrove = (x, y, w, h) =>
  hits(x, y, w, h, FOREST_ZONES.filter((z) => z.name.endsWith("Grove")), 0);

// Deterministic: same input, same town. A hash, not Math.random.
const jitter = (a, b, salt) => {
  const s = Math.sin(a * 127.1 + b * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

const homes = [];
for (const p of DISTRICT_PARCELS) {
  for (let gy = p.y + 1; gy + 4 < p.y + p.h; gy += HOME_SLOT_H) {
    for (let gx = p.x + 1; gx + 5 < p.x + p.w; gx += HOME_SLOT_W) {
      const jx = jitter(gx, gy, 1);
      const jy = jitter(gx, gy, 2);
      const x = gx + Math.floor(jx * 3);
      const y = gy + Math.floor(jy * 3);
      // 4x3, 5x3 or 5x4 - small enough to read as housing, varied so the parcel
      // does not turn into one repeated stamp
      const w = 4 + Math.floor(jitter(gx, gy, 3) * 2);
      const h = 3 + Math.floor(jitter(gx, gy, 4) * 2);
      if (x + w > p.x + p.w - 1 || y + h > p.y + p.h - 1) continue;
      if (isRoad(x, y, w, h, HOME_MARGIN)) continue;
      if (hits(x, y, w, h, LOCATIONS, HOME_MARGIN + 1)) continue;
      if (inGrove(x, y, w, h)) continue;
      if (hits(x, y, w, h, homes, HOME_MARGIN)) continue;
      homes.push({ x, y, w, h });
    }
  }
}

const homeBlock = ["export const HOMES: readonly Home[] = ["];
for (const b of homes) homeBlock.push(`  { x: ${b.x}, y: ${b.y}, w: ${b.w}, h: ${b.h} },`);
homeBlock.push("];");
out.push(["homes", homeBlock.join("\n")]);
console.log(`homes    ${homes.length} across ${DISTRICT_PARCELS.length} parcels`);
// --- gate: the network must be a network -------------------------------------
// Everything below this line writes files, so the checks run first. checkNetwork
// returns every failure it finds rather than throwing on the first one: fixing a
// map one error per run is miserable.
const CORE_BOX = { x: 415, y: 195, w: 255, h: 275 };
const FOOTPRINTS = LOCATIONS.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, h: l.h }));
const failures = checkNetwork({
  roads: ROAD_SEGMENTS.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
  names: ROAD_SEGMENTS.map((s) => s.name),
  core: CORE_BOX,
  locations: FOOTPRINTS,
  worldW: Pe,
  worldH: vt,
});
if (failures.length) {
  console.error(`\nrefusing to emit: ${failures.length} network failure(s)`);
  for (const f of failures) console.error(`  [${f.rule}] ${f.detail}`);
  process.exit(1);
}

// Reported, not enforced: how many buildings have a carriageway beside them
// rather than only a footpath. The town-centre parcel is packed tight enough that
// this cannot reach 100 — the pre-5x network managed 14 of 100.
const { noFrontage, nested } = walkReachable({
  roads: ROAD_SEGMENTS.map((s) => ({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 })),
  locations: FOOTPRINTS,
  core: CORE_BOX,
  worldW: Pe,
  worldH: vt,
});

// --- splice into the generated blocks ---------------------------------------
const TARGETS = {
  roads: "shared/src/map.ts",
  "core-roads": "shared/src/map.ts",
  "access-spurs": "shared/src/map.ts",
  forests: "frontend/src/canvas/scenery.ts",
  lamps: "frontend/src/canvas/scenery.ts",
  homes: "frontend/src/canvas/scenery.ts",
};

const files = new Map();
for (const [name, body] of out) {
  const target = TARGETS[name];
  let file = files.get(target) ?? readFileSync(target, "utf8");
  const open = `// @generated:${name}`;
  const close = `// @end:${name}`;
  const a = file.indexOf(open);
  const b = file.indexOf(close);
  if (a < 0 || b < 0) throw new Error(`missing markers ${open} / ${close} in ${target}`);
  const next = file.slice(0, a + open.length) + "\n" + body + "\n" + file.slice(b);
  // Only write when the block actually changed, so a clean regeneration is a
  // clean `git diff` instead of a no-op rewrite.
  if (next !== file) {
    writeFileSync(target, next);
    console.log(`  updated ${open} in ${target}`);
  }
  files.set(target, next);
}
console.log(`checked ${out.length} generated blocks across ${files.size} files`);

// --- report -----------------------------------------------------------------
const lights = [];
const H = CORE.filter((r) => r[4] - r[2] < r[3] - r[1]);
const V = CORE.filter((r) => r[3] - r[1] <= r[4] - r[2]);
for (const h of H) {
  for (const v of V) {
    if (v[1] <= h[3] && v[3] >= h[1] && v[2] <= h[4] && v[4] >= h[2]) lights.push([v[1], h[2]]);
  }
}
console.log(`roads    ${ROADS.length} (${CORE.length} core)`);
console.log(`forests  ${FORESTS.length}`);
const SEGMENTS = ROADS.map((r) => ({ x1: r[1], y1: r[2], x2: r[3], y2: r[4] }));
const report = reachFromBox(SEGMENTS, CORE_BOX, Pe, vt);
console.log(`reachable ${report.reachable.size}/${SEGMENTS.length} segments, 0 orphans`);
const ADJ = adjacency(SEGMENTS, Pe, vt);
// "The core" for the redundancy question is the town-centre segment set — not the
// reachable set, which after criterion 4 is every segment on the map.
const coreSet = new Set(SEGMENTS.map((s, i) => i).filter((i) => {
  const s = SEGMENTS[i];
  return s.x1 >= CORE_BOX.x && s.x2 <= CORE_BOX.x + CORE_BOX.w &&
    s.y1 >= CORE_BOX.y && s.y2 <= CORE_BOX.y + CORE_BOX.h;
}));
const bridges = DISTRICT_PARCELS.map((d) => {
  const touching = SEGMENTS.map((s, i) => i).filter((i) =>
    SEGMENTS[i].x1 <= d.x + d.w && SEGMENTS[i].x2 >= d.x &&
    SEGMENTS[i].y1 <= d.y + d.h && SEGMENTS[i].y2 >= d.y);
  const isCore = touching.every((i) => coreSet.has(i));
  return [d.name, isCore ? "core" : String(edgeDisjointTo(SEGMENTS, ADJ, touching, coreSet))];
});
console.log(`frontage ${LOCATIONS.length - noFrontage.length - nested.length}/${LOCATIONS.length - nested.length} buildings have a road beside them (${nested.length} nested inside another footprint)`);
console.log(`districts ${bridges.map(([n, k]) => `${n}:${k}`).join("  ")}`);
console.log(`lamps    ${LAMPS.length}`);
console.log(`lights   ${lights.length} core intersections (of ${(() => {
  const h = ROADS.filter((r) => r[4] - r[2] < r[3] - r[1]);
  const v = ROADS.filter((r) => r[3] - r[1] <= r[4] - r[2]);
  let n = 0;
  for (const a of h) for (const b of v) if (b[1] <= a[3] && b[3] >= a[1] && b[2] <= a[4] && b[4] >= a[2]) n++;
  return n;
})()} total)`);
