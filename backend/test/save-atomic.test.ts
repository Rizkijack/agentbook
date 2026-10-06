import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAtomically } from "../src/persist.js";

/**
 * Concurrent saves.
 *
 * The town is saved from two independent places: the sim ticks on a timer, and an
 * acting agent can flush at the same moment. Those saves used to share a temp path
 * keyed only on process.pid, so the first rename consumed the temp file and the
 * second found nothing to rename. That surfaced in the dev log as an unhandled
 * `ENOENT: rename 'town.tmp.16248' -> 'town.json'` — an uncaught rejection inside a
 * timer callback, which takes the process down — and left the file holding the
 * first write instead of the last.
 *
 * These assert both halves: nothing throws, and the surviving content is the one
 * that was written last.
 */
async function scratchFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "save-atomic-"));
  return path.join(dir, "town.json");
}

describe("saveAtomically under concurrent writes", () => {
  it("does not throw when many saves overlap", async () => {
    const file = await scratchFile();
    await saveAtomically(file, { n: -1 });
    // Promise.all resolves to the array of results, not undefined — every entry
    // being undefined is what "nothing rejected" actually looks like.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => saveAtomically(file, { n: i })),
    );
    expect(results).toHaveLength(12);
    expect(results.every((r) => r === undefined)).toBe(true);
  });

  it("leaves the LAST write on disk, not the first", async () => {
    const file = await scratchFile();
    await saveAtomically(file, { n: 0 });
    await Promise.all(Array.from({ length: 12 }, (_, i) => saveAtomically(file, { n: i })));
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.n).toBe(11);
  });

  it("leaves no temp files behind", async () => {
    const file = await scratchFile();
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveAtomically(file, { n: i })));
    const dir = path.dirname(file);
    const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("one failing save does not poison the ones after it", async () => {
    const file = await scratchFile();
    // A value JSON.stringify cannot produce turns the write into a rejection
    // mid-flight. The chain must still carry the next save through.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(saveAtomically(file, circular)).rejects.toBeTruthy();
    await expect(saveAtomically(file, { ok: true })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ ok: true });
  });

  it("still writes the backup before replacing the file", async () => {
    const file = await scratchFile();
    await saveAtomically(file, { generation: 1 });
    await saveAtomically(file, { generation: 2 });
    const backup = JSON.parse(await readFile(file.replace(/\.json$/, ".backup.json"), "utf8"));
    expect(backup).toEqual({ generation: 1 });
  });
});