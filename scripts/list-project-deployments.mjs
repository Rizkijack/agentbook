#!/usr/bin/env node
/**
 * Enumerate every deployment belonging to THIS project only.
 *
 * `GET /v6/deployments` is team-wide, not project-scoped: an unfiltered page
 * mixes in a sibling project (prj_4A9in6Aq…) that must not be touched. So the
 * filter is on `projectId`, applied per page, and pagination is followed to the
 * end rather than trusting the first 100 rows.
 *
 * Prints a JSON list on stdout; deletes nothing.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";

// No account identifiers are baked in: the team and the project are per-account
// facts, not facts about this repository. Read them from the environment, or
// take the project from `.vercel/project.json` when running inside a checkout.
const TEAM = process.env.VERCEL_TEAM_ID;
let linkedProjectId;
try {
  linkedProjectId = JSON.parse(readFileSync(".vercel/project.json", "utf8")).projectId;
} catch (e) {
  console.error(`note: no linked project here (${e.code ?? e.message})`);
}
const PROJECT = process.argv[2] ?? linkedProjectId;

if (!TEAM || !PROJECT) {
  console.error("usage: VERCEL_TEAM_ID=team_xxx node scripts/list-project-deployments.mjs <projectId>");
  if (!TEAM) console.error("  VERCEL_TEAM_ID is required (vercel team id)");
  if (!PROJECT) console.error("  pass <projectId>, or run inside a linked checkout with .vercel/project.json");
  process.exit(2);
}

// The `vercel` on PATH is a shim (.ps1 / .cmd) that ends up running
// `node .../vercel/dist/vc.js`. Node cannot spawn the .ps1 (ENOENT), and going
// through cmd.exe to reach the .cmd breaks on the `&` in a query string — cmd
// reads it as a command separator. So we run the CLI's real entry point with
// node directly, and find it rather than assume: a global install lives under
// npm's global root, which is not necessarily next to the running node.exe.
function findVercelCli() {
  if (process.env.VERCEL_CLI_JS) return process.env.VERCEL_CLI_JS;

  const candidates = [nodePath.join(nodePath.dirname(process.execPath), "..", "node_modules", "vercel", "dist", "vc.js")];

  // A global install puts a `vercel` shim on PATH, with node_modules/vercel right
  // beside it. Finding that shim by reading PATH is enough and avoids asking npm
  // for its global root: on Windows npm is npm.cmd, and Node cannot spawn a .cmd
  // — execFileSync gives EINVAL, while `shell: true` works but makes Node warn
  // that the arguments are concatenated unescaped.
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep).filter(Boolean)) {
    for (const shim of ["vercel.cmd", "vercel", "vercel.ps1"]) {
      const full = nodePath.join(dir, shim);
      if (existsSync(full)) {
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

function api(endpoint) {
  return execFileSync(process.execPath, [VERCEL_CLI, "api", endpoint], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

const mine = [];
let url = `/v6/deployments?limit=100&teamId=${TEAM}`;
let pages = 0;

while (url) {
  const parsed = JSON.parse(api(url));
  const deps = parsed.deployments ?? parsed;
  for (const d of deps) if (d.projectId === PROJECT) mine.push(d);
  pages++;
  url = parsed.pagination?.next
    ? `/v6/deployments?limit=100&teamId=${TEAM}&until=${parsed.pagination.next}`
    : null;
  if (pages > 30) throw new Error("pagination did not terminate");
}

mine.sort((a, b) => b.created - a.created);

const out = mine.map((d) => ({
  id: d.uid ?? d.id,
  name: d.url.replace(/^https:\/\//, "").replace(/\.vercel\.app$/, ""),
  url: d.url,
  created: d.created,
  state: d.state,
  sha: (d.meta?.githubCommitSha ?? "").slice(0, 7),
  message: (d.meta?.githubCommitMessage ?? "").split("\n")[0].slice(0, 60),
}));

process.stdout.write(JSON.stringify({ project: PROJECT, pages, total: out.length, deployments: out }, null, 1));