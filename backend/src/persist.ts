import { writeFile, rename, copyFile, mkdir } from "fs/promises";
import { open } from "fs/promises";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import { neon } from "@neondatabase/serverless";
import { pgLoad, pgSave, type PgSql } from "./pgstore.js";

/**
 * A Neon client for the current DATABASE_URL.
 *
 * Exported so tooling and tests reach the database through the same driver and
 * the same connection settings the server uses. A script that opened its own
 * client would be a second, untested write path — and the write path is exactly
 * where this project has shipped a production outage before (a stub that modelled
 * `transaction()` more permissively than the real driver does).
 */
export function pgSql(): PgSql {
  // Lazy + per-call: serverless instances must not hold idle connections.
  // @neondatabase/serverless is fetch-based, so this is cheap.
  return neon(process.env.DATABASE_URL!) as unknown as PgSql;
}

/**
 * Serialises every local save.
 *
 * Two overlapping calls used to race. They shared one temp path, because it was
 * keyed on process.pid alone and nothing else, so the first rename consumed the
 * temp file and the second one found nothing to rename — an ENOENT (or EPERM on
 * Windows) thrown from an `await` inside a setTimeout callback, where there is
 * no caller to catch it. That is an unhandled rejection, and an unhandled
 * rejection takes the whole town server down with it.
 *
 * The visible symptom during development was the backend exiting with
 * `ENOENT: rename 'town.tmp.16248' -> 'town.json'`, after which the file on disk
 * still held the *first* write rather than the last. Two saves racing is not
 * exotic here: the sim ticks on a timer and an acting agent can flush at the
 * same moment.
 *
 * Chaining on one promise fixes both halves. Each call still gets its own temp
 * name, so a stale temp can never be renamed by the wrong writer, and the
 * renames cannot overlap, which matters because Windows refuses a rename onto a
 * file another handle is holding open.
 */
let saveChain: Promise<void> = Promise.resolve();
let saveSeq = 0;

export async function saveAtomically(path: string, data: unknown): Promise<void> {
  if (process.env.DATABASE_URL) {
    await pgSave(pgSql(), data);
    return;
  }
  const run = saveChain.then(
    () => writeAtomically(path, data),
    () => writeAtomically(path, data),
  );
  // Keep the chain alive even if this write fails, so one bad save does not
  // poison every save that follows it.
  saveChain = run.catch(() => {});
  await run;
}

async function writeAtomically(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = path.replace(/\.json$/, `.tmp.${process.pid}.${saveSeq++}`);
  const backup = path.replace(/\.json$/, ".backup.json");
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    const fh = await open(tmp, "r");
    try { await fh.sync(); } catch {}
    await fh.close();
  } catch {}
  try {
    await copyFile(path, backup);
  } catch {
    // first write, no backup yet
  }
  await rename(tmp, path);
}

export async function loadWithRecovery(path: string): Promise<unknown> {
  if (process.env.DATABASE_URL) {
    const snap = await pgLoad(pgSql());
    if (snap) return snap;
    throw new Error(`no data at ${path} or backup`);
  }
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch {
    const backup = path.replace(/\.json$/, ".backup.json");
    if (existsSync(backup)) {
      const raw = await readFile(backup, "utf8");
      return JSON.parse(raw);
    }
    throw new Error(`no data at ${path} or backup`);
  }
}

// Debounced batching for routine ticks, immediate flush for forks
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingData: unknown = null;
let pendingPath: string | null = null;

export function saveDebounced(path: string, data: unknown, delayMs = 800): void {
  pendingData = data;
  pendingPath = path;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    if (pendingPath && pendingData) {
      await saveAtomically(pendingPath, pendingData);
    }
    debounceTimer = null;
  }, delayMs);
}

export function flushDebounced(): Promise<void> | null {
  if (debounceTimer && pendingPath && pendingData) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
    return saveAtomically(pendingPath, pendingData);
  }
  return null;
}
