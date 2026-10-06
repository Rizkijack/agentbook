// Regenerate the Acts and Places columns of the rules table in
// skills/npc-agent/SKILL.md from the code.
//
// The table is what a human reads; NPC_SKILLS is what the sim runs. They were
// maintained by hand and drifted the moment the map grew from 42 to 99
// locations — the test caught it, but only after the fact.
//
// Acts and Places are derived, so they are regenerated. The Trigger column is
// NOT: it is prose describing the `when` predicate, which no field in the code
// holds, so the existing wording is carried over row by row. Losing it would
// silently replace a human description with "undefined".
//
// shared/test/skills.test.ts still fails if either side is edited alone — this
// script removes the tedium, not the guard.
import { readFileSync, writeFileSync } from "node:fs";
import { NPC_SKILLS } from "../shared/dist/index.js";

const DOC = "skills/npc-agent/SKILL.md";
const src = readFileSync(DOC, "utf8");
const start = src.indexOf("| Priority | Skill id |");
const end = src.indexOf("\n\n## Workflow");
if (start < 0 || end < 0) throw new Error("could not find the rules table in SKILL.md");

// carry the existing Trigger prose across, keyed by rule id
const previous = new Map();
for (const line of src.slice(start, end).split("\n")) {
  const m = line.match(/^\|\s*\d+\s*\|\s*`([a-z0-9-]+)`\s*\|[^|]*\|\s*([^|]+?)\s*\|/);
  if (m) previous.set(m[1], m[2]);
}

const rows = NPC_SKILLS.map((r) => {
  const trigger = previous.get(r.id);
  if (!trigger) throw new Error(`no Trigger prose for rule "${r.id}" — add it to SKILL.md first`);
  const acts = r.acts.map((a) => `\`${a}\``).join(", ");
  const places = r.places.map((p) => `\`${p}\``).join(", ");
  return `| ${r.priority} | \`${r.id}\` | ${r.label} | ${trigger} | ${acts} | ${places} |`;
});

const header = [
  "| Priority | Skill id | Label | Trigger | Acts | Places |",
  "| ---: | --- | --- | --- | --- | --- |",
];

writeFileSync(DOC, src.slice(0, start) + [...header, ...rows].join("\n") + src.slice(end));
console.log(`SKILL.md: regenerated Acts/Places for ${NPC_SKILLS.length} rules, Trigger prose preserved`);