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

import { ROAD_SEGMENTS, FOREST_ZONES, DISTRICT_PARCELS } from "../shared/src/mapdata.ts";
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
