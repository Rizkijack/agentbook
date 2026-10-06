import { describe, it, expect } from "vitest";
import { CONTEST, SEASON, pointsForRank, type ContestResult, type ContestSample, type Season } from "@slopagentbook/shared";
import { scoreContest } from "../src/contest.js";
import {
  applyContestResult,
  createSeason,
  qualifiers,
  rankStandings,
  rollSeason,
} from "../src/season.js";

/**
 * Season standings and rollover (08 §13, `contest-season.test.ts` row).
 *
 * Fixtures only — the season layer is pure, so none of this needs a running
 * sim. The last suite deliberately feeds it the *real* `scoreContest` output
 * instead of hand-written numbers, because the two layers are only worth
 * anything if they agree.
 */

const TICK = 1800; // backend TURN_MS
const T0 = 1_700_000_000_000;
const at = (tick: number) => T0 + tick * TICK;

/** A resolved contest with `order` as the finishing order. */
function result(order: readonly string[], voidResult = false): ContestResult {
  return {
    standings: order.map((agentId, i) => ({
      agentId,
      rank: i + 1,
      score: pointsForRank(i + 1),
      metric: order.length - i,
      detail: "fixture",
    })),
    voidResult,
    resolvedAt: T0,
  };
}

const ids = (season: Season) => rankStandings(season).map((r) => r.agentId);
const board = (season: Season) => Object.fromEntries(rankStandings(season).map((r) => [r.agentId, r.points]));
const row = (season: Season, agentId: string) => rankStandings(season).find((r) => r.agentId === agentId)!;

// ---------------------------------------------------------------------------

describe("createSeason", () => {
  it("opens in the trials with an empty board", () => {
    const s = createSeason(1, T0);
    expect(s).toEqual({ id: "s1", no: 1, startedAt: T0, state: "trials", standings: [] });
  });

  it("carries the index and the clock it was opened with", () => {
    const s = createSeason(7, T0 + 5000);
    expect(s.no).toBe(7);
    expect(s.startedAt).toBe(T0 + 5000);
  });
});

// ---------------------------------------------------------------------------

describe("format A end to end (08 §5, §13)", () => {
  const ROSTER = ["hux", "tux", "vetch", "pip"] as const;
  // One winner per trial CONTEST, as an index into the roster. Ten of them =
  // `SEASON.trials` days × `CONTEST.perDay.min`, i.e. the *shortest* season the
  // cadence can produce (a day hosts 2–3 contests, decision 1 / 08 D3).
  const WINNERS = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1];
  /** 4-entrant contest, winner first, then the rest of the roster in order */
  const order = (k: number) => [
    ROSTER[k % ROSTER.length],
    ROSTER[(k + 1) % ROSTER.length],
    ROSTER[(k + 2) % ROSTER.length],
    ROSTER[(k + 3) % ROSTER.length],
  ];

  /** the whole trial stage, folded in through the one public entry point */
  function playTrials(): Season {
    let season = createSeason(1, T0);
    // over the fixture, not `SEASON.trials`: since decision 1 a trial *day*
    // hosts 2–3 contests and the ledger accumulates per contest
    for (let day = 0; day < WINNERS.length; day++) {
      season = applyContestResult(
        season,
        result(order(WINNERS[day])),
        { contestId: `trial-${day + 1}`, kind: "gather_at" }
      );
    }
    return season;
  }

  it("runs SEASON.trials trial days of CONTEST.perDay.min contests each", () => {
    // guards the fixture itself: the table is exactly the shortest season the
    // format allows, so a cadence change fails here first
    expect(WINNERS).toHaveLength(SEASON.trials * CONTEST.perDay.min);
  });

  it("accumulates 10 / 5 / 1 / 0 per contest into a season table", () => {
    // winner counts: hux 3, tux 3, vetch 2, pip 2
    // hux: 3x10 + 0 + 2x1 + 2x5 = 42      tux: 3x5 + 3x10 + 0 + 2x1 = 47
    // vetch: 3x1 + 3x5 + 2x10 + 0 = 38    pip: 0 + 3x1 + 2x5 + 2x10 = 33
    expect(board(playTrials())).toEqual({ tux: 47, hux: 42, vetch: 38, pip: 33 });
  });

  it("counts one win or one loss per contest", () => {
    const s = playTrials();
    // losses are "contests contested minus wins": ten trials, not five
    expect(row(s, "hux")).toMatchObject({ points: 42, wins: 3, losses: WINNERS.length - 3 });
    expect(row(s, "pip")).toMatchObject({ points: 33, wins: 2, losses: WINNERS.length - 2 });
  });

  it("sends exactly the top SEASON.semifinalists on to the semis", () => {
    const q = qualifiers(playTrials());
    expect(q).toHaveLength(SEASON.semifinalists);
    expect(q.map((r) => r.agentId)).toEqual(["tux", "hux", "vetch", "pip"]);
  });

  it("crowns the champion of trials + semifinals + final", () => {
    let s = playTrials();
    // top 4 → 2 semifinals (08 §5). `qualifiers` is the season's top-N, not a
    // bracket, so the bracket is the schedule's to pair up: seed 1v4, 2v3.
    const [t1, t2, t3, t4] = qualifiers(s).map((r) => r.agentId);
    s = applyContestResult(s, result([t1, t4]), { contestId: "sf-1", kind: "hold_ground" });
    s = applyContestResult(s, result([t2, t3]), { contestId: "sf-2", kind: "hold_ground" });
    const [f1, f2] = [t1, t2]; // the two semifinal winners
    s = applyContestResult(s, result([f1, f2]), { contestId: "final-1", kind: "tend_project" });

    // tux 47 +10 (sf) +10 (final) = 67 · hux 42 +10 (sf) +5 (final) = 57
    // vetch 38 +5 (sf) = 43        · pip 33 +5 (sf) = 38
    expect(board(s)).toEqual({ tux: 67, hux: 57, vetch: 43, pip: 38 });
    const { season: next, champion } = rollSeason(s, T0 + 999);
    // 5 of tux's 12 contests were wins (10 trials + 2 knockouts); the 5 trial
    // losses came from the round robin, none from the knockout rounds
    expect(champion).toMatchObject({
      agentId: "tux",
      points: 67,
      wins: 5,
      losses: WINNERS.length - 3,
    });
    // the reset is the whole return hook (08 §5, D10)
    expect(next.no).toBe(2);
    expect(next.standings).toEqual([]);
    expect(rankStandings(next)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("void results are worth nothing (D7, 08 §4.3)", () => {
  it("awards no points and no win, even though the standings name a winner", () => {
    let s = createSeason(1, T0);
    s = applyContestResult(s, result(["hux", "tux"]), { contestId: "c1", kind: "gather_at" });
    // tux "wins" by forfeit: the contest is narrated, the season is not moved
    s = applyContestResult(s, result(["tux"], true), { contestId: "c2", kind: "gather_at" });

    // tux is still on 5 points from c1: the forfeit win is narrated, not banked
    expect(row(s, "tux")).toMatchObject({ points: 5, wins: 0, losses: 1 });
    expect(ids(s)).toEqual(["hux", "tux"]);
    expect(board(s)).toEqual({ hux: 10, tux: 5 });
  });

  it("keeps an agent that only ever won void contests off the leaderboard", () => {
    // a row of zeros says nothing about the agent, and noise on the board
    // pushes the real contenders off the screen
    let s = createSeason(1, T0);
    s = applyContestResult(s, result(["hux", "tux"]), { contestId: "c1", kind: "gather_at" });
    s = applyContestResult(s, result(["solo"], true), { contestId: "c2", kind: "endure" });

    expect(ids(s)).toEqual(["hux", "tux"]);
    expect(s.standings.some((r) => r.agentId === "solo")).toBe(false);
  });

  it("leaves an un-contested season with no champion", () => {
    const s = applyContestResult(createSeason(1, T0), { standings: [], voidResult: true, resolvedAt: T0 }, { contestId: "c1", kind: "endure" });
    expect(rollSeason(s, T0 + 1).champion).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("idempotency per contest id", () => {
  const applyTwice = (season: Season, contestId: string) => {
    const r = result(["hux", "tux", "vetch"]);
    const first = applyContestResult(season, r, { contestId, kind: "gather_at" });
    return { first, second: applyContestResult(first, r, { contestId, kind: "gather_at" }) };
  };

  it("returns the season untouched when a contest is replayed", () => {
    const { first, second } = applyTwice(createSeason(1, T0), "c1");
    expect(second).toBe(first); // not merely deep-equal: nothing happened
  });

  it("does not double the points, the wins or the losses", () => {
    const { second } = applyTwice(createSeason(1, T0), "c1");
    expect(board(second)).toEqual({ hux: 10, tux: 5, vetch: 1 });
    expect(second.standings.map((r) => [r.wins, r.losses])).toEqual([
      [1, 0],
      [0, 1],
      [0, 1],
    ]);
  });

  it("replays a void resolution as a no-op too", () => {
    const r = result(["hux", "tux"]);
    const first = applyContestResult(createSeason(1, T0), r, { contestId: "c1", kind: "gather_at" });
    const voided = applyContestResult(first, result(["tux"], true), { contestId: "c2", kind: "gather_at" });
    const again = applyContestResult(voided, result(["tux"], true), { contestId: "c2", kind: "gather_at" });
    expect(again).toBe(voided);
    expect(board(again)).toEqual({ hux: 10, tux: 5 });
  });

  it("still holds after a save/load round trip — the restart case", () => {
    // the whole point of keeping the ledger on the season: a module-level
    // cache is empty after a restart, and that is exactly when the duplicate
    // would slip through and hand out points twice
    const { first } = applyTwice(createSeason(1, T0), "c1");
    const reloaded = JSON.parse(JSON.stringify(first)) as Season;
    const replayed = applyContestResult(reloaded, result(["hux", "tux", "vetch"]), { contestId: "c1", kind: "gather_at" });
    expect(replayed).toBe(reloaded);
    expect(board(replayed)).toEqual({ hux: 10, tux: 5, vetch: 1 });
  });

  it("ignores a duplicated standing inside one result", () => {
    const doubled: ContestResult = {
      standings: [
        { agentId: "hux", rank: 1, score: 10, metric: 3, detail: "fixture" },
        { agentId: "hux", rank: 2, score: 5, metric: 2, detail: "fixture" },
      ],
      voidResult: false,
      resolvedAt: T0,
    };
    const s = applyContestResult(createSeason(1, T0), doubled, { contestId: "c1", kind: "gather_at" });
    expect(row(s, "hux")).toMatchObject({ points: 10, wins: 1, losses: 0 });
  });

  it("never mutates the season it was given", () => {
    const before = createSeason(1, T0);
    const snapshot = JSON.parse(JSON.stringify(before));
    const after = applyContestResult(before, result(["hux", "tux"]), { contestId: "c1", kind: "gather_at" });
    expect(before).toEqual(snapshot);
    expect(after).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe("rankStandings is a total, reproducible order", () => {
  it("breaks a points tie on wins, not on the id", () => {
    // 11 points each: zed took a win and a third, ape two seconds and a third
    // — but "ape" sorts before "zed" by codepoint, so only the wins rule can
    // put zed in front
    const days = [
      result(["zed", "f1", "f2", "f3"]), // zed 10 (win) · f1 5 · f2 1 · f3 0
      result(["f1", "ape", "zed", "f3"]), // f1 10 · ape 5 · zed 1 · f3 0
      result(["f1", "ape", "f4", "f5"]), // f1 10 · ape 5 · f4 1 · f5 0
      result(["f2", "f4", "ape", "f3"]), // f2 10 · f4 5 · ape 1 · f3 0
    ];
    let s = createSeason(1, T0);
    days.forEach((r, i) => {
      s = applyContestResult(s, r, { contestId: `c${i}`, kind: "gather_at" });
    });

    expect(row(s, "zed")).toMatchObject({ points: 11, wins: 1, losses: 1 });
    expect(row(s, "ape")).toMatchObject({ points: 11, wins: 0, losses: 3 });
    // the fillers really do beat the tie, so this is a 3rd/4th-place decider
    expect(ids(s).slice(0, 2)).toEqual(["f1", "f2"]);
    expect(ids(s).indexOf("zed")).toBeLessThan(ids(s).indexOf("ape"));
  });

  it("falls back to plain codepoint order, not locale collation", () => {
    // "a" and "B" are exactly the pair localeCompare and codepoint order
    // disagree on: collation says a-before-B, codepoint says B (0x42) before
    // a (0x61). The codepoint answer is the reproducible one.
    let s = createSeason(1, T0);
    s = applyContestResult(s, result(["a", "B"]), { contestId: "c1", kind: "gather_at" });
    s = applyContestResult(s, result(["B", "a", "c"]), { contestId: "c2", kind: "gather_at" });

    expect(row(s, "a")).toMatchObject({ points: 15, wins: 1, losses: 1 });
    expect(row(s, "B")).toMatchObject({ points: 15, wins: 1, losses: 1 });
    expect(ids(s).slice(0, 2)).toEqual(["B", "a"]);
  });

  it("gives the same board whatever order the rows arrive in", () => {
    const play = () => {
      let s = createSeason(1, T0);
      s = applyContestResult(s, result(["hux", "tux", "vetch"]), { contestId: "c1", kind: "gather_at" });
      s = applyContestResult(s, result(["tux", "hux", "vetch"]), { contestId: "c2", kind: "gather_at" });
      return s;
    };
    const s = play();
    const shuffled: Season = { ...s, standings: [...s.standings].reverse() };
    expect(ids(shuffled)).toEqual(ids(s));
  });

  it("hides rows that contested nothing", () => {
    const s: Season = {
      ...createSeason(1, T0),
      standings: [
        { agentId: "ghost", points: 0, wins: 0, losses: 0 },
        { agentId: "hux", points: 10, wins: 1, losses: 0 },
      ],
    };
    expect(ids(s)).toEqual(["hux"]);
  });

  it("hands out copies, so a caller cannot corrupt the season through the board", () => {
    const s = applyContestResult(createSeason(1, T0), result(["hux", "tux"]), { contestId: "c1", kind: "gather_at" });
    const board = rankStandings(s);
    board[0].points = 999;
    board.sort(() => 0);
    expect(row(s, "hux").points).toBe(10);
    expect(s.standings[0]).not.toBe(board[0]);
  });
});

// ---------------------------------------------------------------------------

describe("qualifiers", () => {
  const six = () => {
    const rows = ["a", "b", "c", "d", "e", "f"].map((agentId, i) => ({
      agentId,
      points: 60 - i * 7,
      wins: 3 - i,
      losses: 1,
    }));
    return { ...createSeason(1, T0), standings: rows };
  };

  it("returns the top SEASON.semifinalists of a crowded season, in rank order", () => {
    const q = qualifiers(six());
    expect(SEASON.semifinalists).toBe(4);
    expect(q.map((r) => r.agentId)).toEqual(["a", "b", "c", "d"]);
  });

  it("returns everybody when the season is smaller than the bracket", () => {
    const s: Season = {
      ...createSeason(1, T0),
      standings: [
        { agentId: "a", points: 10, wins: 1, losses: 0 },
        { agentId: "b", points: 5, wins: 0, losses: 1 },
      ],
    };
    expect(qualifiers(s).map((r) => r.agentId)).toEqual(["a", "b"]);
  });

  it("returns nobody when nobody contested", () => {
    expect(qualifiers(createSeason(1, T0))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("rollSeason", () => {
  const played = () =>
    applyContestResult(createSeason(1, T0), result(["hux", "tux"]), { contestId: "c1", kind: "gather_at" });

  it("opens the next season empty, on a new clock", () => {
    const { season } = rollSeason(played(), T0 + 60_000);
    expect(season).toEqual({ id: "s2", no: 2, startedAt: T0 + 60_000, state: "trials", standings: [] });
  });

  it("names the leader of the final board as champion", () => {
    const { champion } = rollSeason(played(), T0 + 1);
    expect(champion).toEqual({ agentId: "hux", points: 10, wins: 1, losses: 0 });
  });

  it("has no champion when the season was never played", () => {
    expect(rollSeason(createSeason(3, T0), T0 + 1).champion).toBeNull();
  });

  it("leaves the season it closed completely alone", () => {
    const s = played();
    const snapshot = JSON.parse(JSON.stringify(s));
    const { season } = rollSeason(s, T0 + 60_000);

    expect(s).toEqual(snapshot);
    expect(season).not.toBe(s);
    expect(s.no).toBe(1);
    expect(s.standings).toHaveLength(2);
  });

  it("does not hand the new season the old season's ledger", () => {
    const { season } = rollSeason(played(), T0 + 1);
    // a rolled season starts clean: a contest id from season 1 can be
    // legitimately re-used in season 2
    const next = applyContestResult(season, result(["hux", "tux"]), { contestId: "c1", kind: "gather_at" });
    expect(board(next)).toEqual({ hux: 10, tux: 5 });
  });
});

// ---------------------------------------------------------------------------

describe("composes with the real resolver (08 §4.3)", () => {
  const sample = (agentId: string, tick: number, place: string, o: { spit?: boolean; spirits?: number } = {}): ContestSample => ({
    t: at(tick),
    agentId,
    place,
    spirits: o.spirits ?? 0.5,
    wasSpit: o.spit ?? false,
  });

  it("credits the exact points scoreContest awarded, across objectives", () => {
    const expected = new Map<string, number>();
    let s = createSeason(1, T0);

    const play = (kind: Parameters<typeof scoreContest>[0]["kind"], place: string, entrants: string[], samples: ContestSample[], id: string) => {
      const r = scoreContest({ kind, place, entrants, samples, resolvedAt: at(9) });
      for (const st of r.standings) {
        expect(st.score).toBe(r.voidResult ? 0 : pointsForRank(st.rank));
        expected.set(st.agentId, (expected.get(st.agentId) ?? 0) + pointsForRank(st.rank));
      }
      s = applyContestResult(s, r, { contestId: id, kind });
    };

    // gather_at — presence at the square
    play(
      "gather_at",
      "square",
      ["hux", "tux", "vetch", "pip"],
      [
        ...[0, 1, 2, 3, 4].map((t) => sample("hux", t, "square")),
        ...[0, 1, 2, 3].map((t) => sample("tux", t, "square")),
        ...[0, 1, 2].map((t) => sample("vetch", t, "square")),
        ...[0, 1].map((t) => sample("pip", t, "square")),
      ],
      "c1"
    );

    // hold_ground — a alone at the pond from tick 1 on
    play(
      "hold_ground",
      "pond",
      ["a", "b", "c"],
      [
        sample("a", 0, "pond"),
        sample("c", 0, "pond"),
        sample("b", 0, "square"),
        sample("a", 1, "pond"),
        sample("b", 1, "square"),
        sample("a", 2, "pond"),
        sample("b", 2, "square"),
      ],
      "c2"
    );

    // endure — never spat on
    play(
      "endure",
      "square",
      ["x", "y", "z"],
      [
        sample("x", 0, "square", { spirits: 0.5 }),
        sample("x", 1, "square", { spirits: 0.6 }),
        sample("y", 0, "square", { spit: true }),
        sample("y", 1, "square"),
        sample("z", 0, "square", { spirits: 0.5 }),
        sample("z", 1, "square", { spirits: 0.4 }),
      ],
      "c3"
    );

    // the season table is exactly the sum of what the resolver awarded
    expect(board(s)).toEqual(Object.fromEntries(expected));

    // c1: 10/5/1/0   c2: a 10, c 5, b 1   c3: x 10, z 5, y 1
    expect(board(s)).toEqual({
      a: 10, hux: 10, x: 10,
      c: 5, tux: 5, z: 5,
      b: 1, vetch: 1, y: 1,
      pip: 0,
    });
    // points, then wins, then codepoint — a total order, so a single champion
    expect(ids(s).slice(0, 3)).toEqual(["a", "hux", "x"]);
    expect(qualifiers(s).map((r) => r.agentId)).toEqual(["a", "hux", "x", "c"]);
    expect(rollSeason(s, T0 + 1).champion).toEqual({ agentId: "a", points: 10, wins: 1, losses: 0 });
  });

  it("takes nothing from a contest the resolver declared void", () => {
    // one contestant still standing → narrated win, zero season points
    const r = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants: ["solo", "gone"],
      samples: [sample("solo", 0, "pond"), sample("solo", 1, "pond")],
      resolvedAt: at(2),
    });
    expect(r.voidResult).toBe(true);
    expect(r.standings).toHaveLength(1);
    expect(r.standings[0]).toMatchObject({ agentId: "solo", rank: 1, score: 0 });

    const s = applyContestResult(createSeason(1, T0), r, { contestId: "c1", kind: "hold_ground" });
    expect(rankStandings(s)).toEqual([]);
  });

  it("still totals the season when a void contest sits between two real ones", () => {
    const played = (s: Season, id: string, order: string[]) =>
      applyContestResult(s, result(order), { contestId: id, kind: "gather_at" });

    let s = played(createSeason(1, T0), "c1", ["hux", "tux", "vetch"]);
    s = applyContestResult(s, result(["vetch"], true), { contestId: "c2", kind: "gather_at" });
    s = played(s, "c3", ["tux", "vetch", "hux"]);

    expect(board(s)).toEqual({ tux: 15, hux: 11, vetch: 6 });
    expect(row(s, "vetch")).toMatchObject({ wins: 0, losses: 2 }); // no win from the void day
  });
});
