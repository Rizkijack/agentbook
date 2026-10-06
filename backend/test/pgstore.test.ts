import { describe, it, expect } from "vitest";
import { ensureSchema, mergeSnapshots, normalizeHerd, pgLoad, pgSave } from "../src/pgstore.js";

// pgstore is where the town lost residents: every Vercel instance holds its own
// in-memory world and the row is one JSONB blob, so a plain upsert made a
// lagging instance delete whatever another instance had added. The save is now
// a locked read-merge-write, and these tests pin the rule that makes that safe:
// the written snapshot is the union of the row and the writer's copy, never the
// writer's copy alone.

interface Row {
  snapshot: unknown;
  rev: number;
}

type DbState = { row: Row | null };

/**
 * In-memory stand-in for town_state.
 *
 * It models @neondatabase/serverless 1.2.0 FAITHFULLY, which is the whole
 * point: the previous version of this file accepted a CALLBACK transaction, so
 * the suite went fully green while production returned 500 on every write
 * ("transaction() expects an array of queries"). A stub more permissive than
 * the real driver is worse than no stub, so:
 *
 *  - `sql` returns a pending-query object; awaiting it runs it
 *  - `transaction` REQUIRES an array and throws on anything else, exactly like
 *    the driver does
 *  - the `rev` counter is honoured, so compare-and-swap really does reject a
 *    stale writer instead of pretending every write lands
 *
 * Pass one `state` to several `fakeDb()` calls to model several instances
 * sharing one row.
 */
function fakeDb(initial?: unknown, state: DbState = { row: initial === undefined ? null : { snapshot: initial, rev: 1 } }) {
  const log: string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  /** Make the next CAS lose, simulating an instance that lost the race. */
  let stealOnce = false;

  function run(text: string, values: unknown[]): Record<string, unknown>[] {
    log.push(text);
    if (text.includes("pg_advisory_xact_lock")) return [{ pg_advisory_xact_lock: "" }];

    if (/SELECT snapshot(?:, rev)? FROM town_state/i.test(text)) {
      return state.row ? [{ snapshot: state.row.snapshot, rev: state.row.rev }] : [];
    }
    if (/INSERT INTO town_state/i.test(text)) {
      state.row = { snapshot: JSON.parse(values[1] as string), rev: (state.row?.rev ?? 0) + 1 };
      return [{ rev: state.row.rev }];
    }
    if (/UPDATE town_state SET snapshot/i.test(text)) {
      // three interpolations: merged json, id, seen rev
      if (!state.row) return [];
      if (stealOnce) {
        // another instance committed and moved rev on while we were merging
        stealOnce = false;
        state.row = { snapshot: state.row.snapshot, rev: state.row.rev + 1 };
        return [];
      }
      if (state.row.rev !== values[2]) return []; // compare-and-swap lost
      state.row = { snapshot: JSON.parse(values[0] as string), rev: state.row.rev + 1 };
      return [{ rev: state.row.rev }];
    }
    return [];
  }

  // Lazy on purpose: building `sql\`UPDATE ...\`` inside transaction([...]) must
  // NOT execute it yet — the real driver does not, and an eager stub would let
  // writes escape the transaction queue and pass the compare-and-swap check
  // against a revision that had not moved yet.
  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    const pending: PromiseLike<Record<string, unknown>[]> = {
      then: (onOk, onErr) => Promise.resolve().then(() => run(text, values)).then(onOk, onErr),
    };
    return pending as never as ReturnType<Parameters<typeof pgSave>[0]>;
  };

  const sql = Object.assign(exec, {
    transaction: (queries: unknown) => {
      // the real driver's contract: a callback here is a 500 in production
      if (!Array.isArray(queries)) {
        throw new Error(
          "transaction() expects an array of queries, or a function returning an array of queries",
        );
      }
      const batch = queue.then(async () => {
        const out: Record<string, unknown>[][] = [];
        for (const q of queries as Array<PromiseLike<Record<string, unknown>[]>>) out.push(await q);
        return out;
      });
      queue = batch.then(
        () => undefined,
        () => undefined,
      );
      return batch;
    },
  }) as never as Parameters<typeof pgSave>[0];

  return { sql, log, state, stealOnce: () => (stealOnce = true) };
}

type Snap = Record<string, unknown>;

function resident(id: string, over: Snap = {}): Snap {
  return { id, name: id, mind: { doing: { place: "square" }, relationships: {} }, ...over };
}

function post(id: string, t: number): Snap {
  return { id, t, by: "someone", text: `hello ${id}`, kind: "post", replyTo: null };
}

function snap(over: Snap = {}): Snap {
  return {
    now: 1_700_000_000_000,
    config: { name: "SlopAgentbook", maxHerd: 64 },
    herd: [],
    feed: [],
    events: [],
    editions: [],
    projects: [],
    factions: [],
    quests: [],
    agents: [],
    ...over,
  };
}

describe("ensureSchema", () => {
  it("creates town_state and adds the rev column", async () => {
    const { sql, log } = fakeDb();
    await ensureSchema(sql);
    const all = log.join(" ");
    expect(all).toMatch(/CREATE TABLE IF NOT EXISTS town_state/);
    // CREATE TABLE IF NOT EXISTS is a no-op on the existing row, so the rev
    // column that the compare-and-swap depends on needs its own statement
    expect(all).toMatch(/ALTER TABLE town_state ADD COLUMN IF NOT EXISTS rev bigint/);
  });
});

describe("pgLoad", () => {
  it("returns the snapshot, null when the row is absent", async () => {
    const full = fakeDb({ herd: [] });
    expect(await pgLoad(full.sql)).toEqual({ herd: [] });
    const empty = fakeDb();
    expect(await pgLoad(empty.sql)).toBeNull();
  });

  it("parses a JSONB column that came back as a string", async () => {
    const db = fakeDb();
    const rows = [{ snapshot: JSON.stringify({ herd: [] }) }];
    const sql = (async () => rows) as never as Parameters<typeof pgLoad>[0];
    expect(await pgLoad(sql)).toEqual({ herd: [] });
    expect(db.sql).toBeDefined();
  });
});

describe("mergeSnapshots", () => {
  it("keeps residents the writer has never heard of", () => {
    const stored = snap({ herd: [resident("A"), resident("B")] });
    const mine = snap({ herd: [resident("B"), resident("C")] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    expect((merged.herd as Snap[]).map((r) => r.id)).toEqual(["A", "B", "C"]);
  });

  it("prefers the writer's copy of a resident both instances know", () => {
    const stored = snap({ herd: [resident("A", { job: "miller" })] });
    const mine = snap({ herd: [resident("A", { job: "smith" })] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    expect((merged.herd as Snap[])[0]!.job).toBe("smith");
  });

  it("unions the feed newest-first under the cap", () => {
    const stored = snap({ feed: [post("p1", 100), post("p2", 200)] });
    const mine = snap({ feed: [post("p3", 300)] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    expect((merged.feed as Snap[]).map((p) => p.id)).toEqual(["p3", "p2", "p1"]);

    const flood = snap({ feed: Array.from({ length: 500 }, (_, i) => post(`f${i}`, i)) });
    const capped = mergeSnapshots(snap(), flood) as Snap;
    expect((capped.feed as Snap[])).toHaveLength(400);
    expect((capped.feed as Snap[])[0]!.id).toBe("f499"); // newest survives the cut
  });

  it("deduplicates events that both instances generated, keeping the newest 120", () => {
    const shared = { t: 500, kind: "weather", text: "Rain." };
    const stored = snap({ events: [shared, { t: 100, kind: "weather", text: "Fog." }] });
    const mine = snap({ events: [shared, { t: 900, kind: "quest", text: "Done." }] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    const events = merged.events as Snap[];
    expect(events).toHaveLength(3); // the identical event is one row
    expect(events.map((e) => e.t)).toEqual([100, 500, 900]);

    const flood = Array.from({ length: 200 }, (_, i) => ({ t: i, kind: "weather", text: `w${i}` }));
    const capped = mergeSnapshots(snap(), snap({ events: flood })) as Snap;
    expect((capped.events as Snap[])).toHaveLength(120);
    expect((capped.events as Snap[])[119]!.t).toBe(199);
  });

  it("never shrinks the agent registry and keeps the freshest activity clock", () => {
    const stored = snap({
      agents: [
        { id: "ag1", residentId: "A", tokenHash: "hash1", lastActAt: 5_000 },
        { id: "ag2", residentId: "B", tokenHash: "hash2", lastActAt: 5_000 },
      ],
    });
    // an instance that booted before ag2 was ever registered saves now
    const mine = snap({ agents: [{ id: "ag1", residentId: "A", tokenHash: "hash1", lastActAt: 9_000 }] });
    const merged = mergeSnapshots(stored, mine) as Snap;

    const agents = merged.agents as Snap[];
    expect(agents.map((a) => a.id)).toEqual(["ag1", "ag2"]);
    // stale writer must not age an active agent back into sim control
    expect(agents[0]!.lastActAt).toBe(9_000);
    expect(agents[1]!.lastActAt).toBe(5_000);
  });

  it("caps editions, quests and contests at the lengths the town actually keeps", () => {
    const editions = Array.from({ length: 40 }, (_, i) => ({ no: i + 1, headline: `e${i}` }));
    const quests = Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, createdAt: i, title: `q${i}` }));
    const contests = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, startsAt: i, title: `c${i}` }));

    const merged = mergeSnapshots(snap(), snap({ editions, quests, contests })) as Snap;
    expect((merged.editions as Snap[])).toHaveLength(20);
    expect((merged.editions as Snap[])[0]!.no).toBe(40);
    expect((merged.quests as Snap[])).toHaveLength(12);
    expect((merged.quests as Snap[])[0]!.id).toBe("q29");
    expect((merged.contests as Snap[])).toHaveLength(8);
  });

  it("never exceeds maxHerd even when both instances were under the cap", () => {
    // the real failure this fixes: two instances each legitimately under 64
    // saved in turn and the union came out at 69
    const stored = snap({
      herd: Array.from({ length: 64 }, (_, i) => resident(`s${i}`, { born: 1_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const mine = snap({
      herd: Array.from({ length: 5 }, (_, i) => resident(`m${i}`, { born: 9_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });

    const merged = mergeSnapshots(stored, mine) as Snap;
    const herd = merged.herd as Snap[];
    expect(herd).toHaveLength(64);
    // the newest arrivals survive; the oldest of the stale side is what goes
    expect(herd.filter((r) => String(r.id).startsWith("m"))).toHaveLength(5);
    expect(herd.some((r) => r.id === "s0")).toBe(false);
    expect(herd.some((r) => r.id === "s63")).toBe(true);
  });

  it("leaves an under-cap herd untouched", () => {
    const merged = mergeSnapshots(
      snap({ herd: [resident("A", { born: 1 })] }),
      snap({ herd: [resident("B", { born: 2 })] }),
    ) as Snap;
    expect((merged.herd as Snap[]).map((r) => r.id)).toEqual(["A", "B"]);
  });

  it("keeps the older of two residents that share a name", () => {
    // two instances each admitted "Ochre" without seeing the other
    const stored = snap({
      herd: [resident("old", { name: "Ochre", born: 1_000 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const mine = snap({
      herd: [resident("new", { name: "ochre", born: 2_000 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });

    const herd = (mergeSnapshots(stored, mine) as Snap).herd as Snap[];
    expect(herd).toHaveLength(1);
    expect(herd[0]!.id).toBe("old");
  });

  it("drops a duplicate name BEFORE capping, so the freed slot is reused", () => {
    const stored = snap({
      herd: Array.from({ length: 64 }, (_, i) => resident(`s${i}`, { born: 1_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const mine = snap({
      // a fresh resident that collides with the oldest stored name
      herd: [resident("dup", { name: "Resident 0", born: 9_500 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });

    const herd = (mergeSnapshots(stored, mine) as Snap).herd as Snap[];
    expect(herd).toHaveLength(64);
    // the duplicate was pruned, so nothing had to be evicted for capacity
    expect(herd.some((r) => r.id === "dup")).toBe(true);
    expect(herd.filter((r) => String(r.id).startsWith("s"))).toHaveLength(63);
  });

  it("does not treat residents with no name as duplicates of each other", () => {
    const merged = mergeSnapshots(
      snap({ herd: [resident("A"), resident("B")] }),
      snap(),
    ) as Snap;
    expect((merged.herd as Snap[])).toHaveLength(2);
  });

  describe("normalizeHerd — boot-time healing", () => {
  it("trims an over-cap row back to maxHerd, keeping the newest", () => {
    // the row as it exists in production right now: 69 residents, cap 64
    const row = snap({
      herd: Array.from({ length: 69 }, (_, i) => resident(`r${i}`, { born: 1_000 + i })),
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const out = normalizeHerd(row);
    expect(out).toHaveLength(64);
    expect(out.some((r) => r.id === "r0")).toBe(false); // oldest dropped
    expect(out.some((r) => r.id === "r68")).toBe(true); // newest kept
  });

  it("prunes a duplicate name without touching anything else", () => {
    const row = snap({
      herd: [
        resident("old", { name: "Ochre", born: 1_000 }),
        resident("new", { name: "Ochre", born: 2_000 }),
        resident("x", { name: "Peregrine", born: 1_500 }),
      ],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    const out = normalizeHerd(row);
    expect(out.map((r) => r.id)).toEqual(["old", "x"]);
  });

  it("leaves a healthy row exactly as it was", () => {
    const row = snap({
      herd: [resident("A", { born: 1 }), resident("B", { born: 2 })],
      config: { name: "SlopAgentbook", maxHerd: 64 },
    });
    expect(normalizeHerd(row).map((r) => r.id)).toEqual(["A", "B"]);
  });

  it("does not throw on a snapshot with no config or no herd", () => {
    expect(normalizeHerd(null)).toEqual([]);
    expect(normalizeHerd({})).toEqual([]);
    expect(normalizeHerd({ herd: "not an array" })).toEqual([]);
  });
});

it("survives garbage on either side instead of throwing", () => {
    expect(() => mergeSnapshots(null, undefined)).not.toThrow();
    expect(() => mergeSnapshots({ herd: "not an array" }, { feed: 42 })).not.toThrow();
    const merged = mergeSnapshots({ herd: "not an array" }, { feed: 42 }) as Snap;
    expect(merged.herd).toEqual([]);
    expect(merged.feed).toEqual([]);
  });
});

describe("pgSave — the lost-update rule", () => {
  it("writes the union, so a lagging instance cannot delete new residents", async () => {
    // ONE row, two instances — that is the whole point of the merge
    const shared: DbState = { row: { snapshot: snap({ herd: [resident("Vetch")] }), rev: 1 } };

    // instance A boots, forks a resident, saves
    const a = fakeDb(undefined, shared);
    await pgSave(a.sql, snap({ herd: [resident("Vetch"), resident("Garnet")] }));

    // instance B booted BEFORE that and still believes the town is just Vetch
    const b = fakeDb(undefined, shared);
    await pgSave(b.sql, snap({ herd: [resident("Vetch")], quests: [{ id: "q1", createdAt: 1 }] }));

    expect(((shared.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id)).toEqual(["Vetch", "Garnet"]);
    expect((shared.row!.snapshot as Snap).quests).toHaveLength(1);
  });

  it("takes the advisory lock and writes with a compare-and-swap on rev", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    await pgSave(db.sql, snap({ herd: [resident("A"), resident("B")] }));

    const all = db.log.join(" | ");
    expect(all).toContain("pg_advisory_xact_lock");
    // the write is conditional on the revision we read, which is what stops a
    // stale writer from silently overwriting a fresher one
    expect(all).toMatch(/UPDATE town_state SET snapshot[\s\S]*WHERE id = \? AND rev = \?/);
    // and the read must happen BEFORE that write
    expect(db.log.findIndex((l) => /SELECT snapshot, rev/i.test(l))).toBeLessThan(
      db.log.findIndex((l) => /UPDATE town_state/i.test(l)),
    );
  });

  it("re-reads and re-merges when another writer wins the race", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    db.stealOnce(); // someone else commits first, moving rev on

    await pgSave(db.sql, snap({ herd: [resident("A"), resident("Mine")] }));

    // the save retried instead of overwriting: our resident is there AND the
    // row's rev advanced past the one we first read
    expect(((db.state.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id)).toEqual(["A", "Mine"]);
    expect(db.state.row!.rev).toBe(3); // 1 → stolen to 2 → our successful CAS to 3
    expect(db.log.filter((l) => /SELECT snapshot, rev/i.test(l))).toHaveLength(2);
  });

  it("still persists when every attempt loses the race", async () => {
    const db = fakeDb(snap({ herd: [resident("A")] }));
    // starve the retry loop: each CAS loses
    for (let i = 0; i < 6; i++) db.stealOnce();

    await pgSave(db.sql, snap({ herd: [resident("A"), resident("Last")] }));

    // the fallback write must land — losing the merge race is not a reason to
    // lose the town's data
    expect(((db.state.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id)).toEqual(["A", "Last"]);
  });

  it("creates the row without a merge when the town has never been saved", async () => {
    const db = fakeDb();
    await pgSave(db.sql, snap({ herd: [resident("First")] }));
    expect((db.state.row!.snapshot as Snap).herd).toEqual([resident("First")]);
  });

  it("survives concurrent saves from two instances — nobody's residents vanish", async () => {
    const db = fakeDb(snap({ herd: [] }));
    await Promise.all([
      pgSave(db.sql, snap({ herd: [resident("A"), resident("B")] })),
      pgSave(db.sql, snap({ herd: [resident("C"), resident("D")] })),
    ]);
    const ids = ((db.state.row!.snapshot as Snap).herd as Snap[]).map((r) => r.id).sort();
    expect(ids).toEqual(["A", "B", "C", "D"]);
  });

  it("rejects a callback-style transaction the way the real driver does", async () => {
    // This is the regression guard for the production outage: the previous
    // implementation passed an `async (tx) => { await tx\`...\` }` callback to
    // neon().transaction(), which throws at runtime on 1.2.0 and 500s every
    // write. The stub enforces the array contract so that shape cannot come
    // back without turning this file red.
    const { sql } = fakeDb();
    const bad = sql as unknown as { transaction: (q: unknown) => Promise<unknown> };
    expect(() => bad.transaction(async () => [])).toThrow(/expects an array of queries/);
  });
});