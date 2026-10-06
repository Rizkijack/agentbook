import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

// Mock ONLY saveAtomically so the join persist always fails — the rest of persist
// (saveDebounced, loadWithRecovery) stays real. This exercises the full gateway
// path: joinWorld mutates the world → save throws → rollbackJoin must restore it.
vi.mock("../src/persist.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/persist.js")>();
  return {
    ...actual,
    saveAtomically: vi.fn(async () => {
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
});
