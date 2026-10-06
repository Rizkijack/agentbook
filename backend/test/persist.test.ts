import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { saveAtomically, loadWithRecovery } from "../src/persist.js";
import { existsSync, rmSync } from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), "agentbook-test-" + Date.now());
const testPath = path.join(tmpDir, "town.json");

describe("Atomic persist", () => {
  beforeEach(() => {
    // ensure tmpDir exists via saveAtomically mkdir
  });
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("writes atomically and creates backup on second write", async () => {
    await saveAtomically(testPath, { herd: [{ id: "a" }] });
    expect(existsSync(testPath)).toBe(true);
    const raw1 = await import("fs/promises").then((m) => m.readFile(testPath, "utf8"));
    expect(JSON.parse(raw1).herd[0].id).toBe("a");

    await saveAtomically(testPath, { herd: [{ id: "b" }] });
    expect(existsSync(testPath.replace(".json", ".backup.json"))).toBe(true);
    const raw2 = await import("fs/promises").then((m) => m.readFile(testPath, "utf8"));
    expect(JSON.parse(raw2).herd[0].id).toBe("b");
    const backupRaw = await import("fs/promises").then((m) => m.readFile(testPath.replace(".json", ".backup.json"), "utf8"));
    expect(JSON.parse(backupRaw).herd[0].id).toBe("a");
  });

  it("recovers from backup if main corrupted", async () => {
    await saveAtomically(testPath, { herd: [{ id: "a" }] });
    await saveAtomically(testPath, { herd: [{ id: "b" }] });
    // corrupt main
    await import("fs/promises").then((m) => m.writeFile(testPath, "corrupt"));
    const recovered: any = await loadWithRecovery(testPath);
    expect(recovered.herd[0].id).toBe("a");
  });
});

// pgSave is a locked read-merge-write, so the client it is handed must be able
// to open a transaction — the real neon() client always can.
vi.mock("@neondatabase/serverless", () => ({
  neon: vi.fn(() => {
    const exec = async () => [] as Record<string, unknown>[];
    return Object.assign(exec, {
      transaction: async <T,>(fn: (tx: typeof exec) => Promise<T>): Promise<T> => fn(exec),
    });
  }),
}));

import { neon } from "@neondatabase/serverless";

describe("persist pg routing (DATABASE_URL set)", () => {
  const pgDir = path.join(os.tmpdir(), "agentbook-pg-test-" + Date.now());
  const neverPath = path.join(pgDir, "never.json");
  let prevDbUrl: string | undefined;

  beforeEach(() => {
    prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://test";
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    try { rmSync(pgDir, { recursive: true, force: true }); } catch {}
  });

  it("saveAtomically routes to pg and does not touch disk", async () => {
    expect(existsSync(neverPath)).toBe(false);
    await saveAtomically(neverPath, { herd: [] });
    expect(vi.mocked(neon)).toHaveBeenCalled();
    expect(existsSync(neverPath)).toBe(false);
  });

  it("loadWithRecovery pg-miss throws no-data error without reading disk", async () => {
    // pg-miss contract: empty pg rows → same `no data at <path> or backup`
    // error so server.ts boot falls back to createInitialWorld().
    await expect(loadWithRecovery(neverPath)).rejects.toThrow(/no data at/);
    // Disk isolation: even a real file on disk must be ignored on the pg path.
    const { mkdir, writeFile } = await import("fs/promises");
    await mkdir(pgDir, { recursive: true });
    await writeFile(neverPath, JSON.stringify({ disk: true }), "utf8");
    await expect(loadWithRecovery(neverPath)).rejects.toThrow(/no data at/);
    expect(vi.mocked(neon)).toHaveBeenCalled();
  });
});
