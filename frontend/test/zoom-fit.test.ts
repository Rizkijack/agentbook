import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Xf, MIN_ZOOM, MAX_ZOOM, NPC_H,
  TAG_MIN_ZOOM, NPC_MIN_ZOOM, SCENERY_MIN_ZOOM, GLOW_MIN_ZOOM, LABEL_MIN_ZOOM,
} from "../src/canvas/engine.js";
import { Pe, vt, V, WorldSize } from "../src/canvas/constants.js";

// The whole-town view. MIN_ZOOM used to be the literal 0.45, which had been
// right for a 210x128 map and was ~9x too tight once the grid went to 1050x640:
// at 0.45 an 890px viewport showed 124 of the 1050 tiles. These tests recompute
// the floor from Pe/vt/V independently of engine.ts and pin what it buys.

const VIEW_W = 890;   // the viewport the visual audit measured against
const VIEW_H = 560;   // the height WorldCanvas gives the canvas
const PAGE_MAX = 1280;
const PAGE_PAD = 24;

/** The widest content box the page can hand the canvas: `.page` less its padding. */
const FIT_BOX = { w: PAGE_MAX - PAGE_PAD * 2, h: VIEW_H };

const CTX_METHODS = [
  "setTransform", "clearRect", "translate", "scale", "rotate", "fillRect", "strokeRect",
  "beginPath", "closePath", "moveTo", "lineTo", "rect", "arc", "arcTo", "ellipse",
  "quadraticCurveTo", "bezierCurveTo", "clip", "fill", "stroke", "setLineDash",
  "strokeText", "drawImage", "save", "restore", "putImageData", "getImageData",
];

interface Tally {
  ops: number; gradients: number; blits: number;
  texts: string[];
}

/** A 2D context that records what it was asked to do and rasterises nothing. */
function tallyCtx(t: Tally) {
  const ctx: Record<string, unknown> = {};
  for (const m of CTX_METHODS) ctx[m] = () => { t.ops++; return ctx; };
  ctx.drawImage = () => { t.ops++; t.blits++; return ctx; };
  ctx.fillText = (text: string) => { t.ops++; t.texts.push(text); return ctx; };
  ctx.measureText = (text: string) => ({ width: text.length * 6 });
  ctx.createRadialGradient = () => { t.ops++; t.gradients++; return { addColorStop: () => {} }; };
  ctx.createLinearGradient = () => { t.ops++; t.gradients++; return { addColorStop: () => {} }; };
  ctx.createPattern = () => null;
  ctx.getImageData = (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  ctx.createImageData = (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  return ctx;
}

/** A full herd, so the cost numbers are the cap and not a toy. */
function herd(n = 64) {
  return Array.from({ length: n }, (_, i) => ({
    id: `e${i}`, name: `Resident ${i}`, handle: `r${i}`, genes: "2.1.0.3.1.42.55.62.1",
    mind: { doing: { place: "square", act: "wander" } }, born: 0,
  }));
}

function xfAt(zoom: number, opts: { night?: boolean; follow?: string | null } = {}) {
  const xf = new Xf({ herd: herd() } as never);
  xf.setViewport(VIEW_W, VIEW_H, 1);
  xf.cam.zoom = xf.cam.tz = zoom;
  xf.clock = opts.night ? 0.8 : 0.3;
  if (opts.follow) xf.setFollow(opts.follow);
  return xf;
}

function frameAt(zoom: number, opts: { night?: boolean; follow?: string | null } = {}) {
  const t: Tally = { ops: 0, gradients: 0, blits: 0, texts: [] };
  const ctx = tallyCtx(t) as unknown as CanvasRenderingContext2D;
  xfAt(zoom, opts).draw(ctx, VIEW_W, VIEW_H);
  return t;
}

beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;
  proto.getContext = () => tallyCtx({ ops: 0, gradients: 0, blits: 0, texts: [] });
});

describe("MIN_ZOOM is derived from the world, not pinned", () => {
  it("recomputes from Pe/vt/V and the map's own box", () => {
    expect(Pe * V).toBe(WorldSize.width);
    expect(vt * V).toBe(WorldSize.height);
    expect(MIN_ZOOM).toBeCloseTo(Math.min(FIT_BOX.w / (Pe * V), FIT_BOX.h / (vt * V)), 12);
    // the contain ratio, i.e. one axis is an exact fit rather than a guess
    expect(MIN_ZOOM).toBeCloseTo(Math.min(FIT_BOX.w / WorldSize.width, FIT_BOX.h / WorldSize.height), 12);
  });

  it("still contains the whole world — the invariant, independent of the box", () => {
    // whatever viewport you give it, the furthest-out zoom shows every tile
    expect(WorldSize.width * MIN_ZOOM).toBeLessThanOrEqual(FIT_BOX.w);
    expect(WorldSize.height * MIN_ZOOM).toBeLessThanOrEqual(FIT_BOX.h);
    // and it is the tightest such zoom, so growing the grid can only lower it
    expect(WorldSize.height * MIN_ZOOM).toBeCloseTo(FIT_BOX.h, 6);
    expect(MIN_ZOOM).toBeLessThan(MAX_ZOOM);
  });

  it("is nowhere near the old 0.45 floor, and is what you land on", () => {
    expect(MIN_ZOOM).toBeLessThan(0.1);
    const xf = xfAt(1);
    for (let i = 0; i < 40; i++) xf.zoomAt(VIEW_W / 2, VIEW_H / 2, 0.6);
    expect(xf.cam.zoom).toBe(MIN_ZOOM);
    // 0.45 showed 12% of the town; the derived floor shows all of it, and the
    // floor is a zoom rather than a pixel count so a narrower window simply
    // sees proportionally less (see the framing test below)
    const oldTilesWide = (VIEW_W / 0.45 / V);
    const newTilesWide = (VIEW_W / MIN_ZOOM / V);
    expect(newTilesWide).toBeGreaterThan(Pe - 40);
    expect(oldTilesWide).toBeLessThan(Pe / 8);
  });

  it("frames every one of the 1050x640 tiles from the map's own box", () => {
    // the whole grid, edge to edge, in the widest box the layout ever hands the
    // canvas
    expect(FIT_BOX.w / MIN_ZOOM).toBeGreaterThanOrEqual(Pe * V);
    expect(FIT_BOX.h / MIN_ZOOM).toBeGreaterThanOrEqual(vt * V);
    // the audit measured against an 890px window, which is 29px narrower than
    // the 919px the width needs — height still fits exactly, and the last 33
    // columns are off-screen rather than the town
    const tilesWide = VIEW_W / MIN_ZOOM / V;
    expect(VIEW_H / MIN_ZOOM / V).toBeGreaterThanOrEqual(vt);
    expect(Pe - tilesWide).toBeLessThan(40);
  });
});

describe("what the new floor breaks, audited", () => {
  it("still reaches all four corners of the map at MIN_ZOOM", () => {
    const xf = xfAt(MIN_ZOOM);
    xf.panBy(1e6, 1e6);
    expect(xf.cam.x).toBe(0);
    expect(xf.cam.y).toBe(0);
    xf.panBy(-1e6, -1e6);
    expect(xf.cam.x).toBe(xf.worldW);
    expect(xf.cam.y).toBe(xf.worldH);
  });

  it("keeps at least half the viewport on the map at MIN_ZOOM", () => {
    // the clampCam invariant: the centre stops at the map edge, so the worst
    // case is half a screen of field and half of town
    const xf = xfAt(MIN_ZOOM);
    xf.panBy(1e6, 1e6);
    const halfW = VIEW_W / 2 / MIN_ZOOM;
    const shown = Math.min(xf.worldW, xf.cam.x + halfW) - Math.max(0, xf.cam.x - halfW);
    expect(shown).toBeGreaterThanOrEqual(halfW);
  });

  it("does not drag the camera when you zoom out from a wall", () => {
    const xf = xfAt(1);
    xf.panBy(-1e6, 0);
    const where = xf.cam.tx;
    for (let i = 0; i < 40; i++) xf.zoomAt(VIEW_W / 2, VIEW_H / 2, 0.6);
    expect(xf.cam.zoom).toBe(MIN_ZOOM);
    expect(xf.cam.tx).toBeCloseTo(where, 6);
  });
});

describe("level of detail floors", () => {
  it("are derived from each object's size, and ordered", () => {
    // tag: an 8 screen px caption is only worth drawing when it is no taller
    // than the resident it names, and NPC_H is itself derived from the town
    expect(TAG_MIN_ZOOM).toBeCloseTo(8 / NPC_H, 12);
    expect(NPC_MIN_ZOOM).toBeCloseTo(1.5 / NPC_H, 12);
    expect(SCENERY_MIN_ZOOM).toBeCloseTo(6 / 48, 12);
    expect(GLOW_MIN_ZOOM).toBeCloseTo(6 / 34, 12);
    expect(LABEL_MIN_ZOOM).toBeCloseTo(2 / 7, 12);

    // the whole-town view is below every one of them, and MAX_ZOOM is above
    const floors = [MIN_ZOOM, SCENERY_MIN_ZOOM, NPC_MIN_ZOOM, GLOW_MIN_ZOOM, LABEL_MIN_ZOOM, TAG_MIN_ZOOM];
    for (let i = 1; i < floors.length; i++) expect(floors[i]!).toBeGreaterThan(floors[i - 1]!);
    expect(TAG_MIN_ZOOM).toBeLessThan(MAX_ZOOM);
  });

  it("drops the per-object work at the whole-town zoom", () => {
    const far = frameAt(MIN_ZOOM);
    // no resident sprite blits: 64 offscreen canvases + 64 ImageDatas per frame
    expect(far.blits).toBe(0);
    // no resident name tags, and none of the 100 building labels either
    expect(far.texts.filter((t) => t.startsWith("Resident"))).toHaveLength(0);
    // and none of the 2,400 lamp pools or 738 headlights: no gradient objects
    expect(frameAt(MIN_ZOOM, { night: true }).gradients).toBe(0);

    const near = frameAt(1);
    expect(near.blits).toBeGreaterThan(0);
    expect(near.texts.filter((t) => t.startsWith("Resident")).length).toBeGreaterThan(0);
    expect(frameAt(1, { night: true }).gradients).toBeGreaterThan(0);
  });

  it("keeps the followed resident at any zoom, exactly like their name tag", () => {
    const followed = frameAt(MIN_ZOOM, { follow: "e0" });
    expect(followed.blits).toBeGreaterThan(0);
    expect(followed.texts).toContain("Resident 0");
    // and the other 63 are still skipped
    expect(followed.blits).toBeLessThan(64);
  });

  it("keeps the whole-town frame inside the measured cost ceiling", () => {
    // Measured with the stub context above (890x560, 64 residents, ops issued
    // per frame): 10.5k at the old 0.45 floor and 299k at MIN_ZOOM with no
    // level of detail at all; 49k with it. Rasterisation is NOT included — that
    // is the number only a browser can give. The ceiling is 70k so a future
    // scenery change fails here rather than silently at 2 fps.
    expect(frameAt(MIN_ZOOM).ops).toBeLessThan(70_000);
    expect(frameAt(MIN_ZOOM, { night: true }).ops).toBeLessThan(70_000);
  });
});

describe("the MIN_ZOOM comment", () => {
  it("no longer claims the floor shows a quarter of the map", () => {
    const src = readFileSync(resolve(import.meta.dirname, "../src/canvas/engine.ts"), "utf8");
    expect(src).not.toContain("a quarter of the new map");
    expect(src).not.toContain("MIN_ZOOM is 0.45");
    // and the floor's own derivation is written down where the number is
    const line = src.slice(src.indexOf("export const MIN_ZOOM"));
    expect(line.slice(0, 200)).toContain("WorldSize");
  });
});