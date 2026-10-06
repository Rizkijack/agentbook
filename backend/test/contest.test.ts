import { describe, it, expect } from "vitest";
import { CONTEST } from "@hermesbook/shared";
import type { ContestSample } from "@hermesbook/shared";
import { canStart, hasRoom, scoreContest, takeSamples, trimSamples } from "../src/contest.js";

/**
 * Fixtures only — no running sim (08 §4.1, §13). Every assertion below is a
 * claim from 08 §4.2/§4.3 that must stay true: if one of these goes red, the
 * leaderboard is lying to the people competing in it.
 */

const TICK = 1800; // backend TURN_MS — 180s window / 1800ms = 100 ticks
const T0 = 1_700_000_000_000;
const at = (tick: number) => T0 + tick * TICK;

function sample(
  agentId: string,
  tick: number,
  place: string,
  o: { spit?: boolean; spirits?: number } = {}
): ContestSample {
  return {
    t: at(tick),
    agentId,
    place,
    spirits: o.spirits ?? 0.5,
    wasSpit: o.spit ?? false,
  };
}

const ranks = (r: { standings: Array<{ agentId: string; rank: number }> }) =>
  r.standings.map((s) => s.agentId);
const scores = (r: { standings: Array<{ agentId: string; score: number }> }) =>
  Object.fromEntries(r.standings.map((s) => [s.agentId, s.score]));

describe("takeSamples (08 §4.1)", () => {
  const lookup = {
    place: (id: string) => (id === "gone" ? null : id === "hux" ? "square" : "pond"),
    spirits: () => 0.4,
    spatThisTick: ["hux"],
  };

  it("emits one row per contestant per tick", () => {
    expect(takeSamples(at(3), ["hux", "tux"], lookup)).toHaveLength(2);
  });

  it("emits double rows for a duplicated roster — the guard belongs upstream", () => {
    // pinning the raw behaviour so `scoreContest` is where dedup must live
    expect(takeSamples(at(3), ["hux", "hux"], lookup)).toHaveLength(2);
  });

  it("records place, spirits and whether this contestant was spat on", () => {
    const [row] = takeSamples(at(3), ["hux"], lookup);
    expect(row).toEqual({ t: at(3), agentId: "hux", place: "square", spirits: 0.4, wasSpit: true });
  });

  it("drops contestants that are no longer simulated — no placeholder row", () => {
    const rows = takeSamples(at(3), ["gone", "tux"], lookup);
    expect(rows.map((r) => r.agentId)).toEqual(["tux"]);
  });
});

describe("gather_at (08 §4.2)", () => {
  const samples = [
    ...["hux", "tux", "vetch"].map((id) => sample(id, 0, "square")),
    sample("pip", 0, "pond"),
    ...["hux", "tux"].map((id) => sample(id, 1, "square")),
    sample("vetch", 1, "pond"),
    sample("hux", 2, "square"),
    sample("hux", 3, "square"),
  ];
  const entrants = ["hux", "tux", "vetch", "pip"];

  it("ranks by ticks spent at the target", () => {
    const r = scoreContest({ kind: "gather_at", place: "square", entrants, samples, resolvedAt: at(4) });
    expect(ranks(r)).toEqual(["hux", "tux", "vetch", "pip"]);
  });

  it("awards 10 / 5 / 1 / 0 by rank", () => {
    const r = scoreContest({ kind: "gather_at", place: "square", entrants, samples, resolvedAt: at(4) });
    expect(scores(r)).toEqual({ hux: 10, tux: 5, vetch: 1, pip: 0 });
  });

  it("keeps an entrant that showed up but never claimed the objective", () => {
    const r = scoreContest({ kind: "gather_at", place: "square", entrants, samples, resolvedAt: at(4) });
    const pip = r.standings.find((s) => s.agentId === "pip")!;
    expect(pip.metric).toBe(0);
    expect(pip.detail).toContain("present but never reached");
    // four contestants still standing → a real contest, not a walkover
    expect(r.voidResult).toBe(false);
  });

  it("carries evidence the Daily Spit can quote", () => {
    const r = scoreContest({ kind: "gather_at", place: "square", entrants, samples, resolvedAt: at(4) });
    expect(r.standings[0].detail).toContain("square");
    expect(r.standings[0].detail).toContain("4 of");
  });
});

describe("tiebreaks (08 §4.2)", () => {
  it("breaks equal scores by earliest arrival at the target", () => {
    const samples = [
      sample("zzz", 0, "square"),
      sample("zzz", 1, "square"),
      sample("aaa", 2, "square"),
      sample("aaa", 3, "square"),
      // both attended the full window, so participation cannot separate them
      sample("zzz", 2, "pond"),
      sample("zzz", 3, "pond"),
      sample("aaa", 0, "pond"),
      sample("aaa", 1, "pond"),
    ];
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["aaa", "zzz"],
      samples,
      resolvedAt: at(4),
    });
    expect(ranks(r)).toEqual(["zzz", "aaa"]);
  });

  it("breaks tend_project ties by total attendance (its spec tiebreak)", () => {
    const samples = [
      // both first at the target on tick 0, both there twice
      sample("zzz", 0, "square"),
      sample("zzz", 1, "square"),
      sample("zzz", 2, "pond"),
      sample("zzz", 3, "pond"),
      sample("aaa", 0, "square"),
      sample("aaa", 1, "square"),
      // aaa attended only two of four ticks
    ];
    const r = scoreContest({
      kind: "tend_project",
      place: "square",
      entrants: ["aaa", "zzz"],
      samples,
      resolvedAt: at(4),
    });
    expect(ranks(r)).toEqual(["zzz", "aaa"]);
  });

  it("hands gather_at to the earlier arrival, even when out-attended (08 §4.2)", () => {
    // `a` got there two ticks sooner; `b` merely attended more. The spec gives
    // gather_at exactly one tiebreak — earliest arrival — so `a` must win even
    // though `b` has the busier record.
    const samples = [
      sample("a", 0, "square"),
      sample("a", 1, "square"),
      sample("b", 2, "square"),
      sample("b", 3, "square"),
      sample("b", 0, "pond"),
      sample("b", 1, "pond"),
      sample("b", 4, "pond"),
    ];
    const entrants = ["a", "b"];

    const gather = scoreContest({ kind: "gather_at", place: "square", entrants, samples, resolvedAt: at(5) });
    expect(ranks(gather)).toEqual(["a", "b"]);

    // the same fixture under tend_project reverses, because its tiebreak IS attendance
    const tend = scoreContest({ kind: "tend_project", place: "square", entrants, samples, resolvedAt: at(5) });
    expect(ranks(tend)).toEqual(["b", "a"]);
  });

  it("falls back to agent id so a tie never depends on array order", () => {
    const samples = ["bbb", "aaa"].map((id) => [sample(id, 0, "square"), sample(id, 1, "square")]).flat();
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["bbb", "aaa"],
      samples,
      resolvedAt: at(4),
    });
    expect(ranks(r)).toEqual(["aaa", "bbb"]);
  });
});

describe("hold_ground breaks runs across empty ticks (regression)", () => {
  it("does not join two separate spells into one continuous hold", () => {
    // `a` holds tick 0, the pond sits empty for three ticks, `a` holds tick 4.
    // Longest consecutive run is 1, not 2 — the empty ticks happened.
    const samples = [
      sample("a", 0, "pond"),
      sample("a", 1, "square"),
      sample("a", 2, "square"),
      sample("a", 3, "square"),
      sample("a", 4, "pond"),
      sample("b", 0, "square"),
      sample("b", 1, "square"),
      sample("b", 2, "square"),
      sample("b", 3, "square"),
      sample("b", 4, "square"),
    ];
    const r = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants: ["a", "b"],
      samples,
      resolvedAt: at(5),
    });
    const a = r.standings.find((s) => s.agentId === "a")!;
    expect(a.metric).toBe(1);
    expect(a.detail).toContain("1 of 2 solo");
  });

  it("stays order-independent over an irregular tick trail", () => {
    const samples = [
      sample("a", 0, "pond"),
      sample("a", 1, "square"),
      sample("a", 4, "pond"),
      sample("a", 5, "pond"),
      sample("b", 2, "pond"),
      sample("b", 3, "pond"),
    ];
    const entrants = ["a", "b"];
    const a = scoreContest({ kind: "hold_ground", place: "pond", entrants, samples, resolvedAt: at(6) });
    const b = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants,
      samples: [...samples].reverse(),
      resolvedAt: at(6),
    });
    expect(b).toEqual(a);
  });
});

describe("hold_ground (08 §4.2)", () => {
  // pond occupied by exactly one contestant at a time, except nobody
  const samples = [
    ...[0, 1, 2, 3].map((t) => sample("a", t, "pond")),
    ...[4, 5, 6, 10, 11].map((t) => sample("c", t, "pond")),
    ...[7, 8, 9].map((t) => sample("b", t, "pond")),
    // d shows up, but never at the pond
    sample("d", 0, "square"),
    sample("d", 1, "square"),
    sample("d", 2, "square"),
    sample("d", 3, "square"),
    sample("d", 4, "square"),
    sample("d", 5, "square"),
    sample("d", 6, "square"),
    sample("d", 7, "square"),
    sample("d", 8, "square"),
    sample("d", 9, "square"),
    sample("d", 10, "square"),
    sample("d", 11, "square"),
  ];
  const entrants = ["a", "b", "c", "d"];

  it("rewards the longest unbroken spell alone", () => {
    const r = scoreContest({ kind: "hold_ground", place: "pond", entrants, samples, resolvedAt: at(12) });
    // a held 4 straight; c held 3+2; b held 3 straight
    expect(ranks(r)).toEqual(["a", "c", "b", "d"]);
  });

  it("uses total time held to separate equal longest runs", () => {
    const r = scoreContest({ kind: "hold_ground", place: "pond", entrants, samples, resolvedAt: at(12) });
    expect(r.standings[1].agentId).toBe("c");
    expect(r.standings[1].metric).toBe(3); // longest run
    expect(r.standings[1].detail).toContain("3 of 5 solo");
    expect(r.standings[2].metric).toBe(3);
    expect(r.standings[2].detail).toContain("3 of 3 solo");
  });

  it("does not count a shared tick as anyone holding alone", () => {
    const contested = [
      sample("a", 0, "pond"),
      sample("b", 0, "pond"), // two of them — nobody holds
      sample("a", 1, "square"),
      sample("b", 1, "square"),
    ];
    const r = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants: ["a", "b"],
      samples: contested,
      resolvedAt: at(2),
    });
    // both showed up at the pond, so both still stand — neither held it
    expect(r.voidResult).toBe(false);
    expect(r.standings.every((s) => s.metric === 0)).toBe(true);
  });
});

describe("tend_project (08 §4.2)", () => {
  const samples = [
    ...[0, 1, 2].map((t) => sample("ledger", t, "hall")),
    sample("wren", 0, "square"),
    sample("wren", 1, "hall"),
    sample("hearth", 0, "square"),
    sample("hearth", 1, "square"),
  ];
  it("ranks by presence at a civic site", () => {
    const r = scoreContest({
      kind: "tend_project",
      place: "hall",
      entrants: ["ledger", "wren", "hearth"],
      samples,
      resolvedAt: at(3),
    });
    expect(ranks(r)).toEqual(["ledger", "wren", "hearth"]);
    expect(r.standings[0].detail).toContain("on duty at");
  });
});

describe("endure (08 §4.2)", () => {
  it("ranks survivors above anyone spat on", () => {
    const samples = [
      sample("a", 0, "square", { spirits: 0.5 }),
      sample("a", 1, "square", { spirits: 0.6 }),
      sample("b", 0, "square", { spirits: 0.5 }),
      sample("b", 1, "square", { spirits: 0.7 }),
      sample("c", 0, "square", { spit: true, spirits: 0.5 }),
      sample("c", 1, "square", { spirits: 0.4 }),
    ];
    const r = scoreContest({
      kind: "endure",
      place: "square",
      entrants: ["a", "b", "c"],
      samples,
      resolvedAt: at(2),
    });
    // a and b both survived; b held composure better, so b takes it
    expect(ranks(r)).toEqual(["b", "a", "c"]);
    expect(scores(r)).toEqual({ b: 10, a: 5, c: 1 });
  });

  it("scores survivors at metric 1 and the spat-on at 0", () => {
    const samples = [
      sample("a", 0, "square"),
      sample("b", 0, "square", { spit: true }),
    ];
    const r = scoreContest({ kind: "endure", place: "square", entrants: ["a", "b"], samples, resolvedAt: at(1) });
    expect(r.standings.map((s) => s.metric)).toEqual([1, 0]);
    expect(r.standings.find((s) => s.agentId === "a")!.detail).toContain("never spat on");
    expect(r.standings.find((s) => s.agentId === "b")!.detail).toContain("spat on 1×");
  });
});

describe("void results (D7, 08 §4.3)", () => {
  it("declares no winner when the roster itself is empty", () => {
    const r = scoreContest({ kind: "gather_at", place: "square", entrants: [], samples: [], resolvedAt: 1 });
    expect(r.standings).toEqual([]);
    expect(r.voidResult).toBe(true);
  });

  it("declares no winner when nobody produced evidence", () => {
    const r = scoreContest({ kind: "gather_at", place: "square", entrants: ["a", "b"], samples: [], resolvedAt: 1 });
    expect(r.standings).toEqual([]);
    expect(r.voidResult).toBe(true);
  });

  it("awards zero points to a solo walkover, but keeps the rank for narration", () => {
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["a", "b"],
      samples: [sample("a", 0, "square"), sample("a", 1, "square")],
      resolvedAt: at(2),
    });
    expect(r.voidResult).toBe(true);
    expect(r.standings).toHaveLength(1);
    expect(r.standings[0].rank).toBe(1);
    expect(r.standings[0].score).toBe(0);
    expect(r.standings[0].detail).toContain("square");
  });

  it("ranks an entrant that turned up but claimed nothing last — not as unranked", () => {
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["a", "b"],
      samples: [sample("a", 0, "square"), sample("b", 0, "pond")],
      resolvedAt: at(1),
    });
    expect(r.voidResult).toBe(false);
    // b did show up, so it stands and takes 2nd — only the rank-3 slot drops to 0
    expect(scores(r)).toEqual({ a: 10, b: 5 });
    expect(r.standings[1].metric).toBe(0);
  });

  it("does not let a duplicated roster inflate the standings", () => {
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["a", "b", "a"],
      samples: [sample("a", 0, "square"), sample("b", 0, "square")],
      resolvedAt: at(1),
    });
    expect(r.standings).toHaveLength(2);
    expect(new Set(ranks(r)).size).toBe(2);
    expect(r.voidResult).toBe(false);
  });

  it("does not let a duplicated roster inflate presence counts", () => {
    // two ticks, roster says "a" twice — the metric must still be 2, not 4.
    // An inflated metric outranks the arrival tiebreak and would flip the winner.
    const samples = [
      sample("a", 0, "square"),
      sample("a", 1, "square"),
      sample("b", 0, "square"),
      sample("b", 1, "square"),
      sample("b", 2, "square"),
      sample("b", 3, "square"),
      sample("a", 2, "pond"),
      sample("a", 3, "pond"),
    ];
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["a", "a", "b"],
      samples,
      resolvedAt: at(4),
    });
    const a = r.standings.find((s) => s.agentId === "a")!;
    expect(a.metric).toBe(2); // not 4
    expect(a.detail).toContain("2 of 4 ticks");
    // b reached the square first, so b must still win it (08 §4.2 arrival tiebreak)
    expect(ranks(r)).toEqual(["b", "a"]);
  });

  it("does not double-count hold_ground run ticks for a duplicated roster", () => {
    const samples = [
      sample("a", 0, "pond"),
      sample("a", 1, "pond"),
      sample("b", 0, "square"),
      sample("b", 1, "square"),
    ];
    const r = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants: ["a", "a", "b"],
      samples,
      resolvedAt: at(2),
    });
    const a = r.standings.find((s) => s.agentId === "a")!;
    expect(a.metric).toBe(2); // not 4
    expect(a.detail).toContain("2 of 2 solo");
  });

  it("lets a contestant hold alone even when a non-registrant is watching", () => {
    // 08 §4.2 says "the only *contestant* present". Residents will be steered
    // to the venue as an audience (08 §9), so a bystander must not block the hold.
    const samples = [
      sample("a", 0, "pond"),
      sample("audience", 0, "pond"), // not registered
      sample("a", 1, "pond"),
      sample("audience", 1, "pond"),
      sample("b", 0, "square"),
      sample("b", 1, "square"),
    ];
    const r = scoreContest({
      kind: "hold_ground",
      place: "pond",
      entrants: ["a", "b"],
      samples,
      resolvedAt: at(2),
    });
    const a = r.standings.find((s) => s.agentId === "a")!;
    expect(a.metric).toBe(2);
    expect(r.standings.map((s) => s.agentId)).not.toContain("audience");
  });

  it("ignores evidence from agents that never registered", () => {
    const r = scoreContest({
      kind: "gather_at",
      place: "square",
      entrants: ["a", "b"],
      samples: [sample("a", 0, "square"), sample("b", 0, "square"), sample("intruder", 0, "square")],
      resolvedAt: at(1),
    });
    expect(r.standings).toHaveLength(2);
    expect(ranks(r)).not.toContain("intruder");
  });
});

describe("order independence", () => {
  const samples = [
    sample("hux", 0, "square"),
    sample("hux", 1, "square"),
    sample("tux", 1, "square"),
    sample("tux", 2, "square"),
    sample("vetch", 0, "square"),
    sample("vetch", 2, "square"),
  ];
  const entrants = ["hux", "tux", "vetch"];

  const shuffled = [...samples].reverse();

  it("produces the identical result from a shuffled sample trail", () => {
    const a = scoreContest({ kind: "gather_at", place: "square", entrants, samples, resolvedAt: at(3) });
    const b = scoreContest({ kind: "gather_at", place: "square", entrants, samples: shuffled, resolvedAt: at(3) });
    expect(b).toEqual(a);
  });

  it("holds for endure, where the spirit delta spans first→last", () => {
    const trail = [
      sample("a", 0, "square", { spirits: 0.5 }),
      sample("a", 1, "square", { spirits: 0.8 }),
      sample("b", 0, "square", { spirits: 0.5 }),
      sample("b", 1, "square", { spirits: 0.6 }),
    ];
    const a = scoreContest({ kind: "endure", place: "square", entrants: ["a", "b"], samples: trail, resolvedAt: at(2) });
    const b = scoreContest({
      kind: "endure",
      place: "square",
      entrants: ["a", "b"],
      samples: [...trail].reverse(),
      resolvedAt: at(2),
    });
    expect(b).toEqual(a);
    expect(ranks(a)).toEqual(["a", "b"]);
  });
});

describe("start conditions (D6)", () => {
  it("refuses to start below two entrants", () => {
    expect(canStart([])).toBe(false);
    expect(canStart(["a"])).toBe(false);
    expect(canStart(["a", "b"])).toBe(true);
  });

  it("counts unique ids — a duplicated roster is still one entrant", () => {
    expect(canStart(["a", "a"])).toBe(false);
    expect(hasRoom(["a", "a", "b", "b", "c", "c", "d", "d"])).toBe(true);
  });

  it("does not veto an over-subscribed roster — that is registration's job", () => {
    const full = Array.from({ length: 20 }, (_, i) => `x${i}`);
    expect(canStart(full)).toBe(true);
  });

  it("turns registrants away only once the roster is full", () => {
    expect(hasRoom(Array.from({ length: CONTEST.maxEntrants - 1 }, (_, i) => `x${i}`))).toBe(true);
    expect(hasRoom(Array.from({ length: CONTEST.maxEntrants }, (_, i) => `x${i}`))).toBe(false);
  });
});

describe("evidence cap (08 §11)", () => {
  it("leaves a short trail untouched", () => {
    const trail = [sample("a", 0, "square"), sample("a", 1, "square")];
    expect(trimSamples(trail, 5)).toEqual(trail);
  });

  it("keeps the newest rows when the trail is over budget", () => {
    const trail = Array.from({ length: 300 }, (_, i) => sample("a", i, "square"));
    const trimmed = trimSamples(trail, 200);
    expect(trimmed).toHaveLength(200);
    // newest rows survive
    expect(trimmed[trimmed.length - 1].t).toBe(trail[299].t);
    expect(trimmed[0].t).toBe(trail[100].t);
  });

  it("picks the newest rows by timestamp, not by position in the array", () => {
    // the sort-before-slice branch: a shuffled trail must still yield the tail
    const trail = [
      sample("a", 3, "square"),
      sample("a", 0, "square"),
      sample("a", 5, "square"),
      sample("a", 1, "square"),
      sample("a", 4, "square"),
      sample("a", 2, "square"),
    ];
    const trimmed = trimSamples(trail, 3);
    expect(trimmed.map((s) => s.t)).toEqual([at(3), at(4), at(5)]);
  });
});
