// Audit the local dev snapshot against the 5x map.
//
// The worry was that agents stored world coordinates from the old 210x128 grid
// and would now spawn off-map or inside a wall. Before rewriting anything,
// check whether that is actually true: does the snapshot store coordinates at
// all, and does every place id it references still exist?
import { readFileSync } from "node:fs";
import { LOCATIONS, LOCATION_BY_ID } from "../backend/src/locations.ts";

const snap = JSON.parse(readFileSync("data/town.json", "utf8"));
const ids = new Set(LOCATIONS.map((l) => l.id));

// --- 1. any coordinate-ish keys anywhere? ---
const COORD_KEYS = /^(x|y|tx|ty|tileX|tileY|pos|position|px|py|worldX|worldY|spot)$/;
const found = new Map();
let scanned = 0;
(function walk(node, path) {
  scanned++;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (COORD_KEYS.test(k) && typeof v === "number") {
        if (!found.has(k)) found.set(k, []);
        found.get(k).push({ path, v });
      }
      walk(v, path ? `${path}.${k}` : k);
    }
  }
})(snap, "");

console.log(`scanned ${scanned} nodes`);
console.log(`coordinate keys found: ${found.size === 0 ? "NONE" : [...found.keys()].join(", ")}`);
for (const [k, hits] of found) {
  const vals = hits.map((h) => h.v);
  console.log(`  ${k}: ${hits.length} occurrences, range ${Math.min(...vals)}..${Math.max(...vals)}`);
  console.log(`    e.g. ${hits[0].path} = ${hits[0].v}`);
}

// --- 2. does every referenced place id still exist? ---
const missing = new Map();
const bump = (id, where) => {
  if (typeof id === "string" && id && !ids.has(id)) {
    if (!missing.has(id)) missing.set(id, new Set());
    missing.get(id).add(where);
  }
};
for (const m of snap.herd ?? []) bump(m.mind?.doing?.place, "herd.mind.doing.place");
for (const c of snap.contests ?? []) bump(c.place, "contest.place");
for (const q of snap.quests ?? []) {
  bump(q.place, "quest.place");
  for (const s of q.steps ?? []) bump(s.place, "quest.step.place");
}
for (const e of snap.editions ?? []) bump(e.place, "edition.place");
for (const p of snap.projects ?? []) bump(p.place, "project.place");

console.log(`\nplace ids referenced but not in the map: ${missing.size}`);
for (const [id, wheres] of missing) console.log(`  ${id}  (${[...wheres].join(", ")})`);

// --- 3. which places are the herd actually standing in? ---
const byPlace = new Map();
for (const m of snap.herd ?? []) {
  const p = m.mind?.doing?.place ?? "(none)";
  byPlace.set(p, (byPlace.get(p) ?? 0) + 1);
}
const acts = new Map();
for (const m of snap.herd ?? []) {
  const a = m.mind?.doing?.act ?? "(none)";
  acts.set(a, (acts.get(a) ?? 0) + 1);
}
console.log(`\nherd by place (${byPlace.size} distinct):`);
for (const [p, n] of [...byPlace].sort((a, b) => b[1] - a[1])) {
  const known = LOCATION_BY_ID.has(p);
  console.log(`  ${String(n).padStart(3)}  ${known ? "ok " : "MISSING"}  ${p}`);
}
console.log(`\nherd by act: ${[...acts].map(([a, n]) => `${a}=${n}`).join(", ")}`);

const ok = found.size === 0 && missing.size === 0;
console.log(`\n${ok ? "OK — snapshot is map-independent, nothing to migrate" : "NEEDS MIGRATION"}`);
process.exit(ok ? 0 : 1);