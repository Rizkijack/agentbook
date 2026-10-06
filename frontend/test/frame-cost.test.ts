import { describe, it, beforeAll } from "vitest";
import { Xf, MIN_ZOOM, MAX_ZOOM } from "../src/canvas/engine.js";

// Frame cost of the whole draw path, measured rather than asserted.
//
// Camera interaction feels broken — panning and zooming stutter — and the
// camera maths is not the cause: panBy and zoomAt both snap (cam.x = cam.tx),
// so they are 1:1 with the pointer by construction. Stutter means dropped
// frames, which means the draw path is too slow to keep up.
//
// Two previous commits attacked this (7c04568 sprite cache, c377436 baked
// grass tufts) and the report is that it is still not right. This measures both
// canvas op counts AND wall time, because op counts are a proxy: one arc costs
// more than one fillRect, and a scaled transform makes every op pay fill area.
//
// Not an assertion on purpose: a hard ceiling would encode today's numbers as
// law and rot the moment someone legitimately draws more. Run it, read it, judge.

const VIEW_W = 1280;
const VIEW_H = 800;
const BUDGET_US = 16667; // 60fps

/**
 * jsdom has no canvas backend, so `getContext("2d")` returns null and
 * engine.ts's resident sprite path throws on `octx.save()`. That is a harness
 * gap, not a product defect — but it meant the sprite cache added in 7c04568
 * was never exercised by a single test, so "cached" was unverified. Installed
 * once, before any measurement.
 */
let canvasCtxFactory: () => unknown = () => ({});
beforeAll(() => {
  canvasCtxFactory = () => plainCtx();
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext =
    () => canvasCtxFactory();
});

function plainCtx(): CanvasRenderingContext2D {
  const noop = () => undefined;
  const base: Record<string, unknown> = {
    canvas: { width: VIEW_W, height: VIEW_H },
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    putImageData: noop,
  };
  return new Proxy(base as unknown as CanvasRenderingContext2D, {
    get: (t, p) => (p in t ? t[p as string] : noop),
    set: (t, p, v) => {
      t[p as string] = v;
      return true;
    },
  });
}

/** Counts canvas ops. Separate from timing because a Proxy would skew time. */
function countingOps(): { ctx: CanvasRenderingContext2D; total: () => number; top: () => string[] } {
  const counts: Record<string, number> = {};
  let total = 0;
  const noop = () => undefined;
  const known = new Set([
    "canvas", "measureText", "createRadialGradient", "createLinearGradient",
    "getImageData", "createImageData", "putImageData",
  ]);
  const base: Record<string, unknown> = {
    canvas: { width: VIEW_W, height: VIEW_H },
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    createImageData: (w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
    }),
    putImageData: noop,
  };
  const ctx = new Proxy(base as unknown as CanvasRenderingContext2D, {
    get(t, p) {
      const key = String(p);
      if (!known.has(key)) {
        total++;
        counts[key] = (counts[key] ?? 0) + 1;
      }
      return t[key] ?? noop;
    },
    set(t, p, v) {
      t[p as string] = v;
      return true;
    },
  });
  return {
    ctx,
    total: () => total,
    top: () =>
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([k, n]) => `${k} ${n}`)
        .join(" "),
  };
}

/** A resident shaped like the ones movement.test.ts builds. */
function sprite(id: string, x: number, y: number) {
  return {
    id, name: id, handle: id, genes: "", x, y, tx: x, ty: y, path: [],
    facing: 1 as const, doing: "wander", place: "square", mood: 0, born: 0,
    vx: 0, vy: 0, baseSpeed: 1, wanderTimer: 99, walkPhase: 0, idlePhase: 0,
    targetPlace: "square",
  };
}

/** The world with residents in it — a bare Xf has none, so the sprite path never runs. */
function populated(count: number): Xf {
  const xf = new Xf();
  const spread = Math.sqrt(count);
  for (let i = 0; i < count; i++) {
    const cx = 0.2 + 0.6 * ((i % spread) / spread);
    const cy = 0.2 + 0.6 * (Math.floor(i / spread) / spread);
    const a = sprite("r" + i, xf.worldW * cx, xf.worldH * cy);
    a.walkPhase = (i * 0.037) % 1; // stagger so poses are not all identical
    xf.byId.set(a.id, a as never);
  }
  return xf;
}

const RESIDENTS = 64; // the herd size the world actually carries

function at(zoom: number, cx?: number, cy?: number): Xf {
  const xf = populated(RESIDENTS);
  xf.setViewport(VIEW_W, VIEW_H, 1);
  xf.cam.zoom = xf.cam.tz = zoom;
  xf.cam.x = xf.cam.tx = cx ?? xf.worldW / 2;
  xf.cam.y = xf.cam.ty = cy ?? xf.worldH / 2;
  return xf;
}

function measure(label: string, zoom: number): void {
  const timed = at(zoom);
  const tctx = plainCtx();
  for (let i = 0; i < 20; i++) {
    timed.t = i / 60;
    timed.draw(tctx, VIEW_W, VIEW_H);
  }
  const FRAMES = 40;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < FRAMES; i++) {
    timed.t = 100 + i / 60;
    timed.draw(tctx, VIEW_W, VIEW_H);
  }
  const us = Number(process.hrtime.bigint() - t0) / 1000 / FRAMES;

  const probe = countingOps();
  const counted = at(zoom);
  counted.draw(probe.ctx, VIEW_W, VIEW_H);

  console.log(
    `  ${label.padEnd(16)} zoom ${zoom.toFixed(4).padStart(7)}  ` +
      `${probe.total().toString().padStart(6)} ops  ${us.toFixed(0).padStart(6)} us/f  ` +
      `${((us / BUDGET_US) * 100).toFixed(1).padStart(5)}%  ${probe.top()}`,
  );
}

describe("draw frame cost", () => {
  it("measures ops and wall time across the zoom range", () => {
    console.log("");
    console.log(`  viewport ${VIEW_W}x${VIEW_H}  MIN_ZOOM ${MIN_ZOOM.toFixed(4)}  MAX_ZOOM ${MAX_ZOOM}  residents ${RESIDENTS}`);
    console.log("  (wall time is our JS only — rasteriser cost lands on top of it)");
    console.log("");
    measure("whole town", MIN_ZOOM);
    measure("min zoom x2", MIN_ZOOM * 2);
    measure("min zoom x4", MIN_ZOOM * 4);
    measure("mid", 0.5);
    measure("default", 1);
    measure("street level", 2);
    measure("max zoom", MAX_ZOOM);
    console.log("");
  });

  it("measures whether cost follows the viewport or the frame", () => {
    console.log("");
    const run = (name: string, x: number, y: number): void => {
      const xf = at(1, x, y);
      const ctx = plainCtx();
      for (let i = 0; i < 20; i++) xf.draw(ctx, VIEW_W, VIEW_H);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 40; i++) xf.draw(ctx, VIEW_W, VIEW_H);
      const us = Number(process.hrtime.bigint() - t0) / 1000 / 40;
      const probe = countingOps();
      const c = at(1, x, y);
      c.draw(probe.ctx, VIEW_W, VIEW_H);
      console.log(`  pan to ${name.padEnd(14)} ${probe.total().toString().padStart(6)} ops  ${us.toFixed(0).padStart(6)} us/f`);
    };
    run("town square", 6720, 5120);
    run("empty north", 8400, 300);
    run("empty south", 8400, 9800);
    run("far west edge", 200, 5120);
    console.log("");
  });

  it("measures the real hit rate of the resident sprite cache", () => {
    // 7c04568 keys the cache on `at * 15 | 0` among other things. At 60fps a
    // frame advances `at` by 1/60, so `at * 15` advances by 0.25 and the bucket
    // changes on roughly 4 frames out of 5 — the cache should miss most of the
    // time. This counts it rather than reasoning about it.
    console.log("");
    const xf = at(1);
    const ctx = plainCtx();
    const prev = new Map<string, string>();
    let hits = 0;
    let misses = 0;
    const FRAMES = 60;
    for (let f = 0; f < FRAMES; f++) {
      xf.t = 100 + f / 60;
      for (const a of xf.byId.values()) {
        const s = (a as unknown as { sprite?: { key: string } }).sprite;
        if (!s) continue;
        const before = prev.get(a.id);
        if (before !== undefined) (before === s.key ? hits++ : misses++);
        prev.set(a.id, s.key);
      }
      xf.draw(ctx, VIEW_W, VIEW_H);
    }
    const total = hits + misses;
    const rate = total ? (hits / total) * 100 : 0;
    console.log(`  residents ${RESIDENTS}  frames ${FRAMES}`);
    console.log(`  cache hits ${hits}  misses ${misses}  hit rate ${rate.toFixed(1)}%`);
    console.log(`  a cache that misses ${(100 - rate).toFixed(0)}% of the time is not a cache.`);
    console.log("");
  });
});