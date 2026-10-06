#!/usr/bin/env node
/**
 * Remove debugging-probe residents from the production town, safely.
 *
 * Why a script and not an HTTP endpoint: the town only ever grows, because
 * `mergeSnapshots` unions the herd on every save so two Vercel instances cannot
 * lose each other's residents. That union also means a resident dropped from the
 * stored row is merged straight back by the next save from an instance still
 * holding it in memory — so a deletion needs a tombstone, not just an edit.
 *
 * This calls the same `planRemoval` / `applyRemoval` / `pgLoad` / `pgSave` the
 * server does. In particular the write goes through `pgSave`, so it keeps the
 * advisory lock, the rev compare-and-swap and the merge — a hand-rolled write
 * here would be a second, untested path through the durability layer.
 *
 * It also leaves no endpoint behind. A delete route on a public app is permanent
 * attack surface for a job that happens once.
 *
 * Usage:
 *   node scripts/remove-residents.mjs --name FixProbe01852 --name Dbg01910
 *   node scripts/remove-residents.mjs --id lm6mbm7ld4
 *   ... add --apply to write. Without it, it is a dry run that changes nothing.
 *
 * DATABASE_URL comes from the environment, or from the file named by --env-file
 * (default: where `vercel env pull` was pointed).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { pgSql } from "../backend/dist/persist.js";
import { pgLoad, pgSave, planRemoval, applyRemoval } from "../backend/dist/pgstore.js";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));

const APPLY = flag("apply");
const REASON = opt("reason", "debug probe");
const ENV_FILE = opt("env-file", "C:/Users/USER/AppData/Local/Temp/opencode/prod.env");
const ids = all("id").filter(Boolean);
const names = all("name").filter(Boolean);

if (ids.length === 0 && names.length === 0) {
  console.error("nothing to do: pass --name <name> and/or --id <residentId>");
  process.exit(2);
}

// --- connection -------------------------------------------------------------
function loadEnv() {
  if (process.env.DATABASE_URL) return;
  if (!existsSync(ENV_FILE)) {
    console.error(`no DATABASE_URL in the environment, and no env file at ${ENV_FILE}`);
    console.error("pull one with: vercel env pull <file> --environment=production --yes");
    process.exit(2);
  }
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv();
const sql = pgSql();

// --- read -------------------------------------------------------------------
const snapshot = await pgLoad(sql);
if (!snapshot) {
  console.error("town_state is empty — is this the right database?");
  process.exit(2);
}
const herd = snapshot.herd ?? [];
const feed = snapshot.feed ?? [];
console.log(`herd=${herd.length} feed=${feed.length} agents=${(snapshot.agents ?? []).length}`);
console.log(`mode: ${APPLY ? "APPLY" : "DRY RUN (add --apply to write)"}\n`);

// --- resolve targets --------------------------------------------------------
const targets = new Set();
for (const n of names) {
  const hit = herd.find((r) => r.name === n || r.handle === n);
  if (hit) targets.add(hit.id);
  else console.log(`  ! no resident named "${n}" — skipped`);
}
for (const i of ids) {
  if (herd.some((r) => r.id === i)) targets.add(i);
  else console.log(`  ! no resident with id "${i}" — skipped`);
}
if (targets.size === 0) {
  console.log("\nnothing matched — no resident by that name or id.");
  process.exit(1);
}

// --- plan -------------------------------------------------------------------
const plans = [...targets].map((id) => planRemoval(snapshot, id));
for (const p of plans) {
  const w = p.wouldRemove;
  console.log(`${p.ok ? "OK   " : "BLOCK"} ${p.name}  (${p.id})`);
  console.log(`      resident=${w.resident}  posts=${w.posts}  agentRecords=[${w.agentRecords.join(", ")}]`);
  console.log(`      relationshipRefs=${w.relationshipRefs.length}  children=${w.children.length}  contests=${w.contestEntrances}  season=${w.seasonStandings}`);
  if (!p.ok) console.log(`      blocked by: ${p.blockedBy}`);
}
const ready = plans.filter((p) => p.ok);
const blocked = plans.filter((p) => !p.ok);
console.log(`\n${ready.length} removable, ${blocked.length} blocked`);

// --- backup, always, before anything is even considered ---------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `C:/Users/USER/AppData/Local/Temp/opencode/town-backup-${stamp}.json`;
writeFileSync(backup, JSON.stringify({ savedAt: stamp, snapshot }, null, 1));
console.log(`backup: ${backup}`);

if (!APPLY) {
  console.log("\ndry run — nothing written. Re-run with --apply to perform the removal.");
  process.exit(0);
}
if (ready.length === 0) {
  console.log("\nnothing is removable. Exiting without writing.");
  process.exit(1);
}

// --- apply ------------------------------------------------------------------
let next = snapshot;
for (const p of ready) next = applyRemoval(next, p, REASON);
await pgSave(sql, next);

// --- verify by reading back through the same loader -------------------------
const after = await pgLoad(sql);
const gone = ready.filter((p) => !(after.herd ?? []).some((r) => r.id === p.id));
const tombs = (after.tombstones ?? []).filter((t) => ready.some((p) => p.id === t.id));

console.log(`\nwritten and re-read. herd now ${(after.herd ?? []).length} (was ${herd.length}), feed now ${(after.feed ?? []).length} (was ${feed.length})`);
for (const p of ready) {
  const stillThere = (after.herd ?? []).some((r) => r.id === p.id);
  const tomb = tombs.some((t) => t.id === p.id);
  console.log(`  ${p.name}: stillInHerd=${stillThere}  tombstoned=${tomb}  ${stillThere ? "<-- RESURRECTED, investigate" : "removed"}`);
}
if (gone.length !== ready.length) {
  console.error("\nWARNING: not every target was removed. Do not trust this state.");
  process.exit(1);
}
console.log(`\nall ${gone.length} removed, each with a tombstone so a later save cannot bring them back.`);
console.log(`if you need to undo: restore the backup into town_state and bump rev.`);
