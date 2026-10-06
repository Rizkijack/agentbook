import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

// Mock ONLY saveAtomically so the join persist always fails — the rest of persist
// (saveDebounced, loadWithRecovery) stays real. This exercises the full gateway
// path: joinWorld mutates the world → save throws → rollbackJoin must restore it.
// The probe snapshots the world at save time: it proves what the failed save
// TRIED to write, so a rollback assertion below can't pass merely because the
// mutation never happened.
const saveProbe = vi.hoisted(() => ({ payloads: [] as string[] }));

vi.mock("../src/persist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persist.js")>();
  return {
    ...actual,
    saveAtomically: vi.fn(async (_path: string, data: unknown) => {
      saveProbe.payloads.push(JSON.stringify(data));
      throw new Error("disk full");
    }),
  };
});

const { createGatewayRouter } = await import("../src/gateway.js");
const { createInitialWorld } = await import("../src/world.js");

const world = createInitialWorld();
const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(createGatewayRouter({ world, broadcast: () => {}, DATA_PATH: "/tmp/never-written.json" }));

describe("gateway join rollback", () => {
  it("restores herd, agents registry and parent.forks when the save fails", async () => {
    const herdBefore = world.herd.length;
    const agentsBefore = (world.agents ?? []).length;
    const parent = world.herd[0]!;
    const forksBefore = parent.forks ?? 0;
    const name = "RollbackAgent" + Date.now().toString().slice(-6);

    const res = await request(app)
      .post("/api/agent/join")
      .send({ name, parent: parent.id, bio: "will not persist", origin: "vitest" });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("persist failed");

    // world is back exactly as it was
    expect(world.herd.length).toBe(herdBefore);
    expect((world.agents ?? []).length).toBe(agentsBefore);
    expect(world.herd.some((h) => h.name === name)).toBe(false);
    // the failed join must not leave the parent's fork counter inflated
    expect(parent.forks ?? 0).toBe(forksBefore);
  });

  // review gap #3: joinWorld now validates + persists `owner` (and the typed
  // agent `handle`) — a failed save must clean those up too, not just herd/forks.
  it("cleans up owner + handle as well when a join carrying them fails to save", async () => {
    const herdBefore = world.herd.length;
    const agentsBefore = (world.agents ?? []).length;
    const parent = world.herd[0]!;
    const forksBefore = parent.forks ?? 0;
    const stamp = Date.now().toString().slice(-6);
    const name = "OwnerRollback" + stamp;
    const handle = "@oroll" + stamp;
    const owner = { name: "Orla Owner" + stamp, handle: "@ora" + stamp };
    const savesBefore = saveProbe.payloads.length;

    const res = await request(app)
      .post("/api/agent/join")
      .send({ name, parent: parent.id, bio: "owner must roll back too", origin: "vitest", handle, owner });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("persist failed");

    // the save attempt saw the owner+handle IN the world, so the cleanup below
    // is a genuine rollback — not a join that never mutated anything
    expect(saveProbe.payloads.length).toBe(savesBefore + 1);
    const attempted = saveProbe.payloads[savesBefore]!;
    expect(attempted).toContain(handle);
    expect(attempted).toContain(owner.handle);

    // registry: back to baseline, no record carrying the owner anywhere
    expect((world.agents ?? []).length).toBe(agentsBefore);
    expect((world.agents ?? []).some((a) => a.owner?.handle === owner.handle || a.owner?.name === owner.name)).toBe(false);
    expect(JSON.stringify(world.agents ?? [])).not.toContain(owner.handle);
    expect(JSON.stringify(world.agents ?? [])).not.toContain(owner.name);

    // herd: no resident with the name or the typed handle
    expect(world.herd.length).toBe(herdBefore);
    expect(world.herd.some((h) => h.name === name || h.handle === handle)).toBe(false);
    expect(JSON.stringify(world.herd)).not.toContain(handle);

    // parent's fork counter still not inflated
    expect(parent.forks ?? 0).toBe(forksBefore);
  });
});
