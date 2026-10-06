import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { buildThinkingLines, ThinkingPanel, type ThinkingDoing } from "../src/components/ThinkingPanel.js";
import { patchOrder } from "../src/store/useTown.js";
import { npcSkillLabel } from "@slopagentbook/shared";
import type { Resident, TownSnapshot } from "@slopagentbook/shared";

// 08 §12 — thinking.test.ts: the follow HUD reads a resident's decision
// (skill → reason → goal) out of `mind.doing`, and the SSE `order` case in
// useTown carries `skill`/`why` through to it. Pure first (buildThinkingLines,
// patchOrder — no EventSource needed), then one jsdom render to prove the
// panel copes with an absent skill without crashing.

function doing(over: Partial<Resident["mind"]["doing"]> = {}): Resident["mind"]["doing"] {
  return {
    act: "drink",
    place: "pond",
    placeName: "The Pond",
    since: 1,
    why: "parched, seeking water",
    skill: "drink-water",
    ...over,
  };
}

function resident(id: string, over: Partial<Resident["mind"]["doing"]> = {}): Resident {
  return {
    id,
    name: "Alpha",
    handle: "alpha",
    mind: { doing: doing(over), spirits: 0, obsession: "", memories: [], relationships: {} },
  } as unknown as Resident;
}

function snap(herd: Resident[]): TownSnapshot {
  return { herd } as unknown as TownSnapshot;
}

describe("buildThinkingLines", () => {
  it("summarises a full decision as skill → reason → goal", () => {
    // the label comes from shared's rule table, not a copy of it here
    expect(npcSkillLabel("drink-water")).toBe("Thirst");

    expect(buildThinkingLines(doing())).toEqual([
      { label: "skill", value: "Thirst" },
      { label: "reason", value: "parched, seeking water" },
      { label: "goal", value: "drink @ The Pond" },
    ]);
  });

  it("falls back per row instead of throwing on absent fields", () => {
    // no skill yet (snapshot older than the skill feature)
    expect(buildThinkingLines(doing({ skill: undefined }))[0]).toEqual({ label: "skill", value: "-" });
    // unknown rule id → the raw id, still readable
    expect(buildThinkingLines(doing({ skill: "no-such-rule" }))[0]).toEqual({ label: "skill", value: "no-such-rule" });
    // empty / whitespace reasons are absent reasons
    expect(buildThinkingLines(doing({ why: "" }))[1].value).toBe("-");
    expect(buildThinkingLines(doing({ why: "   " }))[1].value).toBe("-");
    expect(buildThinkingLines({} as ThinkingDoing)[1].value).toBe("-");
    // placeName missing → the raw place id
    expect(buildThinkingLines(doing({ placeName: "" }))[2]).toEqual({ label: "goal", value: "drink @ pond" });
  });

  it("renders placeholders for a resident that is gone from the herd", () => {
    expect(buildThinkingLines(undefined)).toEqual([
      { label: "skill", value: "-" },
      { label: "reason", value: "-" },
      { label: "goal", value: "-" },
    ]);
    expect(buildThinkingLines({})).toHaveLength(3);
  });
});

describe("patchOrder (useTown SSE order case)", () => {
  it("patches skill and why together with act/place", () => {
    const prev = snap([resident("e1")]);
    const next = patchOrder(prev, {
      type: "order", id: "e1", act: "graze", place: "trough", secs: 3,
      skill: "eat-food", why: "craving the good grass",
    });

    const d = next.herd[0].mind.doing;
    expect(d.act).toBe("graze");
    expect(d.place).toBe("trough");
    expect(d.placeName).toBe("trough");
    expect(d.skill).toBe("eat-food");
    expect(d.why).toBe("craving the good grass");
    expect(d.since).toBeGreaterThan(0);
    // immutable: the input snapshot keeps its own decision
    expect(prev.herd[0].mind.doing).toEqual(doing());
  });

  it("keeps skill/why when an older server omits them", () => {
    const prev = snap([resident("e1", { skill: "wander-town", why: "out for a walk" })]);
    const next = patchOrder(prev, { type: "order", id: "e1", act: "stroll", place: "square", secs: 1 });

    const d = next.herd[0].mind.doing;
    expect(d.act).toBe("stroll");
    expect(d.why).toBe("out for a walk");   // never blanked by a stale order
    expect(d.skill).toBe("wander-town");
    // and the old snapshot is untouched
    expect(prev.herd[0].mind.doing.act).toBe("drink");
  });

  it("lets a present skill/why win — a blank clears the stale label, foreign ids stay untouched", () => {
    const prev = snap([resident("e1", { skill: "wander-town", why: "out for a walk" }), resident("e2")]);
    const next = patchOrder(prev, { type: "order", id: "e1", act: "talk", place: "fire", secs: 2, skill: "", why: "   " });

    // turn.ts always writes both keys ("" when a decision carries no skill), so
    // an explicit blank is the server's answer — not a gap to preserve
    expect(next.herd[0].mind.doing.skill).toBe("");
    expect(next.herd[0].mind.doing.why).toBe("   ");

    const other = patchOrder(prev, { type: "order", id: "e9", act: "wander", place: "square", secs: 2, skill: "wander-town" });
    expect(other.herd[0].mind.doing).toBe(prev.herd[0].mind.doing);
    expect(other.herd[1].mind.doing).toBe(prev.herd[1].mind.doing);
  });
});

describe("ThinkingPanel", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
  });

  function render(node: ReactNode): HTMLElement | null {
    act(() => { root.render(node); });
    return host.querySelector('[data-testid="thinking-panel"]');
  }

  it("renders the three rows with the shared skill label", () => {
    const el = render(createElement(ThinkingPanel, { doing: doing() }));
    expect(el).not.toBeNull();
    const rows = [...host.querySelectorAll('[data-testid="thinking-line"]')];
    expect(rows.map((r) => r.textContent)).toEqual([
      "skillThirst",
      "reasonparched, seeking water",
      "goaldrink @ The Pond",
    ]);
    // the agent loop is the frame that makes the row read as "thinking"
    expect(el!.textContent).toContain("perceive → appraise → decide → act → speak → remember");
  });

  it("shows placeholders when the resident vanished — no crash", () => {
    const el = render(createElement(ThinkingPanel, {}));
    expect(el).not.toBeNull();
    expect(host.querySelector('[data-testid="thinking-skill"]')!.textContent).toBe("-");
    expect(host.querySelector('[data-testid="thinking-reason"]')!.textContent).toBe("-");
    expect(host.querySelector('[data-testid="thinking-goal"]')!.textContent).toBe("-");
  });
});
