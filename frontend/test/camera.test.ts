import { describe, it, expect } from "vitest";
import { Xf, MIN_ZOOM, MAX_ZOOM } from "../src/canvas/engine.js";
import { LOCATIONS } from "../src/canvas/locationsData.js";
import { V } from "../src/canvas/constants.js";

const VIEW_W = 1200;
const VIEW_H = 560;

function makeXf() {
  const xf = new Xf();
  xf.setViewport(VIEW_W, VIEW_H, 1);
  return xf;
}

describe("camera pan", () => {
  it("tracks the pointer 1:1 in screen pixels", () => {
    const xf = makeXf();
    const x0 = xf.cam.x;
    const y0 = xf.cam.y;
    xf.panBy(100, 40);
    // dragging right/down moves the view left/up, scaled by zoom — measured from
    // wherever the camera opened, which is the square and not a literal 1600/900
    expect(xf.cam.x).toBeCloseTo(x0 - 100, 6);
    expect(xf.cam.y).toBeCloseTo(y0 - 40, 6);
    // and it is already there — no easing lag behind the finger
    expect(xf.cam.x).toBe(xf.cam.tx);
    expect(xf.cam.y).toBe(xf.cam.ty);
  });

  it("scales the pan by zoom so the same drag covers less world when zoomed in", () => {
    const a = makeXf();
    const b = makeXf();
    b.zoomAt(VIEW_W / 2, VIEW_H / 2, 2);
    a.panBy(80, 0);
    b.panBy(80, 0);
    // a moved 80 world px, b moved 40 — same finger travel, half the ground
    expect(b.cam.tx - a.cam.tx).toBeCloseTo(40, 6);
  });

  it("does not drift back to centre after a pan", () => {
    const xf = makeXf();
    const before = { x: xf.cam.tx, y: xf.cam.ty };
    xf.panBy(-500, -260);
    const after = { x: xf.cam.tx, y: xf.cam.ty };
    for (let i = 0; i < 600; i++) xf.tick(1 / 60);
    expect(xf.cam.tx).toBeCloseTo(after.x, 6);
    expect(xf.cam.ty).toBeCloseTo(after.y, 6);
    expect(xf.cam.tx).not.toBeCloseTo(before.x, 1);
  });
});

describe("camera zoom", () => {
  it("keeps the world point under the cursor pinned to the cursor", () => {
    const xf = makeXf();
    const px = 300;
    const py = 120;
    const worldBefore = {
      x: xf.cam.x + (px - VIEW_W / 2) / xf.cam.zoom,
      y: xf.cam.y + (py - VIEW_H / 2) / xf.cam.zoom,
    };
    xf.zoomAt(px, py, 1.6);
    expect(xf.cam.zoom).toBeCloseTo(1.6, 6);
    expect(xf.cam.x + (px - VIEW_W / 2) / xf.cam.zoom).toBeCloseTo(worldBefore.x, 4);
    expect(xf.cam.y + (py - VIEW_H / 2) / xf.cam.zoom).toBeCloseTo(worldBefore.y, 4);
  });

  it("clamps to the zoom limits in both directions", () => {
    const xf = makeXf();
    for (let i = 0; i < 40; i++) xf.zoomAt(VIEW_W / 2, VIEW_H / 2, 1.5);
    expect(xf.cam.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 80; i++) xf.zoomAt(VIEW_W / 2, VIEW_H / 2, 0.7);
    expect(xf.cam.zoom).toBe(MIN_ZOOM);
  });
});

describe("camera bounds", () => {
  it("stops the view at the town edge instead of letting it wander off", () => {
    const xf = makeXf();
    // The wall is the map edge itself: the view CENTRE stops at 0 / worldW, so
    // at least half the viewport is always town and the rest is open field in
    // the same colour as the ground. panBy takes a drag delta, so a positive
    // delta moves the camera west.
    xf.panBy(100000, 100000);
    expect(xf.cam.x).toBe(0);
    expect(xf.cam.y).toBe(0);
    xf.panBy(-100000, -100000);
    expect(xf.cam.x).toBe(xf.worldW);
    expect(xf.cam.y).toBe(xf.worldH);
  });

  it("keeps the centre over the map even when the view is wider than the map", () => {
    const xf = new Xf();
    // a viewport wider than the whole town: there is no way to fill the screen,
    // so the camera settles at the edge — and at least half the view still
    // shows the map, which is the real invariant.
    // Pan far enough to actually hit the edge: the map is now 5x larger, so a
    // fixed 5000 no longer reaches it from the opening view.
    xf.setViewport(xf.worldW * 2, xf.worldH * 2, 1);
    xf.panBy(xf.worldW, xf.worldH);
    expect(xf.cam.x).toBe(0);
    expect(xf.cam.y).toBe(0);
    const halfW = xf.viewW / 2;
    const shown = Math.min(xf.worldW, xf.cam.x + halfW) - Math.max(0, xf.cam.x - halfW);
    expect(shown).toBeGreaterThanOrEqual(halfW);
  });

  it("still allows roaming the whole map at minimum zoom", () => {
    const xf = makeXf();
    for (let i = 0; i < 20; i++) xf.zoomAt(VIEW_W / 2, VIEW_H / 2, 0.5);
    expect(xf.cam.zoom).toBe(MIN_ZOOM);
    // The zoom-dependent band used to collapse to 614 world px around the
    // centre at MIN_ZOOM — the player was walled in the middle of town. The
    // wall is the map edge now, so the whole town is reachable.
    xf.panBy(100000, 100000);
    expect(xf.cam.x).toBe(0);
    expect(xf.cam.x).toBe(xf.cam.tx);
    xf.panBy(-100000, -100000);
    expect(xf.cam.x).toBe(xf.worldW);
  });

  it("never moves the camera because you zoomed out (measured 752,9 world px yank)", () => {
    const xf = makeXf();
    // Reproduce the bug from Chrome: pan hard against the east wall at zoom 1,
    // then scroll all the way out. The old band shrank with the zoom and
    // clamped the camera 2744 -> 1991, straight back toward the middle.
    xf.panBy(-100000, 0);
    expect(xf.cam.x).toBe(xf.worldW);
    const where = { x: xf.cam.tx, y: xf.cam.ty };
    for (let i = 0; i < 20; i++) xf.zoomAt(VIEW_W / 2, VIEW_H / 2, 0.5);
    expect(xf.cam.zoom).toBe(MIN_ZOOM);
    expect(xf.cam.tx).toBeCloseTo(where.x, 6);
    expect(xf.cam.ty).toBeCloseTo(where.y, 6);
    // and it stays there on its own
    for (let i = 0; i < 300; i++) xf.tick(1 / 60);
    expect(xf.cam.tx).toBeCloseTo(where.x, 6);
    expect(xf.cam.ty).toBeCloseTo(where.y, 6);
  });

  it("never drifts back to the opening view on its own", () => {
    const xf = makeXf();
    xf.panBy(-400, -200);
    const where = { x: xf.cam.tx, y: xf.cam.ty };
    expect(where.x).not.toBe(1600);
    expect(where.y).not.toBe(900);
    for (let i = 0; i < 600; i++) xf.tick(1 / 60);
    expect(xf.cam.tx).toBeCloseTo(where.x, 6);
    expect(xf.cam.ty).toBeCloseTo(where.y, 6);
  });

  it("is a no-op clamp when the camera is already inside the map", () => {
    const xf = makeXf();
    const x = xf.cam.tx;
    xf.clampCam();
    expect(xf.cam.tx).toBe(x);
  });
});

describe("manual input wins over follow mode", () => {
  it("pan releases follow and the camera stays put afterwards", () => {
    const xf = makeXf();
    xf.byId.set("a", sprite("a", 1600, 900));
    xf.setFollow("a");
    for (let i = 0; i < 120; i++) xf.tick(1 / 60);
    expect(xf.followId).toBe("a");
    // cam.x is what the player sees; tick lerps it toward the target, and the
    // resident may still take one idle step on the final frame
    expect(Math.abs(xf.cam.x - xf.byId.get("a")!.x)).toBeLessThan(4);

    xf.panBy(120, 0);
    expect(xf.followId).toBeNull();
    const where = xf.cam.tx;
    // the followed agent keeps walking — the camera must not chase it back
    xf.byId.get("a")!.x = 2200;
    for (let i = 0; i < 300; i++) xf.tick(1 / 60);
    expect(xf.cam.tx).toBeCloseTo(where, 6);
  });

  it("zoom releases follow too", () => {
    const xf = makeXf();
    xf.byId.set("a", sprite("a", 1600, 900));
    xf.setFollow("a");
    xf.zoomAt(0, 0, 1.5);
    expect(xf.followId).toBeNull();
  });

  it("drops follow when the followed agent is gone", () => {
    const xf = makeXf();
    xf.byId.set("a", sprite("a", 1600, 900));
    xf.setFollow("a");
    xf.byId.delete("a");
    xf.tick(1 / 60);
    expect(xf.followId).toBeNull();
  });

  it("reset returns to the opening view and clears follow", () => {
    const xf = makeXf();
    const homeX = xf.cam.tx;
    const homeY = xf.cam.ty;
    xf.setFollow("a");
    xf.zoomAt(10, 10, 2);
    xf.panBy(600, 300);
    xf.resetCam();
    expect(xf.followId).toBeNull();
    // the opening view is the town square, derived rather than pinned — it was
    // the literal 1600/900 only while the map was 210x128
    expect(xf.cam.tx).toBe(homeX);
    expect(xf.cam.ty).toBe(homeY);
    const square = LOCATIONS.find((l) => l.id === "square")!;
    expect(xf.cam.tx).toBe((square.x + square.w / 2) * V);
    expect(xf.cam.zoom).toBe(1);
    expect(xf.cam.tx).toBe(xf.cam.x);
  });
});

describe("free cam", () => {
  it("releasing follow stops the camera dead instead of easing to the target", () => {
    const xf = makeXf();
    xf.byId.set("a", sprite("a", 2600, 1400));
    xf.setFollow("a");
    for (let i = 0; i < 5; i++) xf.tick(1 / 60);
    expect(xf.cam.tx).not.toBe(xf.cam.x); // still mid-chase

    xf.setFollow(null); // Free Cam
    const frozen = { x: xf.cam.x, y: xf.cam.y };
    expect(xf.cam.tx).toBe(frozen.x);
    expect(xf.cam.ty).toBe(frozen.y);
    for (let i = 0; i < 300; i++) xf.tick(1 / 60);
    expect(xf.cam.x).toBeCloseTo(frozen.x, 6);
    expect(xf.cam.y).toBeCloseTo(frozen.y, 6);
  });

  it("reports every follow change so the HUD cannot lie about it", () => {
    const xf = makeXf();
    const seen: Array<string | null> = [];
    xf.onFollow = (id) => seen.push(id);
    xf.setFollow("a");
    xf.setFollow("a"); // same resident again — no duplicate
    xf.setFollow(null); // Free Cam
    xf.setFollow(null); // already free — no duplicate
    expect(seen).toEqual(["a", null]);
  });

  it("still releases follow through a pan, a zoom, reset and a vanished agent", () => {
    const xf = makeXf();
    const seen: Array<string | null> = [];
    xf.onFollow = (id) => seen.push(id);
    for (const release of [
      () => { xf.byId.set("a", sprite("a", 1600, 900)); xf.setFollow("a"); xf.panBy(10, 10); },
      () => { xf.byId.set("a", sprite("a", 1600, 900)); xf.setFollow("a"); xf.zoomAt(0, 0, 1.2); },
      () => { xf.byId.set("a", sprite("a", 1600, 900)); xf.setFollow("a"); xf.resetCam(); },
      () => { xf.byId.set("a", sprite("a", 1600, 900)); xf.setFollow("a"); xf.byId.delete("a"); xf.tick(1 / 60); },
    ]) {
      release();
      expect(xf.followId).toBeNull();
      expect(seen[seen.length - 1]).toBeNull();
    }
  });
});

function sprite(id: string, x: number, y: number) {
  return {
    id, name: id, handle: id, genes: "", x, y, tx: x, ty: y, path: [],
    facing: 1 as const, doing: "wander", place: "square", mood: 0, born: 0,
    vx: 0, vy: 0, baseSpeed: 1, wanderTimer: 99, walkPhase: 0, idlePhase: 0,
    targetPlace: "square",
  };
}
