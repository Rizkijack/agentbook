/**
 * Hermetic persistence for the backend suite (wired in vitest.config.ts via
 * `setupFiles`).
 *
 * The suite must never read or write the repo's data/town.json: that is a live
 * save (herd 64/64 full, `_visited` left as `{}` by an old Set round-trip), and
 * any assertion touching it passes or fails by accident of its contents.
 *
 * Rules:
 * - A DATA_PATH set by the caller (CI, or the "full pasture" gate run) is
 *   respected as-is — the suite then deliberately runs against that town.
 * - Otherwise each test file gets its own throwaway town under the OS temp
 *   dir, seeded from createInitialWorld(): a small valid world (8 herd, far
 *   from maxHerd 64), so snapshot/fork tests always have a parent and room to
 *   grow, while never being "full".
 * - Nothing under the repo's data/ directory is ever written; saves land in
 *   the temp file (plus its .backup.json sibling) like any other DATA_PATH.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import { createInitialWorld } from "../src/world.js";

/** Marker: DATA_PATH was seeded by this setup, not supplied by the caller. */
const SEEDED_BY_SETUP = "SLOPAGENTBOOK_TEST_DATA_PATH";

function seedThrowawayTown(): void {
  const dir = path.join(os.tmpdir(), "agentbook-backend-test");
  mkdirSync(dir, { recursive: true });
  sweepStale(dir);
  // unique per file/worker: parallel workers must not race on one save file,
  // and each test file starts from the same pristine town state.
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `town-${unique}.json`);
  writeFileSync(file, JSON.stringify(createInitialWorld(), null, 2), "utf8");
  process.env.DATA_PATH = file;
  process.env[SEEDED_BY_SETUP] = "1";

  // Best effort: take our own throwaway town — and persist.ts's .backup.json
  // sibling — with us on a clean exit. It does not fire when vitest terminates
  // a forked worker (Windows: TerminateProcess), which is what sweepStale is for.
  process.once("exit", () => {
    for (const f of [file, file.replace(/\.json$/, ".backup.json")]) {
      try {
        rmSync(f, { force: true });
      } catch {
        /* ignore */
      }
    }
  });
}

/**
 * Delete throwaway towns older than an hour, including the `.tmp.<pid>` and
 * `.backup.json` siblings they leave behind. Without this the directory grows
 * without bound: a worker killed mid-run never fires `exit`, so one file per
 * test file piles up on every run.
 *
 * The one-hour floor is deliberate: a concurrent suite (another agent, another
 * checkout) may still own its file, and stealing it would fail their run.
 */
function sweepStale(dir: string): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("town-")) continue;
    const full = path.join(dir, entry);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { force: true });
    } catch {
      /* ignore — sweeping must never fail a test run */
    }
  }
}

if (!process.env.DATA_PATH || process.env[SEEDED_BY_SETUP] === "1") {
  seedThrowawayTown();
}
