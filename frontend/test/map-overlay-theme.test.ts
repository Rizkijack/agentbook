import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { WorldCanvas } from "../src/canvas/WorldCanvas.js";
import { BUILD_INK } from "../src/canvas/engine.js";
import type { Contest, TownSnapshot } from "@slopagentbook/shared";

// The two bars that float on the map — the drag hint along the bottom and the
// contest bar across the top — used to carry the LIGHT palette as literals
// (rgba(244,241,234,0.94) over #1b1915 text). On the dark theme that is an
// opaque pale-cream slab with the inherited --ink text under it, i.e. invisible.
// They read from --hud-* tokens now, and these tests pin that: the tokens exist
// in both themes, they invert, they are readable in both, and the components
// use them instead of a hex.

const VIEW_W = 1200;
const VIEW_H = 560;
const GENES = "2.1.0.3.1.42.55.62.1";

const CSS = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");

/** One declaration out of a `:root` / `[data-theme="dark"]` block. */
function token(block: "root" | "dark", name: string): string {
  const start = block === "root" ? CSS.indexOf(":root {") : CSS.indexOf('[data-theme="dark"] {');
  const body = CSS.slice(start, CSS.indexOf("}", start));
  const m = body.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`--${name} missing from the ${block} block`);
  return m[1]!.trim();
}

/** WCAG relative luminance + contrast ratio, so "readable" is a number not a vibe. */
function luminance(colour: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(colour)![1]!;
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
/** The colour an `rgba(...)` token composites down to over the dark map ground. */
function overGround(tokenValue: string, ground = "#1e2e22"): string {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.%]+))?/.exec(tokenValue);
  if (!m) return tokenValue;
  const a = m[4] === undefined ? 1 : m[4]!.endsWith("%") ? parseFloat(m[4]!) / 100 : parseFloat(m[4]!);
  const g = [1, 3, 5].map((i) => parseInt(ground.slice(i, i + 2), 16));
  const c = [1, 2, 3].map((i) => Math.round(parseFloat(m[i]!) * a + g[i - 1]! * (1 - a)));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

describe("map overlay tokens", () => {
  it("exist in both themes, and the dark one is not the light one", () => {
    for (const name of ["hud-paper", "hud-ink", "hud-rule", "hud-shadow"]) {
      const light = token("root", name);
      const dark = token("dark", name);
      expect(light, `--${name} missing from :root`).toBeTruthy();
      expect(dark, `--${name} missing from [data-theme="dark"]`).toBeTruthy();
      expect(dark, `--${name} is identical in both themes`).not.toBe(light);
    }
  });

  it("invert with the theme: pale ink on dark paper in the dark, the reverse in the light", () => {
    const lightPaper = luminance(overGround(token("root", "hud-paper"), "#cfe8c0"));
    const lightInk = luminance(token("root", "hud-ink"));
    const darkPaper = luminance(overGround(token("dark", "hud-paper")));
    const darkInk = luminance(token("dark", "hud-ink"));

    expect(lightInk).toBeLessThan(lightPaper);
    expect(darkInk).toBeGreaterThan(darkPaper);
    // and both themes clear the WCAG AA threshold for body text on their own bar
    expect(contrast(token("root", "hud-ink"), overGround(token("root", "hud-paper"), "#cfe8c0"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("dark", "hud-ink"), overGround(token("dark", "hud-paper")))).toBeGreaterThanOrEqual(4.5);
    // the dark bar must not be the pale cream that caused the defect
    expect(overGround(token("dark", "hud-paper"))).not.toBe(overGround(token("root", "hud-paper"), "#cfe8c0"));
  });
});

const CTX_METHODS = [
  "setTransform", "clearRect", "translate", "scale", "rotate", "fillRect", "strokeRect",
  "beginPath", "closePath", "moveTo", "lineTo", "rect", "arc", "arcTo", "ellipse",
  "quadraticCurveTo", "bezierCurveTo", "clip", "fill", "stroke", "setLineDash",
  "strokeText", "drawImage", "save", "restore", "putImageData", "getImageData",
];

beforeAll(() => {
  const ctx: Record<string, unknown> = {};
  for (const m of CTX_METHODS) ctx[m] = () => ctx;
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
    observe() {} unobserve() {} disconnect() {}
  };
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
});

let host: HTMLDivElement;
let root: Root;

function snap(contests?: Contest[]): TownSnapshot {
  return {
    herd: [
      { id: "e1", name: "Alpha", handle: "alpha", genes: GENES, mind: { doing: { place: "square", act: "wander" } }, born: 0 },
    ],
    contests,
  } as unknown as TownSnapshot;
}

function liveContest(): Contest {
  const t = Date.now();
  return {
    kind: "gather_at", title: "THE HALL ARGUMENT", place: "square",
    startsAt: t - 60_000, endsAt: t + 180_000, state: "live",
    entrants: ["e1"], samples: [], narration: "Two rivals, one square, no referee.",
    id: "ct-1",
  } as Contest;
}

/** Inline style of the bar at the given position hint. */
function barStyle(bottom: boolean): string {
  const all = [...host.querySelectorAll("div")].map((d) => d.getAttribute("style") ?? "");
  return all.find((s) => (bottom ? s.includes("bottom: 8px") : s.includes("top: 48px"))) ?? "";
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe("dark-theme building ink", () => {
  /** The apron drawTerrainDecor paints the city on, i.e. what a wall stands on. */
  const APRON = luminance("#33302a");
  const CATEGORIES = ["base", "Social", "Civic", "Work", "Rest"];

  it("puts every wall, roof and trim above the ground it stands on", () => {
    // the defect: in the dark theme every wall was 0.019-0.027 against a 0.030
    // apron — darker than its own ground, so a building read as a hole
    for (const category of CATEGORIES) {
      const ink = BUILD_INK.dark[category]!;
      expect(luminance(ink.wall), `${category} wall vs the apron`).toBeGreaterThan(APRON * 1.5);
      expect(luminance(ink.roof), `${category} roof vs the apron`).toBeGreaterThan(luminance(ink.wall));
      // the trim is the 1px edge that separates a building from its neighbour,
      // so it has to be the brightest of the three
      expect(luminance(ink.trim), `${category} trim vs its roof`).toBeGreaterThan(luminance(ink.roof));
    }
  });

  it("keeps the light theme exactly as it was", () => {
    // the dark palette was lifted; the light one is the one that already read
    expect(BUILD_INK.light.base).toEqual({ wall: "#e8ddd0", roof: "#8b5a3c", trim: "#1b1915", wood: "#c9a86a" });
    expect(BUILD_INK.light.Social!.roof).toBe("#a66a3a");
    expect(BUILD_INK.light.Rest!.wall).toBe("#b54a3a");
    // ...and its relationship is the same one, inverted: dark trim on a pale wall
    for (const category of CATEGORIES) {
      const ink = BUILD_INK.light[category]!;
      expect(luminance(ink.trim)).toBeLessThan(luminance(ink.wall));
    }
  });

  it("still reads as night — no ink brighter than a street lamp", () => {
    const lamp = luminance("#ffd977");
    for (const category of CATEGORIES) {
      for (const part of ["wall", "roof", "trim", "wood"] as const) {
        expect(luminance(BUILD_INK.dark[category]![part])).toBeLessThan(lamp);
      }
    }
  });
});

describe("the bars on the map", () => {
  it("read their colours from the tokens, in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.setAttribute("data-theme", theme);
      act(() => { root.render(createElement(WorldCanvas, { snapshot: snap([liveContest()]) })); });

      const hint = barStyle(true);
      const bar = barStyle(false);
      expect(hint, `drag hint missing (${theme})`).toBeTruthy();
      expect(bar, `contest bar missing (${theme})`).toBeTruthy();
      for (const style of [hint, bar]) {
        expect(style).toContain("var(--hud-paper)");
        expect(style).toContain("var(--hud-ink)");
        expect(style).toContain("var(--hud-rule)");
        // the defect, verbatim: a literal light palette on a themed surface
        expect(style).not.toContain("rgba(244,241,234");
        expect(style).not.toContain("#1b1915");
      }
      // the bar's own text has to be set, not inherited: --ink is pale on dark
      expect(bar).toContain("color: var(--hud-ink)");
      expect(hint).toContain("color: var(--hud-ink)");
    }
    document.documentElement.removeAttribute("data-theme");
  });
});