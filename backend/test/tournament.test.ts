/**
 * The tournament driver (08 §5, §7, D1–D8).
 *
 * `tickTournament` takes `now` as an argument precisely so this suite can drive
 * a whole season — 5 trial DAYS of 2–3 contests each, then two semifinals, a
 * final, a champion and a rollover — in milliseconds without a real clock and
 * without a running sim.
 *
 * Two clock rules, and losing either is how this suite went stale once already:
 *
 *  - **anchor the season to the test clock.** `createInitialWorld()` stamps
 *    `season.startedAt` with the *real* clock (world.ts:115). Driving a
 *    synthetic `T0` against that anchor puts every in-game day at season
 *    position 249 — well past the trial days — so the phase machine reads
 *    trials as knockouts, the roster as a bracket, and `retireResolved`'s
 *    knockout shield swallows every card. `beforeEach` re-anchors to `T0`.
 *  - **pass the test's own `now`** to every clock-taking call
 *    (`registerForContest`, `seasonPhase`) instead of letting it default to
 *    `Date.now()`, which is a different day entirely.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { CONTEST, CONTEST_VENUES, SEASON, contestsPerDay, dayOfYear } from "@slopagentbook/shared";
import type { Contest, Season, TownSnapshot } from "@slopagentbook/shared";
import { createInitialWorld } from "../src/world.js";
import { joinWorld, AGENT_AFK_MS } from "../src/agents.js";
import { ensureHouseResidents, HOUSE_AGENT_IDS, isHouseAgent } from "../src/houseagents.js";
import { createSeason, seasonContestIndex } from "../src/season.js";
import {
  announceContest,
  contestVenue,
  forfeitNotice,
  forfeitingEntrants,
  matchupLine,
  nextContestKind,
  registerForContest,
  retireResolved,
  seasonPhase,
  tickTournament,
  upcomingContest,
  withdrawFromContest,
} from "../src/tournament.js";

/**
 * Anchored on a `DAY_LENGTH_SEC` (900s) boundary. The raw `1_700_000_000_000`
 * lands 800s into its in-game day, leaving only 100s of it — and a slot is
 * 241s, so the *second* contest of every day silently crossed into the next
 * `dayOfYear` (`d14` → `d15`) and the day-prefix assertions, the quota and the
 * phase machine all read a calendar this suite never meant to play.
 */
const T0 = 1_699_999_200_000;
/** one in-game day, so each contest lands on a fresh `dayOfYear` */
const DAY = 900_000;

let world: TownSnapshot;

/** External agents, which is what a season actually needs to play out. */
let agentSeq = 0;
function addAgents(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const joined = joinWorld(world, { name: `Contender${agentSeq++}`, origin: "vitest" });
    ids.push(joined.resident.id);
  }
  return ids;
}

beforeEach(() => {
  world = createInitialWorld();
  ensureHouseResidents(world);
  // Re-anchor the season to the clock this suite ticks. See the file header:
  // without this the season's calendar starts on the *real* today, and every
  // synthetic day below lands past the trial days.
  world.season = createSeason(1, T0);
});

/**
 * One slot of a day's slate: announce → register → live → sample → resolve.
 *
 * `SLOT` is the arithmetic `CONTEST.perDay` is derived from (08 §6): 60s
 * announce + 180s live + 1s handover = 241s, and three of those fit inside the
 * 900s in-game day. Slots are laid out back-to-back so a whole slate plays
 * *within* its own day instead of reusing one timestamp.
 */
const SLOT = CONTEST.announceMs + CONTEST.durationMs + 1000;

function playContestAt(at: number, register: readonly string[] = []): Contest | null {
  const c = announceContest(world, at);
  if (!c) return null;
  for (const id of register) if (c.state === "announced") registerForContest(world, id, at);
  tickTournament(world, c.startsAt); // -> live (or D6 skip)
  for (let i = 0; i < 6; i++) {
    for (const id of c.entrants) {
      const r = world.herd.find((h) => h.id === id);
      if (r) r.mind.doing.place = i % 2 === 0 ? c.place : "tavern";
    }
    tickTournament(world, c.startsAt + 1000 + i * 1000);
  }
  tickTournament(world, c.endsAt + 1); // -> resolved
  return c;
}

/**
 * The whole slate of the in-game day starting at `now` — `contestsPerDay`
 * contests on a trial day, `expectedSemifinals` on the semifinal day, the
 * single final on its own. Stops when the day's quota is spent.
 */
function playDay(now: number, register: readonly string[] = []): Contest[] {
  const played: Contest[] = [];
  while (played.length <= CONTEST.perDay.max) {
    const c = playContestAt(now + played.length * SLOT, register);
    if (!c) break;
    played.push(c);
  }
  return played;
}

/**
 * The ledger of a finished trial stage: `SEASON.trials` distinct in-game days,
 * starting at `anchor`. Real `ct-s{season}-d{day}-i{index}` ids, because the
 * phase machine reads the *days* back out of them (`dayOfContestId`).
 */
function trialLedger(anchor: number, seasonNo = 1): string[] {
  const dayAt = (pos: number) => ((dayOfYear(anchor) + pos - 1) % 365) + 1;
  return Array.from({ length: SEASON.trials }, (_, p) => `ct-s${seasonNo}-d${dayAt(p)}-i${p}`);
}

/** A clock `pos` in-game days after `T0` — the same day the ledger's ids use. */
const atPos = (pos: number) => T0 + pos * DAY;

/** A season whose trial days are already played and whose calendar is `T0`. */
function trialStageDone(standings: Season["standings"] = []): Season {
  return { ...createSeason(1, T0), standings, appliedContests: trialLedger(T0) };
}

describe("schedule (08 D3, §4.2)", () => {
  it("rotates the objective so every house bot stays reachable", () => {
    // `houseagents.ts` partitions the four objectives across the three bots. A
    // fixed objective would leave two bots as dead code, so the rotation is a
    // correctness property, not a flavour choice.
    const seen = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(nextContestKind));
    expect(seen).toEqual(new Set(["gather_at", "hold_ground", "tend_project", "endure"]));
  });

  it("picks a venue legal for the objective", () => {
    for (let i = 0; i < 12; i++) {
      const kind = nextContestKind(i);
      const place = contestVenue(kind, i);
      // asserted against the config for *that* objective: a flat list of every
      // venue would pass even if the function returned "pond" for `tend_project`
      expect(CONTEST_VENUES[kind]).toContain(place);
    }
  });
});

describe("announce", () => {
  it("opens a contest in the announced state with the v1 headline", () => {
    const c = announceContest(world, T0)!;
    expect(c).not.toBeNull();
    expect(c.state).toBe("announced");
    expect(c.title).toBe("THE HALL ARGUMENT");
    expect(c.startsAt).toBe(T0 + CONTEST.announceMs);
    expect(c.endsAt).toBe(T0 + CONTEST.announceMs + CONTEST.durationMs);
    expect(c.samples).toEqual([]);
  });

  it("opens the day's slate one contest at a time, never two windows at once", () => {
    // decision 1 (2–3 contests per in-game day) does not mean two *open*
    // contests: a second window would collect registrations for the same hall
    // from two directions, and `liveContest` only ever serves the first.
    const first = announceContest(world, T0)!;
    expect(first).not.toBeNull();
    expect(announceContest(world, T0 + 1000)).toBeNull();

    // the day is not over though — resolving the first frees the next slot
    tickTournament(world, first.startsAt); // D6: nobody registered, so it skips
    const second = announceContest(world, first.endsAt + 1);
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    // same day, so the same season-day prefix: the quota is what bounds it
    expect(second!.id.split("-i")[0]).toBe(first.id.split("-i")[0]);
  });

  it("spends the day's quota instead of spinning on the same id", () => {
    // decision 1: a trial day hosts `contestsPerDay` contests, D6 skip included
    const first = announceContest(world, T0)!;
    tickTournament(world, first.startsAt);
    const second = announceContest(world, first.endsAt + 1)!;
    tickTournament(world, second.startsAt);

    const third = announceContest(world, second.endsAt + 1);
    expect(third).toBeNull();
    expect(world.contests).toHaveLength(2);
    expect(new Set(world.contests!.map((c) => c.id)).size).toBe(2); // no id ever re-opened
    expect(world.season!.appliedContests ?? []).toHaveLength(0); // a D6 skip is not a result
  });

  it("puts at most one house bot in a trial roster (D8)", () => {
    // Driven over real in-game days rather than a fabricated ledger: the bot
    // rotation keys off the season ledger, so a day's slate of 2–3 contests is
    // what actually exercises it — and every one of them must still hold D8.
    const agents = addAgents(3);
    const bots = new Set<string>();
    let now = T0;
    for (let day = 0; day < SEASON.seasonDays; day++) {
      for (const c of playDay(now, agents)) {
        const house = c.entrants.filter((id) => isHouseAgent(id));
        expect(house.length).toBeLessThanOrEqual(1);
        if (house.length === 1) {
          expect(c.houseEntrant).toBe(house[0]);
          bots.add(house[0]);
        }
      }
      now += DAY;
      retireResolved(world, now);
      if ((world.season?.no ?? 1) > 1) break; // season rolled: later days are a new bracket
    }
    expect(bots.size).toBeGreaterThan(0); // the rule was actually exercised
  });

  it("banks a quiet day with house agents — up to the cap, and only that far (decision 4)", () => {
    // Someone is in town but nobody registers for this contest: without help
    // it D6-skips, and 08 §15's promise — "the HUD is never empty" — breaks for
    // a whole in-game day. Decision 4 banks house agents into it instead.
    // The second half is the real subject: a *cap*. Two bots on a quiet day is
    // an accident; more would make a bot-vs-bot row the shape of the board.
    expect(CONTEST.maxHouseOnQuietDay).toBe(2);
    addAgents(1); // a contender exists in town — it simply did not register

    const first = announceContest(world, atPos(1))!;
    expect(first).not.toBeNull();
    expect(tickTournament(world, first.startsAt)?.reason).toBe("live"); // helped, not skipped
    const banked = first.entrants.filter((id) => isHouseAgent(id));
    expect(banked).toHaveLength(CONTEST.maxHouseOnQuietDay); // filled *to* the cap…
    expect(first.entrants).toHaveLength(CONTEST.maxHouseOnQuietDay); // …and no further

    // finish it so the day's one-open-window lock clears, then open the next:
    // the day is spent, so the second window may not double the bank
    for (const id of first.entrants) {
      const r = world.herd.find((h) => h.id === id);
      if (r) r.mind.doing.place = first.place;
    }
    tickTournament(world, first.endsAt + 1);
    const second = announceContest(world, first.endsAt + 2)!;
    expect(second).not.toBeNull();
    expect(tickTournament(world, second.startsAt)?.reason).toBe("skipped"); // D6, by design
    expect(second.entrants.filter((id) => isHouseAgent(id)).length).toBeLessThan(
      CONTEST.maxHouseOnQuietDay
    );
  });
});

describe("registration (08 §7, D1, D4, D6)", () => {
  it("refuses a resident — only external agents compete (D1)", () => {
    announceContest(world, T0);
    const local = world.herd.find((h) => h.mind.control !== "external" && !isHouseAgent(h.id))!;
    const out = registerForContest(world, local.id, T0);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(403);
  });

  it("accepts an external agent, and registering twice changes nothing", () => {
    const [a] = addAgents(1);
    announceContest(world, T0);
    expect(registerForContest(world, a!, T0).ok).toBe(true);
    const roster = upcomingContest(world)!.entrants.length;
    expect(registerForContest(world, a!, T0).ok).toBe(true);
    expect(upcomingContest(world)!.entrants.length).toBe(roster);
  });

  it("turns the latecomer away when the roster is full, without cancelling the contest", () => {
    const ids = addAgents(CONTEST.maxEntrants);
    announceContest(world, T0);
    for (const id of ids.slice(0, CONTEST.maxEntrants)) registerForContest(world, id, T0);
    const extra = addAgents(1)[0]!;
    const out = registerForContest(world, extra, T0);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    // the contest itself is untouched — over-subscription must never veto it
    expect(upcomingContest(world)!.entrants.length).toBe(CONTEST.maxEntrants);
  });

  it("withdraws during the announce window", () => {
    const [a] = addAgents(1);
    announceContest(world, T0);
    registerForContest(world, a!, T0);
    expect(withdrawFromContest(world, a!).ok).toBe(true);
    expect(upcomingContest(world)!.entrants).not.toContain(a);
  });

  it("refuses a withdrawal once the contest is under way (D5)", () => {
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    for (const id of ids) registerForContest(world, id, T0);
    tickTournament(world, c.startsAt);
    expect(c.state).toBe("live");
    const out = withdrawFromContest(world, ids[0]!);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    // D5: the contest continues with whoever is left — nobody is kicked
    expect(c.entrants).toContain(ids[0]);
  });

  it("reports 'not registered' rather than pretending to withdraw", () => {
    const [a] = addAgents(1);
    announceContest(world, T0);
    expect(withdrawFromContest(world, a!).status).toBe(404);
  });
});

describe("lifecycle", () => {
  it("walks announced → live → resolved", () => {
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    expect(c.state).toBe("announced");
    for (const id of ids) registerForContest(world, id, T0);
    expect(tickTournament(world, c.startsAt)?.reason).toBe("live");
    expect(tickTournament(world, c.startsAt + 2000)).toBeNull(); // sampling is silent
    expect(c.samples.length).toBeGreaterThan(0);
    const done = tickTournament(world, c.endsAt + 1)!;
    expect(done.reason).toBe("resolved");
    expect(c.state).toBe("resolved");
    expect(c.result).toBeDefined();
    expect(c.result!.standings.length).toBeGreaterThanOrEqual(2);
  });

  it("samples once per entrant per turn, whatever happens in the world", () => {
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    for (const id of ids) registerForContest(world, id, T0);
    tickTournament(world, c.startsAt);
    const before = c.samples.length;
    tickTournament(world, c.startsAt + 500);
    expect(c.samples.length - before).toBe(c.entrants.length);
  });

  it("never starts below two entrants (D6) and says why", () => {
    const c = announceContest(world, T0)!; // house bot only, no agents joined
    const event = tickTournament(world, c.startsAt)!;
    expect(event.reason).toBe("skipped");
    expect(event.skippedBecause).toContain(String(CONTEST.minEntrants));
    expect(c.result).toBeUndefined();
    expect(c.state).toBe("resolved");
  });

  it("never re-announces a skipped contest — the slate moves to the next slot", () => {
    // Regression: deleting the skipped contest made every subsequent turn
    // re-announce and re-skip the *same* id, spinning for the whole day. Since
    // decision 1 a day hosts 2–3 contests, so a skip legitimately opens the
    // NEXT slot (a different id) — what must never happen is the old id coming
    // back, and the day must still end when its quota is spent.
    const c = announceContest(world, T0)!;
    tickTournament(world, c.startsAt); // D6: nobody registered, so it skips

    const next = tickTournament(world, c.startsAt + 1000);
    expect(next?.reason).toBe("announced");
    expect(next?.contest?.id).not.toBe(c.id);
    expect(next?.contest?.id.startsWith(c.id.split("-i")[0])).toBe(true); // same day

    // the second slot skips as well, and `contestsPerDay(0)` is 2 — so the day
    // is over rather than spinning on a third id
    tickTournament(world, next!.contest!.startsAt);
    expect(tickTournament(world, next!.contest!.startsAt + 1000)).toBeNull();

    expect(world.contests!.filter((x) => x.id === c.id)).toHaveLength(1);
    expect(new Set(world.contests!.map((x) => x.id)).size).toBe(world.contests!.length);
  });

  it("resolves a contest down to one as void rather than inventing a winner (D7)", () => {
    // The contest has to *start* with two — D6 would otherwise refuse it — and
    // then one of them produces no evidence at all. That is the only way a
    // voidResult can arise, and it is the case D7 exists for.
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    c.entrants = [ids[0]!, ids[1]!];
    tickTournament(world, c.startsAt);
    // let both contestants actually be sampled for a while…
    for (let i = 0; i < 5; i++) tickTournament(world, c.startsAt + 1000 + i * 1000);
    // …then the second one goes silent, the way an AFK agent would: no rows
    c.samples = c.samples.filter((s) => s.agentId !== ids[1]);
    tickTournament(world, c.endsAt + 1);
    expect(c.state).toBe("resolved");
    expect(c.result!.voidResult).toBe(true);
    expect(c.result!.standings.length).toBe(1);
    expect(c.result!.standings.every((s) => s.score === 0)).toBe(true);
    // the rank is kept for narration even though the points are gone
    expect(c.result!.standings[0]!.rank).toBe(1);
  });

  it("scores the whole window, not the tail the save will keep (08 §11)", () => {
    // The cap is a *persist* budget. Trimming while the contest is live would
    // hand the resolver only the newest rows, and here that flips the winner:
    // `early` owns the first ten ticks and `late` the last ten — an exact tie on
    // metric, broken by earliest arrival in favour of `early`. Keep only the
    // newest 200 of 240 rows and `early` has no venue rows at all, so `late`
    // would take it.
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    c.entrants = [ids[0]!, ids[1]!];
    tickTournament(world, c.startsAt);

    const TICKS = 120;
    for (let i = 0; i < TICKS; i++) {
      const [early, late] = ids;
      world.herd.find((h) => h.id === early!)!.mind.doing.place = i < 10 ? c.place : "tavern";
      world.herd.find((h) => h.id === late!)!.mind.doing.place = i >= TICKS - 10 ? c.place : "tavern";
      tickTournament(world, c.startsAt + (i + 1) * 1000);
    }
    expect(c.samples.length).toBeGreaterThan(CONTEST.persistSamples);

    tickTournament(world, c.endsAt + 1);
    expect(c.result!.standings[0]!.agentId).toBe(ids[0]);
    expect(c.result!.standings[0]!.metric).toBe(10);
    // the save is trimmed only after the verdict
    expect(c.samples.length).toBeLessThanOrEqual(CONTEST.persistSamples);
  });

  it("caps the evidence trail on the save, not on the verdict (08 §11)", () => {
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    for (const id of ids) registerForContest(world, id, T0);
    tickTournament(world, c.startsAt);
    for (let i = 0; i < 200; i++) {
      tickTournament(world, c.startsAt + 1000 + i * 10);
    }
    tickTournament(world, c.endsAt + 1);
    expect(c.samples.length).toBeLessThanOrEqual(CONTEST.persistSamples);
  });
});

describe("forfeits (D5, D7)", () => {
  it("continues without an agent that went AFK, and lists who did not show", () => {
    // The important part: the AFK agent's *resident keeps being simulated* — the
    // sim takes over for absent agents — so it still has rows at the venue and
    // still would have scored. D7 says those points are not theirs to take.
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    // exactly two, so a forfeit leaves one and the result really is a walkover
    c.entrants = [ids[0]!, ids[1]!];
    c.houseEntrant = undefined;
    for (const id of ids) registerForContest(world, id, T0);

    // the agent walks away partway through
    const record = (world.agents ?? []).find((a) => a.residentId === ids[1])!;
    record.lastActAt = T0 - AGENT_AFK_MS - 1000;
    record.lastActAt = T0 - AGENT_AFK_MS - 1000;

    tickTournament(world, c.startsAt);
    for (let i = 0; i < 5; i++) tickTournament(world, c.startsAt + 1000 + i * 1000);

    // the stand-in llama is still walking around and still being sampled
    expect(c.samples.some((s) => s.agentId === ids[1])).toBe(true);

    tickTournament(world, c.endsAt + 1);

    expect(c.state).toBe("resolved");
    // D5: nobody was kicked, the contest still produced a result
    expect(c.entrants).toContain(ids[1]);
    expect(c.result!.standings.map((s) => s.agentId)).not.toContain(ids[1]);
    expect(forfeitingEntrants(world, c, c.endsAt + 1)).toEqual([ids[1]]);
    expect(c.result!.voidResult).toBe(true);
    // D7: the walkover is worth nothing
    expect(c.result!.standings.every((s) => s.score === 0)).toBe(true);
    // and the season board is untouched by it
    expect(world.season!.standings).toEqual([]);
    // the notice names them, because a forfeit that is only a gap in the
    // standings reads as a bug
    const name = world.herd.find((h) => h.id === ids[1])!.name;
    expect(forfeitNotice(world, c, c.endsAt + 1)).toBe(`${name} did not show`);
  });

  it("does not call a bot a forfeiter — it has no agent record to go AFK", () => {
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    for (const id of ids) registerForContest(world, id, T0);
    tickTournament(world, c.startsAt);
    for (let i = 0; i < 5; i++) tickTournament(world, c.startsAt + 1000 + i * 1000);
    tickTournament(world, c.endsAt + 1);
    expect(forfeitingEntrants(world, c, c.endsAt + 1)).toEqual([]);
  });
});

describe("season phases (08 §5, format A)", () => {
  it("goes trials → semifinals → final → champion, then resets", () => {
    const ids = addAgents(SEASON.semifinalists + 2);
    let now = T0;
    // One entry per in-game day that played something: the exact-shape
    // assertion below is a *day* sequence (08 §5), and pushing per contest
    // would emit 2–3 `trials` rows for every trial day.
    const phases: string[] = [];
    // `CHAMPION` and `ROLLED` are milestones, not phases — keeping them in the
    // same array meant the exact-shape assertion below was really asserting
    // that a marker it had just pushed was not there.
    const milestones: string[] = [];
    // snapshot taken at the instant of the rollover, because the loop keeps
    // playing into the *new* season afterwards and that is the correct shape
    let standingsAtRollover: unknown = null;
    let ledgerAtRollover: string[] | undefined;

    // A whole day's slate, not one contest (08 D3, decision 1): a trial day
    // hosts 2–3 contests and the semifinal day hosts *both* semifinals, so a
    // loop that played one per day never got the bracket past its first duel.
    // The quota is what stops the inner loop — `announceContest` returns null
    // once the day is full.
    for (let day = 0; day < SEASON.seasonDays + 1; day++) {
      const before = world.season?.no ?? 1;
      let playedIn: Season["state"] | null = null;
      for (let slot = 0; slot <= CONTEST.perDay.max; slot++) {
        const at = now + slot * SLOT;
        const c = announceContest(world, at);
        if (!c) break;
        // recorded at announce time, because that is the phase the contest
        // actually played in: the resolve that finishes the last trial is what
        // *advances* the phase, so reading it afterwards reports one day late
        playedIn ??= seasonPhase(world.season, at);
        for (const id of ids) if (c.state === "announced") registerForContest(world, id, at);
        tickTournament(world, c.startsAt);
        // give the entrants somewhere to be so the result is not a walkover
        for (let i = 0; i < 8; i++) {
          for (const id of c.entrants) {
            const r = world.herd.find((h) => h.id === id);
            if (r) r.mind.doing.place = i % 3 === 0 ? c.place : "tavern";
          }
          tickTournament(world, c.startsAt + 1000 + i * 1000);
        }
        const done = tickTournament(world, c.endsAt + 1);
        if (done?.champion !== undefined) {
          expect(done.champion).not.toBeNull();
          milestones.push("CHAMPION");
        }
        if ((world.season?.no ?? 1) !== before) {
          // The season changed hands mid-day, so the snapshot has to be taken
          // *here*, at the instant of the rollover — continuing the slot loop
          // would let the next season play a contest into these variables.
          milestones.push("ROLLED");
          standingsAtRollover = JSON.parse(JSON.stringify(world.season!.standings));
          ledgerAtRollover = world.season!.appliedContests;
          break;
        }
      }
      if (playedIn) phases.push(playedIn);
      now += DAY;
      retireResolved(world, now);
    }

    expect(phases).toContain("semifinals");
    expect(phases).toContain("final");
    expect(milestones).toContain("CHAMPION");
    expect(milestones).toContain("ROLLED");
    // and the sequence is exactly the §5 shape, not merely "contains". The loop
    // runs a day past the season, so anything after the final belongs to the
    // next season's trials.
    expect(phases.slice(0, SEASON.trials + 2)).toEqual([
      ...new Array(SEASON.trials).fill("trials"),
      "semifinals",
      "final",
    ]);
    expect(phases.slice(SEASON.trials + 2).every((p) => p === "trials")).toBe(true);
    // the reset is the return hook (D10) — a fresh, empty leaderboard, and the
    // ledger that drives it starts over too or the new season would open
    // already finished
    expect(standingsAtRollover).toEqual([]);
    expect(ledgerAtRollover ?? []).toHaveLength(0);
  });

  it("derives the phase from the ledger, so a save cannot disagree with itself", () => {
    const dayAt = (pos: number) => ((dayOfYear(T0) + pos - 1) % 365) + 1;
    const s = trialStageDone();
    // the stage is in the id (`s` semifinal, `f` final): the ledger says *what*
    // ran, the calendar only says when. Dates alone let late trials be read as
    // bracket results, and a late bracket never be read at all.
    const semi = `ct-s1-d${dayAt(SEASON.trials)}-s0`;
    const fin = `ct-s1-d${dayAt(SEASON.trials + 1)}-f0`;
    const ledger = s.appliedContests ?? [];

    // no results at all: whatever the clock says, nothing has been played
    expect(seasonPhase(createSeason(1, T0), atPos(SEASON.trials))).toBe("trials");
    // trial days played, but the calendar is still inside them
    expect(seasonPhase(s, T0)).toBe("trials");
    // both agree the trials are over and no semifinal has been played
    expect(seasonPhase(s, atPos(SEASON.trials))).toBe("semifinals");
    // a semifinal landed on the semifinal day — but the final has a day of its
    // own (§5), so the bracket holds rather than crowning one afternoon
    expect(seasonPhase({ ...s, appliedContests: [...ledger, semi] }, atPos(SEASON.trials))).toBe(
      "semifinals"
    );
    // the final's day arrives and no final has been played
    expect(seasonPhase({ ...s, appliedContests: [...ledger, semi] }, atPos(SEASON.trials + 1))).toBe(
      "final"
    );
    // the final landed past it, so the season is over
    expect(
      seasonPhase(
        { ...s, appliedContests: [...ledger, semi, fin] },
        atPos(SEASON.trials + 1)
      )
    ).toBe("closed");
  });

  it("reads a legacy ledger as history — never as a bracket it never played", () => {
    // A save from before the stage existed carries `ct-{day}-{index}` ids. They
    // have no stage, so they may count only as *days played*: one of them
    // landing past the bracket days is a trial that ran late, not a final that
    // was played. Off the calendar that id used to say `closed`, and the season
    // crowned the board leader without ever fielding a bracket — the same hole
    // as above, through the other id shape.
    const dayAt = (pos: number) => ((dayOfYear(T0) + pos - 1) % 365) + 1;
    world.season = {
      ...createSeason(1, T0),
      standings: ["q1", "q2", "q3", "q4"].map((agentId, i) => ({
        agentId,
        points: 30 - i * 5,
        wins: 3 - i,
        losses: i,
      })),
      appliedContests: [
        ...Array.from({ length: SEASON.trials }, (_, i) => `ct-${dayAt(i)}-${i}`),
        `ct-${dayAt(SEASON.seasonDays - 1)}-9`, // a trial that ran on day 6
      ],
    };

    expect(seasonPhase(world.season, atPos(SEASON.seasonDays - 1))).toBe("semifinals");

    const first = announceContest(world, atPos(SEASON.seasonDays - 1))!;
    expect(first).not.toBeNull();
    expect(first.id).toMatch(/^ct-s1-d\d+-s\d+$/); // stamped with the stage it runs in
    expect(first.entrants).toEqual(["q1", "q4"]);
  });

  it("runs the bracket even when trial contests landed past the planned bracket day", () => {
    // Late join: the trials only finish on day 6, and the trial contests that
    // happened to land on days 5 and 6 are still *trials*. The phase used to
    // read a season off where its ids sat on the calendar, so those two counted
    // as semifinals, the day-6 one counted as "past the semifinal day", and the
    // season closed with the board leader as champion — top 4 → two semifinals →
    // final skipped in silence. The stage an id ran in is what decides, not its
    // date (08 §5, §15's "no agents join" risk).
    const dayAt = (pos: number) => ((dayOfYear(T0) + pos - 1) % 365) + 1;
    world.season = {
      ...createSeason(1, T0),
      standings: ["q1", "q2", "q3", "q4"].map((agentId, i) => ({
        agentId,
        points: 30 - i * 5,
        wins: 3 - i,
        losses: i,
      })),
      // seven distinct days, two of them on the calendar's bracket days — all
      // of them trial contests (`-i`), which is the point
      appliedContests: [0, 1, 2, 3, 5, 5, 6].map((pos, i) => `ct-s1-d${dayAt(pos)}-i${i}`),
    };

    expect(seasonPhase(world.season, atPos(6))).toBe("semifinals");

    const sf1 = playContestAt(atPos(6));
    expect(sf1).not.toBeNull();
    expect(sf1!.entrants).toEqual(["q1", "q4"]);
    const sf2 = playContestAt(atPos(6) + SLOT);
    expect(sf2).not.toBeNull();
    expect(sf2!.entrants).toEqual(["q2", "q3"]);
    expect(seasonPhase(world.season, atPos(6) + 2 * SLOT)).toBe("final");

    playContestAt(atPos(6) + 2 * SLOT);
    expect(world.season!.no).toBe(2); // the final really did crown someone
    expect(world.season!.champion).toBeTruthy();
  });

  it("does not wedge in the semifinals when the calendar has passed the bracket days", () => {
    // Nobody contested for a week, so the trials only finish on day 7 — past
    // the planned bracket days. `semifinalIds` used to require an id's calendar
    // position to be *exactly* `SEASON.trials`, so a semifinal announced on
    // day 7 was never counted: the phase stayed `semifinals` forever, opening
    // two more a day while `retireResolved` shielded every card — a season that
    // never ends and a save that grows without bound.
    world.season = trialStageDone([
      { agentId: "q1", points: 30, wins: 3, losses: 0 },
      { agentId: "q2", points: 20, wins: 2, losses: 1 },
      { agentId: "q3", points: 15, wins: 1, losses: 2 },
      { agentId: "q4", points: 10, wins: 1, losses: 2 },
    ]);
    const late = atPos(SEASON.seasonDays); // the plan's 7-day window is over
    expect(seasonPhase(world.season, late)).toBe("semifinals");

    expect(playContestAt(late)).not.toBeNull();
    expect(playContestAt(late + SLOT)).not.toBeNull();
    // the bracket makes progress — it is the final's turn, not another semifinal
    expect(seasonPhase(world.season, late + 2 * SLOT)).toBe("final");
  });

  it("refuses a registration once a knockout has fixed its field", async () => {
    // Regression: the bracket is decided by the table, so letting anyone
    // register during a semifinal padded it past SEASON.semifinalists and
    // handed a qualifier's place to whoever registered first.
    world.season = trialStageDone([
      { agentId: "q1", points: 30, wins: 3, losses: 0 },
      { agentId: "q2", points: 20, wins: 2, losses: 1 },
      { agentId: "q3", points: 15, wins: 1, losses: 2 },
      { agentId: "q4", points: 10, wins: 1, losses: 2 },
      { agentId: "outsider", points: 0, wins: 0, losses: 3 },
    ]);
    const outsider = addAgents(1)[0]!;
    const c = announceContest(world, atPos(SEASON.trials))!;
    // Semifinal 1 is seeded 1v4 across the field's ends (08 §5: TWO duels, not
    // one 4-way match) — the fixed field is the qualifiers, and the second duel
    // takes whoever is left.
    expect(c.entrants).toEqual(["q1", "q4"]);

    const out = registerForContest(world, outsider, atPos(SEASON.trials));
    expect(out.ok).toBe(false);
    expect(out.status).toBe(409);
    // the bracket is exactly the seeded pair, un-padded
    expect(c.entrants).toEqual(["q1", "q4"]);
  });

  it("takes the bracket from the top *real* agents, not the top four minus bots", () => {
    // Regression: filtering the bots out of `qualifiers()` *after* it had
    // already truncated to four shrank the field, and a top four containing
    // three bots left a single contender — which tripped D6 and collapsed the
    // season instead of running a semifinal.
    world.season = trialStageDone([
      { agentId: "house-ledger", points: 90, wins: 9, losses: 0 },
      { agentId: "house-wren", points: 80, wins: 8, losses: 1 },
      { agentId: "house-hearth", points: 70, wins: 7, losses: 2 },
      { agentId: "a1", points: 30, wins: 3, losses: 6 },
      { agentId: "a2", points: 25, wins: 2, losses: 7 },
      { agentId: "a3", points: 20, wins: 2, losses: 7 },
      { agentId: "a4", points: 15, wins: 1, losses: 8 },
    ]);
    const c = announceContest(world, atPos(SEASON.trials))!;
    // Seeded 1v4 from the *ends* of the top four real agents. Had the bots
    // survived the truncation the field would be [house-ledger, house-wren,
    // house-hearth, a1] and this duel would open with a bot — which is exactly
    // the shape that used to collapse the season through D6.
    expect(c.entrants).toEqual(["a1", "a4"]);
    expect(c.entrants.some((id) => isHouseAgent(id))).toBe(false);
    // a field of one would have been dropped by D6 and closed the season
    expect(c.entrants.length).toBeGreaterThanOrEqual(CONTEST.minEntrants);
  });

  it("keeps a bot's trial points on the board while closing the bracket to it", () => {
    world.season = trialStageDone([
      { agentId: "a", points: 30, wins: 3, losses: 0 },
      { agentId: "b", points: 20, wins: 2, losses: 1 },
      { agentId: "c", points: 15, wins: 1, losses: 2 },
      { agentId: "d", points: 10, wins: 1, losses: 2 },
      { agentId: "e", points: 5, wins: 0, losses: 3 },
    ]);
    const c = announceContest(world, atPos(SEASON.trials))!;
    // Seeded 1v4 from the top four *real* agents: the bot's points stay on the
    // board, but its id is never part of the bracket.
    expect(c.entrants).toEqual(["a", "d"]);
    expect(c.entrants.some((id) => isHouseAgent(id))).toBe(false);
    expect(c.houseEntrant).toBeUndefined(); // a bot cannot qualify for a final
  });

  it("closes a season that can never be fielded instead of deadlocking", () => {
    // nobody ever contested, so the table is empty and the semifinal cannot
    // reach two entrants — the tournament must not stall there forever
    world.season = trialStageDone();
    const c = announceContest(world, atPos(SEASON.trials));
    expect(c).not.toBeNull();
    const event = tickTournament(world, c!.startsAt)!;
    expect(event.reason).toBe("skipped");
    expect(world.season!.no).toBe(2);
    expect(world.season!.state).toBe("trials");
  });
});

describe("retirement (08 §10.1)", () => {
  it("keeps the last few cards and drops the rest once their moment has passed", () => {
    const ids = addAgents(2);
    let now = T0;
    let resolvedCount = 0;
    for (let i = 0; i < 5; i++) {
      const c = announceContest(world, now)!;
      for (const id of ids) registerForContest(world, id, now);
      tickTournament(world, c.startsAt);
      tickTournament(world, c.endsAt + 1);
      resolvedCount++;
      now += DAY;
      retireResolved(world, now);
    }
    const resolved = world.contests!.filter((c) => c.state === "resolved");
    // never more than the retention window, and at least one was actually
    // dropped rather than merely capped
    expect(resolved.length).toBeLessThanOrEqual(3);
    expect(resolved.length).toBeLessThan(resolvedCount);
    expect(resolved.every((c) => c.result !== undefined)).toBe(true);
  });

  it("keeps a card up for resultCardMs even when there is room to drop it", () => {
    // 08 §10.1 — the card is the moment, and it has to last long enough to be seen
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    for (const id of ids) registerForContest(world, id, T0);
    tickTournament(world, c.startsAt);
    tickTournament(world, c.endsAt + 1);
    expect(c.state).toBe("resolved");

    expect(retireResolved(world, c.endsAt)).toEqual([]);
    expect(world.contests).toContain(c);
    expect(retireResolved(world, c.endsAt + CONTEST.resultCardMs)).toEqual([]);
    // past the window and not among the most recent few, so it goes
    const later = c.endsAt + CONTEST.resultCardMs + 1;
    for (let i = 0; i < 4; i++) {
      world.contests!.push({ ...c, id: `filler-${i}`, state: "resolved", result: c.result });
    }
    expect(retireResolved(world, later)).toContain(c.id);
  });
});

describe("narration (08 §7.1)", () => {
  it("frames a matchup from the relationship record", () => {
    const [a, b] = addAgents(2);
    const line = matchupLine(world, [a!, b!]);
    expect(line).toContain("v");
    expect(line).toContain("never spoken");
    world.herd.find((h) => h.id === a)!.mind.relationships[b!] = -0.9;
    expect(matchupLine(world, [a!, b!])).toContain("old rivals");
    world.herd.find((h) => h.id === a)!.mind.relationships[b!] = 0.8;
    expect(matchupLine(world, [a!, b!])).toContain("old friends");
  });

  it("says nothing rather than inventing a pairing for one entrant", () => {
    const [a] = addAgents(1);
    expect(matchupLine(world, [a!])).toBe("");
  });
});

describe("bookkeeping", () => {
  it("counts the season by its ledger, which survives a JSON round trip", () => {
    const ids = addAgents(2);
    const c = announceContest(world, T0)!;
    for (const id of ids) registerForContest(world, id, T0);
    tickTournament(world, c.startsAt);
    tickTournament(world, c.endsAt + 1);
    const reloaded = JSON.parse(JSON.stringify(world)) as TownSnapshot;
    expect(seasonContestIndex(reloaded.season)).toBe(1);
  });

  it("keeps the house roster to exactly three bodies", () => {
    const before = world.herd.filter((r) => isHouseAgent(r.id)).length;
    ensureHouseResidents(world);
    expect(before).toBe(3);
    expect(world.herd.filter((r) => isHouseAgent(r.id)).length).toBe(3);
    expect(HOUSE_AGENT_IDS).toHaveLength(3);
  });
});
