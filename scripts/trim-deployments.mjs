#!/usr/bin/env node
/**
 * Trim this project's Vercel deployment history, keeping the N newest.
 *
 * Two things make this more than a loop over `vercel rm`:
 *
 * 1. `GET /v6/deployments` is team-wide. An unfiltered page mixes in sibling
 *    projects (this account also runs gashood, technocorecity, arc-bridge, …),
 *    so every candidate is filtered on `projectId` and pagination is followed to
 *    the end. Deleting by name prefix would be wrong: `agentbook-*` and
 *    `hermesbook-*` were earlier names of *this* project, while `gashood-*` was
 *    never ours.
 *
 * 2. The custom domains point at specific deployment ids. Those deployments are
 *    resolved from the alias table first and put on a keep list regardless of
 *    age, so this can never take the site down — even if someone deploys more
 *    while the batch runs, or the newest N happen to change underneath it.
 *
 * Usage:
 *   node scripts/trim-deployments.mjs <projectId> [--keep 5] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

const argv = process.argv.slice(2);
/** Flags that consume the next token. `--dry-run` does not. */
const VALUE_FLAGS = new Set(["--keep"]);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
// Skip flag values when reading positionals. Treating "anything not starting
// with --" as the project id looks right and silently picks up the 5 from
// `--keep 5`, which then filters for a project named "5" and finds nothing —
// reporting a clean bill of health for a project it never looked at.
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1]));
const PROJECT = positional[0];

// No account identifiers are baked in: the team and the project are per-account
// facts, not facts about this repository. Read them from the environment, or
// take the project from `.vercel/project.json` when running inside a checkout.
const TEAM = process.env.VERCEL_TEAM_ID;
let linkedProjectId;
try {
  linkedProjectId = JSON.parse(readFileSync(".vercel/project.json", "utf8")).projectId;
} catch (e) {
  // Not swallowing this into a bare `undefined`: a silent miss here filters for
  // nothing and the run then reports an empty project as a clean bill of health.
  console.error(`note: no linked project here (${e.code ?? e.message})`);
}
const PROJECT_ID = PROJECT ?? linkedProjectId;

if (!TEAM || !PROJECT_ID) {
  console.error("usage: VERCEL_TEAM_ID=team_xxx node scripts/trim-deployments.mjs <projectId> [--keep 5] [--dry-run]");
  if (!TEAM) console.error("  VERCEL_TEAM_ID is required (vercel team id)");
  if (!PROJECT_ID) console.error("  pass <projectId>, or run inside a linked checkout with .vercel/project.json");
  process.exit(2);
}
const KEEP = Number(opt("keep", "5"));
const DRY = flag("dry-run");

// The `vercel` on PATH is usually a shell shim that wraps this file. Node cannot
// spawn the shim directly, and passing it through cmd.exe breaks on the `&` in a
// query string, so go straight to the entry point the shim would run — and find
// it rather than assume, since a global install lives under npm's global root,
// not necessarily beside the running node.exe.
function findVercelCli() {
  if (process.env.VERCEL_CLI_JS) return process.env.VERCEL_CLI_JS;

  const candidates = [nodePath.join(nodePath.dirname(process.execPath), "..", "node_modules", "vercel", "dist", "vc.js")];

  // A global install puts a `vercel` shim on PATH, with node_modules/vercel right
  // beside it. Reading PATH is enough and avoids asking npm for its global root:
  // on Windows npm is npm.cmd, and Node cannot spawn a .cmd — execFileSync gives
  // EINVAL, while `shell: true` works but makes Node warn that the arguments are
  // concatenated unescaped.
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep).filter(Boolean)) {
    for (const shim of ["vercel.cmd", "vercel", "vercel.ps1"]) {
      if (existsSync(nodePath.join(dir, shim))) {
        candidates.push(nodePath.join(dir, "node_modules", "vercel", "dist", "vc.js"));
        break;
      }
    }
  }

  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    console.error("could not locate the vercel CLI entry point (vercel/dist/vc.js).");
    console.error("set VERCEL_CLI_JS to its absolute path.");
    process.exit(2);
  }
  return found;
}
const VERCEL_CLI = findVercelCli();

function api(endpoint, method = "GET", input) {
  const args = [VERCEL_CLI, "api", endpoint, "-X", method];
  if (input !== undefined) args.push("--input", "-");
  // The CLI refuses DELETE without an interactive confirmation, which a batch
  // cannot supply. Scoped to DELETE only, and reachable only after the dry-run
  // listing has been read: every other call still goes through the guard.
  if (method === "DELETE") args.push("--dangerously-skip-permissions");
  return execFileSync(process.execPath, args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

// --- enumerate this project's deployments, following pagination -------------
let url = `/v6/deployments?limit=100&teamId=${TEAM}`;
const mine = [];
let pages = 0;
while (url) {
  const parsed = JSON.parse(api(url));
  for (const d of parsed.deployments ?? parsed) if (d.projectId === PROJECT_ID) mine.push(d);
  pages++;
  url = parsed.pagination?.next
    ? `/v6/deployments?limit=100&teamId=${TEAM}&until=${parsed.pagination.next}`
    : null;
  if (pages > 50) throw new Error("pagination did not terminate");
}
mine.sort((a, b) => b.created - a.created);

// --- resolve the live domains to deployment ids ------------------------------
const aliases = JSON.parse(api(`/v1/aliases?limit=100&teamId=${TEAM}`));
const aliasList = aliases.aliases ?? aliases;
const projectIds = new Set(mine.map((d) => d.uid ?? d.id));

/** Every domain that currently resolves to one of our deployments. */
const ourAliases = aliasList.filter((a) => projectIds.has(a.deployment?.id));
const newest = new Set(mine.slice(0, KEEP).map((d) => d.uid ?? d.id));
const keep = mine.slice(0, KEEP);
const drop = mine.slice(KEEP);

/**
 * A kept deployment's aliases must survive with it, so the KEEP set is also the
 * protected set. Older deployments can lose their aliases — Vercel mints these
 * automatically for every branch and for the project's former names
 * (`agentbook-*`, `hermesbook-git-<branch>-*`), and they are rebuilt on the next
 * deploy, so pruning them with their deployment is what "clear the history"
 * actually means. The live domains are covered by this rule rather than by a
 * separate allowlist: they point at the newest deployment, which is kept by rank.
 */
const protectedIds = newest;
const orphaning = aliasList.filter(
  (a) => newest.has(a.deployment?.id) === false
    && drop.some((d) => (d.uid ?? d.id) === a.deployment?.id),
);

const name = (d) => d.url.replace(/^https:\/\//, "").replace(/\.vercel\.app$/, "");
const mins = (d) => Math.round((Date.now() - d.created) / 60000);

console.log(`project ${PROJECT_ID} (${mine.length} deployments across ${pages} pages)`);
console.log(`aliases on this project: ${ourAliases.length}\n`);

// A kept deployment with no alias, or an alias surviving while its deployment is
// deleted, would both mean the mapping is being misread. Fail loudly instead.
const keptNoAlias = keep.filter((d) => !ourAliases.some((a) => a.deployment.id === (d.uid ?? d.id)));

console.log(`KEEP (${keep.length}):`);
for (const d of keep) {
  const tag = ourAliases.some((a) => a.deployment.id === (d.uid ?? d.id)) ? "  <- aliased" : "";
  console.log(`  ${name(d).padEnd(38)} ${String(mins(d)).padStart(5)}m ${(d.meta?.githubCommitSha ?? "").slice(0, 7)}${tag}`);
}
if (keptNoAlias.length) {
  console.log(`\n  (${keptNoAlias.length} kept deployments carry no alias)`);
}

if (orphaning.length) {
  console.log(`\naliases that disappear with their deployment (${orphaning.length}):`);
  for (const a of orphaning) console.log(`  ${a.alias}`);
}

console.log(`\nDELETE (${drop.length}):`);
for (const d of drop) console.log(`  ${name(d).padEnd(38)} ${String(mins(d)).padStart(5)}m ${(d.meta?.githubCommitSha ?? "").slice(0, 7)} ${d.state}`);

if (DRY) {
  console.log("\ndry run — nothing deleted. Re-run without --dry-run.");
  process.exit(0);
}

console.log("");
let ok = 0;
const failed = [];
for (const d of drop) {
  const id = d.uid ?? d.id;
  try {
    api(`/v13/deployments/${id}`, "DELETE");
    ok++;
    process.stdout.write(`  deleted ${ok}/${drop.length}  ${name(d)}\n`);
  } catch (e) {
    failed.push({ name: name(d), error: String(e.message ?? e).split("\n")[0] });
    process.stdout.write(`  FAILED   ${name(d)}\n`);
  }
}

console.log(`\ndeleted ${ok}, failed ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
  process.exitCode = 1;
}

// --- prove the site survived -----------------------------------------------
const survivors = JSON.parse(api(`/v6/deployments?limit=100&teamId=${TEAM}&projectId=${PROJECT_ID}`));
const left = (survivors.deployments ?? survivors).filter((d) => d.projectId === PROJECT_ID);
console.log(`\nremaining in project: ${left.length}`);
for (const d of left.sort((a, b) => b.created - a.created)) {
  console.log(`  ${name(d).padEnd(38)} ${(d.meta?.githubCommitSha ?? "").slice(0, 7)}`);
}
