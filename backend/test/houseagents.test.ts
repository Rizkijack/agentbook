import { describe, it, expect } from "vitest";
import { CONTEST_VENUES, seededRandom, type ContestKind, type ContestSample } from "@hermesbook/shared";
import { scoreContest } from "../src/contest.js";
import { createInitialWorld } from "../src/world.js";
import {
  HOUSE_AGENTS,
  HOUSE_AGENT_IDS,
  ensureHouseResidents,
  isHouseAgent,
  pickHouseAgent,
  willShowUp,
  type HouseAgentId,
} from "../src/houseagents.js";

/**
 * House agents (08 §8, §13).
 *
 * Two kinds of claim in this file, and the difference matters:
 *
 *  - **mechanism** — the rotation, the one-per-contest rule (D8), the show-up
 *    gap, and idempotent seeding. These are all decided in `houseagents.ts`, so
 *    they can be asserted exactly and are asserted exactly.
 *  - **win rate** — §13 asks for "win rate stays inside the target band over N
 *    simulated contests". That is **not measurable yet, and this file does not
 *    pretend otherwise.** Nothing in the shipped code determines a house
 *    agent's win rate: `houseagents.ts` decides *who registers* and *which
 *    venue they gravitate to*, and the only thing that turns a venue into a
 *    result is the resident steering in Phase 3 (`engine`/`turn`), which does
 *    not exist yet. No external agent has ever registered, so there are no real
 *    opponents to measure against either. A test that "measured" the band today
 *    would be measuring its own fixture: the number in the assertion would be
 *    whatever the fixture was written to produce, and tuning a fixture until it
 *    lands on 45% is forging evidence, which is the exact failure 08 §8 warns
 *    about ("scripted throws would destroy trust within two weeks").
 *
 *    So the band is asserted as what it is — a constant that must keep matching
 *    the §8 table — and the suite instead pins the property that would make the
 *    band *honest* once the steering lands: a house entrant is scored by
 *    `scoreContest` on the same terms as anyone else, and wins purely by being
 *    where the objective is. Move the bot and the result moves; label the bot
 *    and nothing does.
 */

const KINDS = Object.keys(CONTEST_VENUES) as ContestKind[];

/**
 * The objective a contest runs, as the season would schedule it.
 *
 * §8 gives the three bots a strict partition of the four objectives, so the
 * objective has to rotate for the rotation to mean anything: a season that only
 * ever ran `gather_at` would make Wren the only reachable bot and leave the
 * other two as dead code. The scheduler is not in this module's scope — this is
 * the schedule the rotation is written against, and the tests below that say
 * "30 consecutive contests" mean 30 contests on it.
 */
const objectiveOf = (contestIndex: number): ContestKind => KINDS[contestIndex % KINDS.length];

const TICK = 1800; // backend TURN_MS
const T0 = 1_700_000_000_000;
const at = (tick: number) => T0 + tick * TICK;
const TICKS = 100; // CONTEST.durationMs / TICK — the whole live window

const profileOf = (id: string) => HOUSE_AGENTS.find((p) => p.id === id)!;

// ---------------------------------------------------------------------------

describe("profiles (08 §8)", () => {
  it("is exactly three, with unique ids", () => {
    expect(HOUSE_AGENTS).toHaveLength(3);
    expect(new Set(HOUSE_AGENT_IDS).size).toBe(3);
  });

  it("exports the ids in profile order, and every id is a fixed house id", () => {
    expect(HOUSE_AGENT_IDS).toEqual(HOUSE_AGENTS.map((p) => p.id));
    for (const id of HOUSE_AGENT_IDS) expect(id.startsWith("house-")).toBe(true);
  });

  it("leaves no objective in CONTEST_VENUES without a bot that wants it", () => {
    for (const kind of KINDS) {
      const wanters = HOUSE_AGENTS.filter((p) => p.kinds.includes(kind));
      expect(wanters.length, `no house agent for ${kind}`).toBeGreaterThan(0);
    }
  });

  it("gravitates only to venues the resolver is allowed to use", () => {
    for (const p of HOUSE_AGENTS) {
      for (const [kind, place] of Object.entries(p.venue)) {
        expect(
          (CONTEST_VENUES[kind as ContestKind] ?? []).includes(place as string),
          `${p.id}: ${place} is not a ${kind} venue`
        ).toBe(true);
      }
    }
  });

  it("gives every declared objective a venue — otherwise the bot cannot play it", () => {
    for (const p of HOUSE_AGENTS) {
      for (const kind of p.kinds) expect(p.venue[kind], `${p.id} has no venue for ${kind}`).toBeTruthy();
    }
  });

  // §8's win rate ± 0.10. Asserted as a table so a "helpful" edit to a band
  // cannot quietly widen the bot's power without this going red.
  const NOMINAL: Record<HouseAgentId, number> = {
    "house-ledger": 0.45,
    "house-hearth": 0.4,
    "house-wren": 0.35,
  };

  it("keeps each winRateBand on the §8 target with its tolerance", () => {
    for (const p of HOUSE_AGENTS) {
      const [lo, hi] = p.winRateBand;
      expect(lo, `${p.id} band floor`).toBeCloseTo(NOMINAL[p.id] - 0.1, 10);
      expect(hi, `${p.id} band ceiling`).toBeCloseTo(NOMINAL[p.id] + 0.1, 10);
    }
  });
});

describe("isHouseAgent", () => {
  it("accepts the three fixed ids", () => {
    for (const id of HOUSE_AGENT_IDS) expect(isHouseAgent(id)).toBe(true);
  });

  it("rejects an ordinary resident id from createInitialWorld()", () => {
    const world = createInitialWorld();
    expect(world.herd.length).toBeGreaterThan(0);
    for (const r of world.herd) expect(isHouseAgent(r.id)).toBe(false);
  });

  it("rejects near misses — the HUD label is not fuzzy", () => {
    for (const id of ["house-ledger-2", "HOUSE-LEDGER", "ledger", "house-", ""]) {
      expect(isHouseAgent(id), id).toBe(false);
    }
  });
});

describe("pickHouseAgent (08 §8, D8)", () => {
  it("is deterministic: the same (contestIndex, kind) always gives the same answer", () => {
    for (let i = 0; i < 30; i++) {
      for (const kind of KINDS) {
        expect(pickHouseAgent(i, kind)).toBe(pickHouseAgent(i, kind));
      }
    }
  });

  it("is unaffected by the order kinds are asked in (no hidden state)", () => {
    const forward = KINDS.map((k) => pickHouseAgent(7, k));
    const backward = KINDS.slice().reverse().map((k) => pickHouseAgent(7, k));
    expect(forward.slice().reverse()).toEqual(backward);
  });

  it("never hands back a bot that does not want the objective", () => {
    for (let i = 0; i < 60; i++) {
      for (const kind of KINDS) {
        const picked = pickHouseAgent(i, kind);
        if (picked) expect(profileOf(picked).kinds).toContain(kind);
      }
    }
  });

  it("routes each objective to the bot §8 gives that strategy", () => {
    // sampled on non-skip indices only — the skip is the next test
    for (const [kind, want] of [
      ["tend_project", "house-ledger"],
      ["hold_ground", "house-hearth"],
      ["endure", "house-hearth"],
      ["gather_at", "house-wren"],
    ] as Array<[ContestKind, HouseAgentId]>) {
      const picks = new Set(
        Array.from({ length: 20 }, (_, i) => pickHouseAgent(i, kind)).filter((p): p is HouseAgentId => p !== null)
      );
      expect([...picks], kind).toEqual([want]);
    }
  });

  it("leaves every fifth contest house-free, and that is the only null source", () => {
    for (let i = 0; i < 40; i++) {
      const skipped = i % 5 === 4;
      for (const kind of KINDS) {
        const picked = pickHouseAgent(i, kind);
        if (skipped) expect(picked, `contest ${i}`).toBeNull();
        else expect(picked, `contest ${i} / ${kind}`).not.toBeNull();
      }
    }
  });

  it("puts at most one house agent in a contest — over the whole season", () => {
    // structurally true of a single return value, so what is actually asserted
    // is the derived rule: one index never yields two distinct bots, and no
    // contest is ever contested by two of them.
    for (let i = 0; i < 30; i++) {
      const inContest = new Set(
        HOUSE_AGENT_IDS.map((id) => (willShowUp(id, i) ? pickHouseAgent(i, objectiveOf(i)) : null)).filter(
          (p): p is HouseAgentId => p !== null
        )
      );
      expect(inContest.size).toBeLessThanOrEqual(1);
    }
  });

  it("rotates all three plus a house-free contest across 30 consecutive contests", () => {
    const seen = new Set<HouseAgentId>();
    let nulls = 0;
    for (let i = 0; i < 30; i++) {
      const picked = pickHouseAgent(i, objectiveOf(i));
      if (picked) seen.add(picked);
      else nulls++;
    }
    expect([...seen].sort()).toEqual(["house-hearth", "house-ledger", "house-wren"]);
    expect(nulls, "real agents must get a contest with no house bot").toBeGreaterThan(0);
  });

  it("survives a negative or absurd index without throwing or escaping the roster", () => {
    for (const i of [-1, -7, 1e6, Number.MAX_SAFE_INTEGER]) {
      for (const kind of KINDS) {
        const picked = pickHouseAgent(i, kind);
        if (picked === null) continue;
        expect(isHouseAgent(picked), `${i}/${kind}`).toBe(true);
      }
    }
  });
});

describe("willShowUp (08 §8)", () => {
  it("is deterministic over 30 contests", () => {
    for (const id of HOUSE_AGENT_IDS) {
      for (let i = 0; i < 30; i++) expect(willShowUp(id, i)).toBe(willShowUp(id, i));
    }
  });

  it("is false at least once per bot over 30 contests — the AFK path stays visible", () => {
    for (const id of HOUSE_AGENT_IDS) {
      const absent = Array.from({ length: 30 }, (_, i) => i).filter((i) => !willShowUp(id, i));
      expect(absent.length, id).toBeGreaterThan(0);
    }
  });

  it("still shows up most of the time, so the HUD is rarely empty", () => {
    for (const id of HOUSE_AGENT_IDS) {
      const shown = Array.from({ length: 30 }, (_, i) => i).filter((i) => willShowUp(id, i));
      expect(shown.length / 30, id).toBeGreaterThan(0.6);
    }
  });

  it("never has all three absent on the same contest", () => {
    for (let i = 0; i < 30; i++) {
      const present = HOUSE_AGENT_IDS.filter((id) => willShowUp(id, i));
      // only meaningful on a contest that has a bot at all
      if (pickHouseAgent(i, objectiveOf(i))) expect(present.length).toBeGreaterThan(0);
    }
  });
});

describe("ensureHouseResidents", () => {
  it("appends the three bots with their fixed ids", () => {
    const world = createInitialWorld();
    const before = world.herd.length;
    const roster = ensureHouseResidents(world);

    expect(world.herd.length).toBe(before + 3);
    expect(roster.map((r) => r.id)).toEqual(["house-ledger", "house-hearth", "house-wren"]);
    for (const p of HOUSE_AGENTS) {
      const resident = world.herd.find((r) => r.id === p.id)!;
      expect(resident).toBeDefined();
      expect(resident.name).toBe(p.name);
    }
  });

  it("builds them from the profile — the profile is the only source of a bot's face", () => {
    const world = createInitialWorld();
    for (const p of HOUSE_AGENTS) {
      const r = ensureHouseResidents(world).find((x) => x.id === p.id)!;
      expect(r.job).toBe(p.job);
      expect(r.bio).toBe(p.bio);
      expect(r.traits).toEqual([...p.traits]);
    }
  });

  it("drives them with the sim, never as external agents (D1)", () => {
    const world = createInitialWorld();
    for (const r of ensureHouseResidents(world)) {
      expect(r.mind.control).toBe("sim");
      expect(r.mind.control).not.toBe("external");
    }
  });

  it("is idempotent: loading a save that already has them changes nothing", () => {
    const world = createInitialWorld();
    const first = ensureHouseResidents(world);
    const afterFirst = world.herd.length;
    const idsAfterFirst = world.herd.map((r) => r.id);

    const second = ensureHouseResidents(world);

    expect(world.herd.length).toBe(afterFirst);
    expect(world.herd.map((r) => r.id)).toEqual(idsAfterFirst);
    // same residents, not replacements — a re-seed must not re-roll their genes
    expect(second).toEqual(first);
    expect(second[0]).toBe(first[0]);
  });

  it("does not duplicate a bot that a save already carries under its fixed id", () => {
    const world = createInitialWorld();
    const already = createInitialWorld().herd[0];
    already.id = "house-ledger";
    world.herd.push(already);

    ensureHouseResidents(world);

    expect(world.herd.filter((r) => r.id === "house-ledger")).toHaveLength(1);
    expect(world.herd[world.herd.length - 1]!.id).toBe("house-wren");
  });

  it("leaves the ordinary herd, the config and the agent registry alone", () => {
    const world = createInitialWorld();
    const ordinaryIds = world.herd.map((r) => r.id);
    const config = structuredClone(world.config);

    ensureHouseResidents(world);

    expect(world.herd.slice(0, ordinaryIds.length).map((r) => r.id)).toEqual(ordinaryIds);
    expect(world.config).toEqual(config);
    expect(world.agents).toBeUndefined();
    for (const r of world.herd) {
      if (ordinaryIds.includes(r.id)) expect(isHouseAgent(r.id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// real resolution over real samples — the bots must lose honestly (08 §8)
// ---------------------------------------------------------------------------

function sample(agentId: string, tick: number, place: string, o: { spit?: boolean; spirits?: number } = {}): ContestSample {
  return { t: at(tick), agentId, place, spirits: o.spirits ?? 0.5, wasSpit: o.spit ?? false };
}

const winner = (r: { standings: Array<{ agentId: string }>; voidResult: boolean }) =>
  r.voidResult ? null : r.standings[0]!.agentId;

describe("house agents under the real resolver (08 §4.2, §8)", () => {
  it("Ledger loses when the project is contested — §8's characteristic failure", () => {
    const samples = [
      ...[0, 1, 2].map((t) => sample("house-ledger", t, "hall")),
      ...[0, 1, 2, 3, 4].map((t) => sample("agent-a", t, "hall")),
      ...[0, 1, 2].map((t) => sample("agent-b", t, "hall")),
    ];
    const r = scoreContest({
      kind: "tend_project",
      place: "hall",
      entrants: ["house-ledger", "agent-a", "agent-b"],
      samples,
      resolvedAt: at(5),
    });
    expect(winner(r)).toBe("agent-a");
    expect(r.standings.find((s) => s.agentId === "house-ledger")!.detail).toContain("on duty at hall");
  });

  it("Wren loses by arriving first and then being out-presenced", () => {
    // §8: "arrives before anyone else, waits alone" — earliest arrival is only
    // a tiebreak, so more ticks at the square beats getting there first
    const samples = [
      sample("house-wren", 0, "square"),
      ...[1, 2, 3, 4, 5].map((t) => sample("agent-a", t, "square")),
      ...[0, 1, 2, 3, 4, 5].map((t) => sample("agent-b", t, "square")),
    ];
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["house-wren", "agent-a", "agent-b"],
      samples,
      resolvedAt: at(6),
    });
    expect(winner(r)).toBe("agent-b");
    const wren = r.standings.find((s) => s.agentId === "house-wren")!;
    expect(wren.rank).toBe(3);
    expect(wren.metric).toBe(1);
  });

  it("Hearth wins outright or not at all — no second place by attrition", () => {
    // the half of §8's failure mode that costs it the win, over the real window
    const samples = [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((t) => sample("house-hearth", t, "pond")),
      ...[0, 1, 2, 3].map((t) => sample("agent-a", t, "pond")),
    ];
    const held = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants: ["house-hearth", "agent-a"],
      samples,
      resolvedAt: at(8),
    });
    expect(winner(held)).toBe("house-hearth");

    // contested head-on for the whole window: nobody holds, and Hearth is
    // ranked below on the arrival tiebreak rather than scraping a place
    const contested = [
      ...[0, 1, 2, 3].map((t) => sample("house-hearth", t, "pond")),
      ...[0, 1, 2, 3].map((t) => sample("agent-a", t, "pond")),
    ];
    const tied = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants: ["house-hearth", "agent-a"],
      samples: contested,
      resolvedAt: at(4),
    });
    expect(tied.standings.every((s) => s.metric === 0)).toBe(true);
  });

  it("does not win by forfeit either — a void result scores nothing (D7)", () => {
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["house-wren"],
      samples: [sample("house-wren", 0, "square"), sample("house-wren", 1, "square")],
      resolvedAt: at(2),
    });
    expect(r.voidResult).toBe(true);
    expect(winner(r)).toBeNull();
    expect(r.standings[0]!.score).toBe(0);
  });
});

/**
 * The band, measured as far as it honestly can be.
 *
 * Both runs push 100-tick windows through the real `scoreContest` and differ in
 * exactly one variable: where the house agent stands. Nothing else — not the id,
 * not the rotation, not the resolver — is allowed to move the number. Together
 * they are the precondition for §8's band ever being believable: the bot wins by
 * being at the objective, loses by not being there, and is scored on the same
 * terms as everybody else.
 */
function playGatherContest(house: HouseAgentId, pHouse: number, pRival: number, seed: number) {
  const rng = seededRandom(seed);
  const entrants = [house, "agent-a", "agent-b"];
  const samples: ContestSample[] = [];
  for (let t = 0; t < TICKS; t++) {
    for (let i = 0; i < entrants.length; i++) {
      const p = i === 0 ? pHouse : pRival;
      samples.push({
        t: at(t),
        agentId: entrants[i],
        place: rng() < p ? "square" : "pond",
        spirits: 0.5,
        wasSpit: false,
      });
    }
  }
  return scoreContest({ kind: "gather_at", place: "square", entrants, samples, resolvedAt: at(TICKS) });
}

function winRate(pHouse: number, pRival: number, contests: number): number {
  let wins = 0;
  for (let n = 0; n < contests; n++) {
    if (winner(playGatherContest("house-wren", pHouse, pRival, 1000 + n)) === "house-wren") wins++;
  }
  return wins / contests;
}

describe("win rate (08 §13) — what can be measured before the sim steers residents", () => {
  it("gives a house entrant no advantage: same behaviour, same odds as anyone", () => {
    const rate = winRate(0.6, 0.6, 400);
    // measured 0.285. Three entrants with identical behaviour have a fair
    // share of 1/3, and the shortfall is the arrival tiebreak resolved by id
    // ("agent-a" < "house-wren"), which costs the bot exact ties — it does not
    // hand it any. Nothing in `scoreContest` knows what a house agent is.
    expect(rate).toBeGreaterThan(0.2);
    expect(rate).toBeLessThan(0.45);
  });

  it("cannot win from the wrong side of the town either", () => {
    // the mirror of the affinity run: same rivals, bot never at the square
    expect(winRate(0, 0.6, 400)).toBe(0);
  });

  it("rewards the one thing a house agent actually controls — being at the venue", () => {
    const rate = winRate(1, 0.3, 200);
    // Wren's venue is the square (§8) and `gather_at` is a presence count, so
    // standing there for the whole window wins it. This is the win rate doing
    // its job, not the resolver doing the bot's work for it.
    expect(rate).toBeGreaterThan(0.9);
  });

  it("clears the bot when it does not show up — a house agent forfeits like anyone", () => {
    let absentContests = 0;
    for (let i = 0; i < 30; i++) {
      if (willShowUp("house-wren", i)) continue;
      absentContests++;
      const r = scoreContest({
        kind: "gather_at",
        place: "square",
        entrants: ["house-wren", "agent-a", "agent-b"],
        // registered, sampled, and never once at the square
        samples: ["house-wren", "agent-a", "agent-b"].flatMap((id) =>
          [0, 1, 2].map((t) => sample(id, t, id === "house-wren" ? "pond" : "square"))
        ),
        resolvedAt: at(3),
      });
      expect(winner(r)).toBe("agent-a");
    }
    expect(absentContests).toBeGreaterThan(0);
  });
});
