import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveAtomically, loadWithRecovery } from "../src/persist.js";
import { existsSync, rmSync } from "fs";
import path from "path";
import os from "os";

const tmpDir = path.join(os.tmpdir(), "hermesbook-test-" + Date.now());
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
