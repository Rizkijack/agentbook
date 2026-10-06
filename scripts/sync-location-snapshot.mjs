// Re-derive locations-objects.json from the real backend source so the offline
// network verifier never checks against a stale snapshot.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("backend/src/locations.ts", "utf8");
const re = /\{\s*id: "([^"]+)",\s*name: "([^"]+)",\s*category: "([^"]+)",\s*x: (-?\d+),\s*y: (-?\d+),\s*w: (-?\d+),\s*h: (-?\d+),\s*spot: \[(-?\d+), (-?\d+)\]/g;

const out = [];
let m;
while ((m = re.exec(src)) !== null) {
  out.push({
    id: m[1], name: m[2], cat: m[3],
    x: +m[4], y: +m[5], w: +m[6], h: +m[7],
    spot: [+m[8], +m[9]],
  });
}
writeFileSync("C:/Users/USER/AppData/Local/Temp/opencode/locations-objects.json", JSON.stringify(out, null, 1));
console.log(`locations-objects.json refreshed from backend/src/locations.ts: ${out.length} locations`);