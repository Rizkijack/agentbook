import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { createInitialWorld } from "../src/world.js";
import { applyDecision } from "../src/turn.js";
import { setWorldRef } from "../src/memory.js";

// The vault note is append-only and gated on sim control: the vault is public,
// and applyDecision is shared with the agent gateway, so an external agent's
// speech must never reach it.
let vaultRoot: string;
const note = () => path.join(vaultRoot, "Towns", "hermesbook", "Town.md");

beforeEach(() => {
  vaultRoot = mkdtempSync(path.join(tmpdir(), "slab-vault-"));
  process.env.OBSIDIAN_VAULT_PATH = vaultRoot;
});

afterAll(() => {
  delete process.env.OBSIDIAN_VAULT_PATH;
});

function speak(world: ReturnType<typeof createInitialWorld>, i: number, text: string) {
  applyDecision(world, world.herd[0]!, { act: "talk", place: "square", reason: "t", speech: text }, { secs: 18 });
}

describe("vault memory sink", () => {
  it("appends a sim resident's speech to the vault note", async () => {
    const world = createInitialWorld();
    setWorldRef(world);
    speak(world, 0, "Vetch, the cart is late");
    await new Promise((r) => setTimeout(r, 20));

    expect(existsSync(note())).toBe(true);
    const body = readFileSync(note(), "utf8");
    expect(body).toContain("Vetch, the cart is late");
    // keyed by resident id, not name — Wren and house-wren would collide
    expect(body).toContain(world.herd[0]!.id);
  });

  it("still keeps the 12-line working set on the resident", () => {
    const world = createInitialWorld();
    setWorldRef(world);
    for (let i = 0; i < 20; i++) speak(world, i, "line " + i);
    expect(world.herd[0]!.mind.memories.length).toBe(12);
    expect(world.herd[0]!.mind.memories[0]).toBe("line 19");
  });

  it("refuses an external agent's speech — the vault is public", async () => {
    const world = createInitialWorld();
    setWorldRef(world);
    const agent = world.herd[0]!;
    agent.mind.control = "external";
    applyDecision(world, agent, { act: "talk", place: "square", reason: "t", speech: "SENSITIVE third party text" }, { secs: 18 });
    await new Promise((r) => setTimeout(r, 20));

    if (existsSync(note())) {
      expect(readFileSync(note(), "utf8")).not.toContain("SENSITIVE third party text");
    }
    // the working set still takes it — that is local state, not published
    expect(agent.mind.memories[0]).toBe("SENSITIVE third party text");
  });

  it("writes nothing when OBSIDIAN_VAULT_PATH is unset", async () => {
    delete process.env.OBSIDIAN_VAULT_PATH;
    const world = createInitialWorld();
    setWorldRef(world);
    expect(() => speak(world, 0, "no vault here")).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(note())).toBe(false);
  });

  it("search reads the working set, not the archive", async () => {
    const world = createInitialWorld();
    setWorldRef(world);
    const agent = world.herd[0]!;
    agent.mind.memories = ["the pond ownership deed again", "market was empty"];
    const { getMemoryProvider } = await import("../src/memory.js");
    expect(await getMemoryProvider().search(agent.id, "pond")).toEqual(["the pond ownership deed again"]);
  });
});