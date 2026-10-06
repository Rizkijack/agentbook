// Emit the canonical location list for the test whitelist, straight from the
// code. Hand-maintaining a second copy is how the 42-location list went stale in
// the first place.
import { writeFileSync } from "node:fs";
import { NPC_ALL_PLACES } from "../shared/dist/index.js";

const ids = [...NPC_ALL_PLACES];
console.log("NPC_ALL_PLACES:", ids.length);

const lines = [];
let cur = "";
for (const id of ids) {
  const tok = `"${id}", `;
  if ((cur + tok).length > 92) {
    lines.push(cur.trimEnd());
    cur = "";
  }
  cur += tok;
}
if (cur.trim()) lines.push(cur.trimEnd().replace(/,$/, ""));

const body = lines.map((l) => "  " + l).join("\n");
writeFileSync(
  "C:/Users/USER/AppData/Local/Temp/opencode/canonical.txt",
  `const CANONICAL_99 = [\n${body}\n];`,
);
console.log("written canonical.txt");