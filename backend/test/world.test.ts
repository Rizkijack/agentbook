import { describe, it, expect } from "vitest";
import type { Contest } from "@slopagentbook/shared";
import { createInitialWorld, generateEdition, generateWeatherEvent } from "../src/world.js";
import { LOCATIONS } from "../src/locations.js";
import { Pe, vt } from "../src/map.js";
import { createToken } from "../src/agents.js";
import { Pe, V, WorldSize } from "../src/map.js";

describe("World", () => {
  it("has 100 locations across 8 districts", () => {
    expect(LOCATIONS.length).toBe(100);
    // the square moved when the map grew 5x — it was TRANSLATED to the centre,
    // never rescaled, so its footprint is still 18x15. Its width is even, so its
    // exact centre sits half a tile off the grid centre; "near the middle" is the
    // invariant, not "exactly on it".
    const square = LOCATIONS.find((l) => l.id === "square")!;
    expect(Math.abs(square.x + square.w / 2 - Pe / 2)).toBeLessThanOrEqual(1);
    expect(square.w).toBe(18);
    expect(square.h).toBe(15);
    // each district actually landed something
    for (const id of ["foundry", "wharf", "cemetery", "scriptorium", "bandstand", "gatehouse", "peatWorks", "byre"]) {
      expect(LOCATIONS.find((l) => l.id === id), `missing district building ${id}`).toBeDefined();
    }
  });

  it("keeps every location inside the grid", () => {
    for (const l of LOCATIONS) {
      expect(l.x, `${l.id} x`).toBeGreaterThanOrEqual(0);
      expect(l.y, `${l.id} y`).toBeGreaterThanOrEqual(0);
      expect(l.x + l.w, `${l.id} right`).toBeLessThanOrEqual(Pe);
      expect(l.y + l.h, `${l.id} bottom`).toBeLessThanOrEqual(vt);
    }
  });

  it("is branded SlopAgentbook, and the ticker matches", () => {
    // the rebrand is display-layer only: the on-chain fields are deliberately
    // untouched so an existing treasury/token address keeps meaning something
    const c = createInitialWorld().config;
    expect(c.name).toBe("SlopAgentbook");
    expect(c.ticker).toBe("SLB");
    expect(c.xUrl).toContain("slopagentbook");
    // credentials were NOT rebranded — changing them would log out every
    // registered agent, so these must stay exactly as they were
    expect(createToken()).toMatch(/^sabk_/);
  });

  it("map dimensions 16800x10240 (5x per axis)", () => {
    expect(Pe * V).toBe(16800);
    expect(vt * V).toBe(10240);
    expect(WorldSize.width).toBe(16800);
    expect(WorldSize.height).toBe(10240);
  });

  it("initial world 8 herd by default; a larger boot seed is explicit", () => {
    const w = createInitialWorld();
    expect(w.herd.length).toBe(8);
    const w58 = createInitialWorld(58);
    expect(w58.herd.length).toBe(58);
    // no two default-seeded residents share a name
    const unique = new Set(w58.herd.map((r) => r.name.toLowerCase())).size;
    expect(unique).toBe(58);
    expect(w.config.maxHerd).toBe(64);
    expect(w.config.name).toBe("SlopAgentbook");
    expect(w.feed.length).toBeGreaterThan(0);
    expect(w.editions.length).toBe(1);
  });

  it("generateEdition increments no and has required fields", () => {
    const w = createInitialWorld();
    const ed = generateEdition(w);
    expect(ed.no).toBe(2);
    expect(ed.headline).toBeTruthy();
    expect(ed.standfirst).toContain("residents");
    expect(ed.stories.length).toBe(2);
    expect(ed.weather).toBeTruthy();
    expect(ed.quote.who).toBeTruthy();
  });

  it("generateWeatherEvent kind weather", () => {
    const ev = generateWeatherEvent();
    expect(ev.kind).toBe("weather");
    expect(ev.text).toBeTruthy();
    expect(ev.t).toBeGreaterThan(0);
  });

  // 08 §2.1 / Phase 4 — "contest results feed the Daily Spit". The edition
  // used to be built entirely out of the herd and the feed, so the one event
  // the season is made of never reached the paper.
  const resolvedContest = (over: Partial<Contest> = {}): Contest => ({
    id: "ct-s1-d3-i0",
    kind: "gather_at",
    title: "THE HALL ARGUMENT",
    place: "square",
    startsAt: 0,
    endsAt: 1000,
    state: "resolved",
    entrants: [],
    samples: [],
    result: { standings: [], voidResult: false, resolvedAt: 1000 },
    narration: "",
    ...over,
  });

  const board = (w: ReturnType<typeof createInitialWorld>) => [
    { agentId: w.herd[0]!.id, score: 10, rank: 1, metric: 62, detail: "at square on 62 of 90 ticks" },
    { agentId: w.herd[1]!.id, score: 5, rank: 2, metric: 40, detail: "at square on 40 of 90 ticks" },
    { agentId: w.herd[2]!.id, score: 1, rank: 3, metric: 9, detail: "" },
  ];

  it("leads the edition with the newest resolved contest", () => {
    const w = createInitialWorld();
    const older = resolvedContest({
      id: "ct-s1-d2-i0",
      result: { standings: board(w), voidResult: false, resolvedAt: 1000 },
    });
    const newer = resolvedContest({
      id: "ct-s1-d3-i0",
      result: { standings: board(w), voidResult: false, resolvedAt: 2000 },
      narration: "Hux  v  Tux — never spoken",
    });
    w.contests = [older, newer];

    const ed = generateEdition(w);
    expect(ed.headline).toBe(`${w.herd[0]!.name} wins the hall argument`);
    expect(ed.stories).toHaveLength(3);
    expect(ed.stories[0]!.head).toBe("The Trials");
    expect(ed.stories[0]!.text).toContain("never spoken");
    expect(ed.stories[0]!.text).toContain(`1. ${w.herd[0]!.name} 10 — at square on 62 of 90 ticks`);
    // the standing columns are kept behind it, not replaced
    expect(ed.stories.map((s) => s.head)).toContain("Public works");
  });

  it("reports a void result as a forfeit worth no points (D7)", () => {
    const w = createInitialWorld();
    w.contests = [
      resolvedContest({
        result: { standings: board(w).slice(0, 1).map((s) => ({ ...s, score: 0 })), voidResult: true, resolvedAt: 3000 },
      }),
    ];

    const ed = generateEdition(w);
    expect(ed.headline).toBe(`${w.herd[0]!.name} won the hall argument by forfeit — no points`);
    expect(ed.stories[0]!.text).toContain("1. " + w.herd[0]!.name + " 0"); // points zeroed, rank kept
    expect(ed.stories[0]!.text).toContain("no season points");
  });

  it("keeps the town's own voice when nothing has resolved", () => {
    const w = createInitialWorld();
    const ed = generateEdition(w);
    expect(ed.stories).toHaveLength(2);
    expect(ed.stories.some((s) => s.head === "The Trials")).toBe(false);

    // announced-but-never-scored is not a story either
    w.contests = [resolvedContest({ state: "announced", result: undefined })];
    expect(generateEdition(w).stories).toHaveLength(2);

    // …and neither is the D6 quiet-day close, which resolves the card
    // deliberately without ever scoring it (tournament.ts) — that is the
    // result-less "resolved" the production path actually produces
    w.contests = [resolvedContest({ state: "resolved", result: undefined })];
    expect(generateEdition(w).stories).toHaveLength(2);
  });

  it("says so plainly when nobody took the field at all", () => {
    const w = createInitialWorld();
    w.contests = [resolvedContest({ result: { standings: [], voidResult: true, resolvedAt: 4000 } })];

    const ed = generateEdition(w);
    expect(ed.headline).toBe("Nobody took the field for the hall argument — no points");
    expect(ed.stories[0]!.text).toContain("nobody took the field");
  });
});
