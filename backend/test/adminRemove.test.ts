import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import path from "node:path";
import { tmpdir } from "node:os";
import type { TownSnapshot } from "@slopagentbook/shared";

// A throwaway DATA_PATH so a mis-fired --apply cannot touch the real save file.
process.env.DATA_PATH = path.join(tmpdir(), `agentbook-admin-test-${process.pid}-${Date.now()}.json`);
const { createGatewayRouter } = await import("../src/gateway.js");

/**
 * The admin removal route.
 *
 * Two properties matter more than the deletion itself:
 *   1. Without ADMIN_KEY the route must not exist. A public app should not carry
 *      a delete surface just because the code for one is deployed.
 *   2. With the key it must still be a dry run by default, because the removal
 *      writes a tombstone into a town full of other people's work.
 */
const KEY = "test-admin-key-0123456789";
const ID = "probe1";

function town(): TownSnapshot {
  return {
    now: 1000,
    config: { name: "T", ticker: "T", tokenAddress: "", maxHerd: 64 } as TownSnapshot["config"],
    herd: [
      { id: "keep", name: "Keep", handle: "keep", genes: "", job: "", bio: "", traits: [], gen: 0, forks: 0, born: 0, needs: {} as never, mind: {} as never, spirits: 0, obsession: "", memories: [], relationships: {} },
      { id: ID, name: "Probe1", handle: "p1", genes: "", job: "", bio: "", traits: [], gen: 0, forks: 0, born: 0, needs: {} as never, mind: {} as never, spirits: 0, obsession: "", memories: [], relationships: {} },
    ],
    feed: [{ id: "p1", t: 1, by: ID, name: "Probe1", handle: "p1", text: "x", kind: "post", replyTo: null }],
    events: [], editions: [], projects: [], factions: [], quests: [],
    agents: [{ id: "a-probe", residentId: ID, tokenHash: "h", origin: "test", joinedAt: 1 }],
  } as unknown as TownSnapshot;
}

function build(world: TownSnapshot, broadcasts: unknown[] = []) {
  const a = express();
  a.use(express.json({ limit: "64kb" }));
  a.use(createGatewayRouter({ world, broadcast: (m) => broadcasts.push(m), DATA_PATH: process.env.DATA_PATH! }));
  return a;
}

describe("admin removal route — absent without ADMIN_KEY", () => {
  beforeEach(() => { delete process.env.ADMIN_KEY; });
  afterEach(() => { delete process.env.ADMIN_KEY; });

  it("is not mounted at all", async () => {
    // 404, not 401/403: the response must not confirm a delete route exists
    const world = town();
    const res = await request(build(world)).delete(`/api/admin/resident/${ID}`);
    expect(res.status).toBe(404);
    expect(world.herd.some((r) => r.id === ID)).toBe(true);
  });
});

describe("admin removal route — with ADMIN_KEY", () => {
  beforeEach(() => { process.env.ADMIN_KEY = KEY; });
  afterEach(() => { delete process.env.ADMIN_KEY; });

  const withKey = (a: ReturnType<typeof build>) =>
    request(a).delete(`/api/admin/resident/${ID}`).set("x-admin-key", KEY);

  it("cannot be probed: missing, wrong, right-length-wrong, and prefix keys all 404", async () => {
    const a = build(town());
    expect((await request(a).delete(`/api/admin/resident/${ID}`)).status).toBe(404);
    expect((await request(a).delete(`/api/admin/resident/${ID}`).set("x-admin-key", "wrong")).status).toBe(404);
    // a length check alone would wave this one through
    expect((await request(a).delete(`/api/admin/resident/${ID}`).set("x-admin-key", "x".repeat(KEY.length))).status).toBe(404);
    expect((await request(a).delete(`/api/admin/resident/${ID}`).set("x-admin-key", KEY.slice(0, -1))).status).toBe(404);
  });

  it("is a dry run by default: it plans, and changes nothing", async () => {
    const world = town();
    const res = await withKey(build(world));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.name).toBe("Probe1");
    expect(res.body.wouldRemove.posts).toBe(1);
    expect(res.body.wouldRemove.agentRecords).toEqual(["a-probe"]);
    expect(res.body.hint).toContain("apply=1");
    // the town is untouched
    expect(world.herd.some((r) => r.id === ID)).toBe(true);
    expect(world.feed).toHaveLength(1);
    expect(world.tombstones ?? []).toHaveLength(0);
  });

  it("reports a blocked dry run as 200 — it is an answer, not a failure", async () => {
    const world = town();
    world.herd[0]!.parent = ID; // Keep is a child of the probe
    const res = await withKey(build(world));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.blockedBy).toContain("child");
    expect(res.body.hint).toContain("blocked");
    expect(world.herd.some((r) => r.id === ID)).toBe(true);
  });

  it("409s when an actual apply is blocked, because the change failed", async () => {
    const world = town();
    world.herd[0]!.parent = ID;
    const res = await request(build(world))
      .delete(`/api/admin/resident/${ID}?apply=1`)
      .set("x-admin-key", KEY);
    expect(res.status).toBe(409);
    expect(res.body.applied).toBe(false);
    expect(world.herd.some((r) => r.id === ID)).toBe(true);
  });

  it("refuses an unknown id", async () => {
    const res = await request(build(town()))
      .delete("/api/admin/resident/nope")
      .set("x-admin-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.blockedBy).toBe("no such resident");
  });

  it("applies with ?apply=1 and writes a tombstone", async () => {
    const world = town();
    const broadcasts: unknown[] = [];
    const res = await request(build(world, broadcasts))
      .delete(`/api/admin/resident/${ID}?apply=1`)
      .set("x-admin-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);

    expect(world.herd.map((r) => r.id)).toEqual(["keep"]);
    expect(world.feed).toHaveLength(0);
    expect(world.agents).toHaveLength(0);
    const tomb = world.tombstones?.[0];
    expect(tomb?.id).toBe(ID);
    expect(tomb?.agentIds).toEqual(["a-probe"]);
    // the UI is told, so open tabs drop the resident instead of keeping a ghost
    expect(broadcasts.some((m) => (m as { type?: string }).type === "herd")).toBe(true);
  });
});

describe("timingSafeEqualStrings", () => {
  it("matches identical strings and rejects everything else", async () => {
    const { timingSafeEqualStrings } = await import("../src/adminKey.js");
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false);
    expect(timingSafeEqualStrings("abc123", "abc12")).toBe(false);
    expect(timingSafeEqualStrings("", "")).toBe(true);
    expect(timingSafeEqualStrings("a", "")).toBe(false);
  });

  it("handles multi-byte input without throwing", async () => {
    const { timingSafeEqualStrings } = await import("../src/adminKey.js");
    expect(timingSafeEqualStrings("kée-🌾", "kée-🌾")).toBe(true);
    expect(timingSafeEqualStrings("kée-🌾", "kee-🌾")).toBe(false);
  });
});