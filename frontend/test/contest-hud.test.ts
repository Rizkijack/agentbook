import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { WorldCanvas, pickContest, contestPhase } from "../src/canvas/WorldCanvas.js";
import { ENTRANT_COLOR, RANK_COLORS } from "../src/canvas/engine.js";
import { parseHash } from "../src/router/hash.js";
import type { Contest, TownSnapshot } from "@hermesbook/shared";

// 08 §13 — `contest-hud.test.ts`: the D9 state machine (idle → announced →
// live → resolved → idle), the route that forces a contest, the diegetic marks
// the engine now paints, the §9 audience nudge, and a clean detach on unmount
// (the listener pattern from worldcanvas.test.ts).

const VIEW_W = 1200;
const VIEW_H = 560;
const GENES = "2.1.0.3.1.42.55.62.1";

type HerdMember = { id: string; name: string; handle: string; genes: string; mind: { doing: { place: string; act: string } }; born: number };

/** Two contestants and one bystander parked in the barn — the bystander is the audience. */
function herd(): HerdMember[] {
  return [
    { id: "e1", name: "Alpha", handle: "alpha", genes: GENES, mind: { doing: { place: "square", act: "wander" } }, born: 0 },
    { id: "e2", name: "Beta", handle: "beta", genes: GENES, mind: { doing: { place: "square", act: "wander" } }, born: 0 },
    { id: "b1", name: "Bystander", handle: "by", genes: GENES, mind: { doing: { place: "barn", act: "wander" } }, born: 0 },
  ];
}

function contest(over: Partial<Contest> = {}): Contest {
  const t = Date.now();
  return {
    id: "ct-s1-d3-i0",
    kind: "gather_at",
    title: "THE HALL ARGUMENT",
    place: "square",
    startsAt: t - 60_000,
    endsAt: t + 180_000,
    state: "announced",
    entrants: ["e1", "e2"],
    samples: [],
    narration: "Two rivals, one square, no referee.",
    ...over,
  };
}

function snap(contests?: Contest[]): TownSnapshot {
  return { herd: herd(), contests } as unknown as TownSnapshot;
}

const CTX_METHODS = [
  "setTransform", "clearRect", "translate", "scale", "rotate", "fillRect", "strokeRect",
  "beginPath", "closePath", "moveTo", "lineTo", "rect", "arc", "arcTo", "ellipse",
  "quadraticCurveTo", "bezierCurveTo", "clip", "fill", "stroke", "setLineDash",
  "fillText", "strokeText", "drawImage", "save", "restore", "putImageData", "getImageData",
];

/** Every label the renderer painted, with the fillStyle in force — the §10.2 tag colour. */
let labels: Array<{ text: string; fill: string }> = [];

function installDomStubs() {
  const ctx: Record<string, unknown> = {};
  for (const m of CTX_METHODS) ctx[m] = () => ctx;
  ctx.fillText = (text: string) => { labels.push({ text, fill: String(ctx.fillStyle) }); return ctx; };
  ctx.measureText = (t: string) => ({ width: t.length * 6 });
  ctx.createRadialGradient = () => ({ addColorStop: () => {} });
  ctx.createLinearGradient = () => ({ addColorStop: () => {} });
  ctx.createPattern = () => null;
  ctx.getImageData = (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  ctx.createImageData = (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });

  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => ctx;
  proto.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: VIEW_W, bottom: VIEW_H, width: VIEW_W, height: VIEW_H, toJSON: () => ({}),
  });
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
  proto.hasPointerCapture = () => false;
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}

/** window.addEventListener/removeEventListener must come back in pairs on unmount. */
const TRACKED = ["resize", "hashchange", "hermes:order", "hermes:spit", "hermes:post"];
let added: string[] = [];
let removed: string[] = [];
const origAdd = window.addEventListener;
const origRemove = window.removeEventListener;

function trackListeners() {
  added = [];
  removed = [];
  window.addEventListener = function (this: Window, type: string, ...rest: never[]) {
    if (TRACKED.includes(type)) added.push(type);
    return origAdd.call(this, type, ...(rest as [never, never]));
  } as typeof window.addEventListener;
  window.removeEventListener = function (this: Window, type: string, ...rest: never[]) {
    if (TRACKED.includes(type)) removed.push(type);
    return origRemove.call(this, type, ...(rest as [never, never]));
  } as typeof window.removeEventListener;
}

function untrackListeners() {
  window.addEventListener = origAdd;
  window.removeEventListener = origRemove;
}

function xfOf(): any {
  return (window as unknown as Record<string, any>).__hermes_xf;
}

function hud(): HTMLElement | null {
  return host.querySelector('[data-testid="contest-hud"]');
}

let host: HTMLDivElement;
let root: Root;

function mount(snapshot: TownSnapshot) {
  act(() => { root.render(createElement(WorldCanvas, { snapshot })); });
}

async function paintFrame() {
  labels = [];
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}

beforeAll(installDomStubs);

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  trackListeners();
});

afterEach(() => {
  untrackListeners();
  act(() => { root.unmount(); });
  host.remove();
  location.hash = "";
});

describe("contest route", () => {
  it("parses #/contest/:id into the contest page (08 §10.3)", () => {
    const r = parseHash("#/contest/ct-s1-d3-i0");
    expect(r.page).toBe("contest");
    expect(r.arg).toBe("ct-s1-d3-i0");
  });

  it("forces the routed contest over whatever the town would have picked", async () => {
    const live = contest({ id: "ct-live", state: "live" });
    const other = contest({ id: "ct-other", state: "resolved", result: { standings: [], voidResult: false, resolvedAt: Date.now() } });
    location.hash = "#/contest/ct-other";
    mount(snap([live, other]));

    expect(hud()?.getAttribute("data-contest-id")).toBe("ct-other");
    expect(hud()?.getAttribute("data-phase")).toBe("resolved");

    // leave the permalink: the ambient pickup takes over again (live wins)
    await act(async () => { location.hash = "#/town"; await new Promise((r) => setTimeout(r, 30)); });
    expect(hud()?.getAttribute("data-contest-id")).toBe("ct-live");
    expect(hud()?.getAttribute("data-phase")).toBe("live");
  });
});

describe("HUD state machine (08 §10.1)", () => {
  it("idle: renders nothing at all on a day with no contest", () => {
    mount(snap([]));
    expect(hud()).toBeNull();
    expect(xfOf().contest).toBeNull();

    mount(snap(undefined));
    expect(hud()).toBeNull();
    expect(contestPhase(undefined, Date.now())).toBe("idle");
  });

  it("announced: counts down and marks every entrant", async () => {
    mount(snap([contest()]));
    const el = hud()!;
    expect(el.getAttribute("data-phase")).toBe("announced");
    expect(el.getAttribute("data-contest-id")).toBe("ct-s1-d3-i0");
    expect(el.textContent).toContain("THE HALL ARGUMENT");
    expect(host.querySelector('[data-testid="contest-countdown"]')?.textContent).toMatch(/starts in \d+s/);

    const chips = [...host.querySelectorAll('[data-testid="hud-entrant"]')];
    expect(chips.map((c) => c.textContent)).toEqual(["◆ Alpha", "◆ Beta"]);

    // the diegetic half of "participants marked": a ring colour in the engine
    const xf = xfOf();
    expect(xf.contest.state).toBe("announced");
    expect(xf.contest.entrants).toEqual(["e1", "e2"]);
    expect(xf.contestColor("e1")).toBe(ENTRANT_COLOR);
    expect(xf.contestColor("b1")).toBeNull();

    // and the name tag really is painted in it — but the barn (x≈700) sits just
    // outside the default camera (viewLeft = 880), so the audience is culled like
    // any off-screen sprite; pan west far enough to hold barn AND square first.
    act(() => { xf.panBy(400, 0); });

    await paintFrame();
    const alpha = labels.filter((l) => l.text === "Alpha");
    expect(alpha.length).toBeGreaterThan(0);
    for (const l of alpha) expect(l.fill).toBe(ENTRANT_COLOR);
    const by = labels.filter((l) => l.text === "Bystander");
    expect(by.length).toBeGreaterThan(0);
    for (const l of by) expect(l.fill).not.toBe(ENTRANT_COLOR);
  });

  it("live: thin bar with timer and standings, ranked by venue attendance", () => {
    const samples = [
      { t: 1, agentId: "e1", place: "square", spirits: 5, wasSpit: false },
      { t: 2, agentId: "e1", place: "square", spirits: 5, wasSpit: false },
      { t: 3, agentId: "e2", place: "barn", spirits: 5, wasSpit: false },
    ];
    mount(snap([contest({ state: "live", samples })]));

    const el = hud()!;
    expect(el.getAttribute("data-phase")).toBe("live");
    expect(host.querySelector('[data-testid="contest-timer"]')?.textContent).toMatch(/\d+:\d{2} left/);

    const rows = [...host.querySelectorAll('[data-testid="hud-standing-row"]')].map((s) => s.textContent);
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("Alpha");
    expect(rows[0]).toContain("2");   // 2 ticks at the venue
    expect(rows[1]).toContain("Beta");
    // 08 §4.2: only samples AT the target count as attendance, so the tick Beta
    // spent in the barn scores 0 — the row is "2. Beta 0", never "1".
    expect(rows[1]).toBe("2. Beta 0");
    expect(host.querySelector('[data-testid="contest-standings"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="contest-entrants"]')).toBeNull();
    expect(host.querySelector('[data-testid="contest-result"]')).toBeNull();
  });

  it("resolved: shows the result card, then falls back to idle", () => {
    const c = contest({
      state: "resolved",
      result: {
        standings: [
          { agentId: "e1", score: 10, rank: 1, metric: 42, detail: "42 ticks at the square" },
          { agentId: "e2", score: 5, rank: 2, metric: 31, detail: "31 ticks at the square" },
        ],
        voidResult: false,
        resolvedAt: Date.now(),
      },
    });
    mount(snap([c]));

    expect(hud()?.getAttribute("data-phase")).toBe("resolved");
    const card = host.querySelector('[data-testid="contest-result"]')!;
    expect(card.textContent).toContain("Alpha wins");
    expect(card.textContent).toContain("1. Alpha");
    // rank colour reaches the tag once there is a rank to show
    expect(xfOf().contestColor("e1")).toBe(RANK_COLORS[0]);
    expect(xfOf().contestColor("e2")).toBe(RANK_COLORS[1]);

    // CONTEST.resultCardMs (45s) is up → the bar is gone, the town is quiet
    mount(snap([contest({ state: "resolved", result: { ...c.result!, resolvedAt: Date.now() - 60_000 } })]));
    expect(hud()).toBeNull();
    expect(xfOf().contest).toBeNull();
    // CONTEST.resultCardMs (45s) is up → the bar is gone, the town is quiet.
    // `c` resolved at its own resolvedAt, so the pure-function form has to move
    // the clock FORWARD past the card window, not back before the resolution.
    expect(pickContest([c], null, c.result!.resolvedAt + 60_000)).toBeUndefined();
  });

  it("picks the most urgent window when several contests share a day", () => {
    const now = Date.now();
    const live = contest({ id: "ct-live", state: "live" });
    const announced = contest({ id: "ct-ann", state: "announced" });
    const fresh = contest({ id: "ct-done", state: "resolved", result: { standings: [], voidResult: false, resolvedAt: now - 1000 } });
    const stale = contest({ id: "ct-old", state: "resolved", result: { standings: [], voidResult: false, resolvedAt: now - 600_000 } });

    expect(pickContest([announced, fresh], null, now)?.id).toBe("ct-ann");
    expect(pickContest([announced, live], null, now)?.id).toBe("ct-live");
    expect(pickContest([stale, fresh], null, now)?.id).toBe("ct-done");
    expect(pickContest([stale], null, now)).toBeUndefined();
    expect(pickContest(undefined, null, now)).toBeUndefined();
    expect(pickContest([announced, live], "ct-ann", now)?.id).toBe("ct-ann");
  });
});

describe("audience steering (08 §9)", () => {
  it("nudges ambient residents toward the venue while the contest is live", () => {
    const rnd = Math.random;
    Math.random = () => 0.5; // lands in the wander → random-location branch
    try {
      mount(snap([contest({ state: "live" })]));
      const xf = xfOf();
      const watcher = xf.byId.get("b1")!;
      expect(watcher.targetPlace).toBe("barn");
      watcher.wanderTimer = 0;

      act(() => { for (let i = 0; i < 20; i++) xf.tick(1 / 60); });
      expect(watcher.targetPlace).toBe("square");   // a bias, not a forced path

      // The contestants are left to the sim — a real claim, so it needs a
      // rival who does *not* already live at the venue: `e1` starts in the
      // square, and "still square" would be true whether or not the nudge
      // hijacked it. Park it in the barn, freeze its own wander so the sim
      // cannot mask the answer, and the venue nudge has nothing to hide behind.
      const rival = xf.byId.get("e1")!;
      rival.targetPlace = "barn";
      rival.wanderTimer = 999;
      act(() => { for (let i = 0; i < 20; i++) xf.tick(1 / 60); });
      expect(rival.targetPlace).toBe("barn");
      xf.setContest(null);
      watcher.wanderTimer = 0;
      watcher.targetPlace = "barn";
      Math.random = () => 0.9; // above the 62% venue bias
      act(() => { for (let i = 0; i < 10; i++) xf.tick(1 / 60); });
      expect(watcher.targetPlace).toBe("barn");
    } finally {
      Math.random = rnd;
    }
  });
});

describe("teardown", () => {
  it("detaches every listener on unmount", async () => {
    location.hash = "#/contest/ct-s1-d3-i0";
    mount(snap([contest()]));
    expect(hud()).not.toBeNull();
    expect(added).toEqual(expect.arrayContaining(["resize", "hashchange", "hermes:order", "hermes:spit", "hermes:post"]));

    const xf = xfOf();
    act(() => { root.unmount(); });
    expect(xfOf()).toBeUndefined();

    for (const type of TRACKED) {
      expect(removed.filter((t) => t === type).length).toBe(added.filter((t) => t === type).length);
    }

    // nothing left to hear a late SSE push or a hash change
    window.dispatchEvent(new CustomEvent("hermes:order", { detail: { id: "e1", act: "wander", place: "square", secs: 1 } }));
    window.dispatchEvent(new Event("hashchange"));
    expect(xfOf()).toBeUndefined();
    expect(xf.contest).not.toBeNull();   // torn-down engine was never touched again
    expect(hud()).toBeNull();

    root = createRoot(host); // re-mount so afterEach can unmount cleanly
  });
});
