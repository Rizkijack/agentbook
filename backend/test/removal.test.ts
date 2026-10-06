import { describe, it, expect } from "vitest";
import {
  mergeSnapshots, planRemoval, applyRemoval,
} from "../src/pgstore.js";

/**
 * Deletion in a town that only ever grows.
 *
 * The whole town is one JSONB row and `pgSave` merges on every write, so two
 * Vercel instances saving at once cannot lose each other's residents. That same
 * union is why a plain delete does not survive: the next save from an instance
 * that still holds the resident in memory merges them straight back. Tombstones
 * are the mechanism that makes a removal durable, and these tests exist mostly
 * to prove they hold against that resurrection.
 */

function snap(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    now: 1000,
    config: { name: "T", ticker: "T", maxHerd: 64 },
    herd: [
      { id: "keep", name: "Keep", relationships: {} },
      { id: "gone", name: "Gone", relationships: {} },
    ],
    feed: [
      { id: "p1", by: "keep", t: 2 },
      { id: "p2", by: "gone", t: 1 },
    ],
    agents: [
      { id: "a-keep", residentId: "keep" },
      { id: "a-gone", residentId: "gone" },
    ],
    contests: [
      { id: "c1", state: "done", entrants: ["keep", "gone"], samples: [{ agentId: "gone", t: 1 }], standings: [{ agentId: "gone", points: 3 }] },
    ],
    events: [], editions: [], projects: [], factions: [], quests: [],
    ...over,
  };
}

describe("planRemoval — refuses what would break something", () => {
  it("plans a clean leaf removal and counts everything it touches", () => {
    const p = planRemoval(snap(), "gone");
    expect(p.ok).toBe(true);
    expect(p.name).toBe("Gone");
    expect(p.wouldRemove.resident).toBe(true);
    expect(p.wouldRemove.agentRecords).toEqual(["a-gone"]);
    expect(p.wouldRemove.posts).toBe(1);
    expect(p.wouldRemove.contestEntrances).toBe(1);
  });

  it("refuses a resident with children — it would leave a dangling parent", () => {
    const s = snap({ herd: [{ id: "kid", name: "Kid", parent: "gone" }, { id: "gone", name: "Gone" }] });
    const p = planRemoval(s, "gone");
    expect(p.ok).toBe(false);
    expect(p.blockedBy).toContain("child");
    expect(p.wouldRemove.children).toEqual(["kid"]);
  });

  it("refuses an entrant in a live contest", () => {
    const s = snap({ contests: [{ id: "c1", state: "live", entrants: ["gone"], samples: [], standings: [] }] });
    expect(planRemoval(s, "gone").ok).toBe(false);
  });

  it("refuses an id that is not in the herd", () => {
    expect(planRemoval(snap(), "nope").ok).toBe(false);
    expect(planRemoval(snap(), "nope").blockedBy).toBe("no such resident");
  });
});

describe("applyRemoval", () => {
  it("drops the resident, their credential, their posts and their relationships", () => {
    const s = snap({ herd: [
      { id: "keep", name: "Keep", relationships: { gone: 0.5, keep: 1 } },
      { id: "gone", name: "Gone" },
    ] });
    const plan = planRemoval(s, "gone");
    const out = applyRemoval(s, plan, "probe");

    expect((out.herd as Array<{ id: string }>).map((r) => r.id)).toEqual(["keep"]);
    expect((out.agents as Array<{ id: string }>).map((r) => r.id)).toEqual(["a-keep"]);
    expect((out.feed as Array<{ id: string }>).map((p) => p.id)).toEqual(["p1"]);
    const keep = (out.herd as Array<{ relationships: Record<string, number> }>)[0]!;
    expect(keep.relationships).toEqual({ keep: 1 });
    expect(keep.relationships.gone).toBeUndefined();
  });

  it("keeps the contest but empties the dead contestant out of it", () => {
    const plan = planRemoval(snap(), "gone");
    const out = applyRemoval(snap(), plan, "probe");
    const c = (out.contests as Array<Record<string, unknown>>)[0]!;
    expect(c.entrants).toEqual(["keep"]);
    expect(c.samples).toEqual([]);
    expect(c.standings).toEqual([]);
    expect(c.id).toBe("c1");
  });

  it("records a tombstone carrying the registry ids", () => {
    const plan = planRemoval(snap(), "gone");
    const out = applyRemoval(snap(), plan, "probe", 999);
    const t = (out.tombstones as Array<Record<string, unknown>>)[0]!;
    expect(t.id).toBe("gone");
    expect(t.reason).toBe("probe");
    expect(t.at).toBe(999);
    expect(t.agentIds).toEqual(["a-gone"]);
  });
});

describe("the resurrection case — the reason tombstones exist", () => {
  it("a later save from a stale instance does NOT bring the resident back", () => {
    // `stored` is the row after the removal. `stale` is what another Vercel
    // instance still holds in memory — it has never heard about the deletion.
    const stored = applyRemoval(snap(), planRemoval(snap(), "gone"), "probe");
    const stale = snap(); // untouched, still believes in "gone"

    const merged = mergeSnapshots(stored, stale) as Record<string, unknown>;

    expect((merged.herd as Array<{ id: string }>).map((r) => r.id)).toEqual(["keep"]);
    expect((merged.feed as Array<{ id: string }>).map((p) => p.id)).toEqual(["p1"]);
    expect((merged.agents as Array<{ id: string }>).map((a) => a.id)).toEqual(["a-keep"]);
    expect((merged.tombstones as unknown[]).length).toBe(1);
  });

  it("a deletion recorded by the OTHER side is honoured too", () => {
    // Symmetric: whichever instance notices the removal, the other obeys.
    const stored = snap();
    const withTomb = applyRemoval(snap(), planRemoval(snap(), "gone"), "probe");
    const merged = mergeSnapshots(stored, withTomb) as Record<string, unknown>;
    expect((merged.herd as Array<{ id: string }>).map((r) => r.id)).toEqual(["keep"]);
  });

  it("still unions normally when nothing is tombstoned — no lost updates", () => {
    const a = snap({ herd: [{ id: "one", name: "One" }], feed: [{ id: "f1", by: "one", t: 1 }] });
    const b = snap({ herd: [{ id: "two", name: "Two" }], feed: [{ id: "f2", by: "two", t: 2 }] });
    const merged = mergeSnapshots(a, b) as Record<string, unknown>;
    expect((merged.herd as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(["one", "two"]);
    expect((merged.feed as unknown[]).length).toBe(2);
  });

  it("an older save with no tombstones field still merges", () => {
    const legacy = snap();
    delete legacy.tombstones;
    const merged = mergeSnapshots(legacy, snap()) as Record<string, unknown>;
    expect((merged.herd as Array<{ id: string }>).length).toBe(2);
    expect(merged.tombstones).toEqual([]);
  });

  it("tombstones survive repeated saves and do not accumulate duplicates", () => {
    let row = snap();
    for (let i = 0; i < 5; i++) {
      const plan = planRemoval(row, "gone");
      row = applyRemoval(row, plan, "probe") as Record<string, unknown>;
      row = mergeSnapshots(row, snap()) as Record<string, unknown>; // a stale writer saves
    }
    expect(row.tombstones as unknown[]).toHaveLength(1);
    expect((row.herd as Array<{ id: string }>).map((r) => r.id)).toEqual(["keep"]);
  });
});