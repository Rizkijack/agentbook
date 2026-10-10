import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// An unreadable save used to fall through to createInitialWorld(), and 800ms later
// the debounced autosave wrote that fresh town over the real one. Silent total
// loss with a successful-looking boot. loadWithRecovery already distinguishes
// "no file" from "broken file"; boot now refuses the second case instead.

const dir = mkdtempSync(path.join(tmpdir(), "slab-bootguard-"));
const DATA = path.join(dir, "town.json");

process.env.DATA_PATH = DATA;
process.env.NODE_ENV = "test";

async function boot(): Promise<{ code: number | null; stderr: string[] }> {
  const { spawn } = await import("node:child_process");
  const stderr: string[] = [];
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, NODE_ENV: "", PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (d) => stderr.push(String(d)));
  const code = await new Promise<number | null>((res) => {
    child.on("exit", res);
    setTimeout(() => res("running" as unknown as number), 8000);
  });
  if (code === ("running" as unknown as number)) child.kill();
  return { code, stderr };
}

describe("boot refuses an unreadable save", () => {
  it("exits non-zero and leaves the file untouched", async () => {
    rmSync(DATA, { force: true });
    const broken = '{"now":1,"config":{"name":"x"},"herd":[';
    writeFileSync(DATA, broken, "utf8");

    const { code, stderr } = await boot();

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("could not be read");
    expect(stderr.join("")).toContain("Refusing to boot");
    // the whole point: the file it refused to trust is still exactly as it was
    expect(readFileSync(DATA, "utf8")).toBe(broken);
  }, 20000);
});

// afterAll, not the describe body: a statement in the body runs during collection,
// which deleted the directory before the test ever ran.
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.DATA_PATH;
});