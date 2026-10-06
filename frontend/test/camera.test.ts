import { describe, it, expect } from "vitest";
import { Xf, MIN_ZOOM, MAX_ZOOM } from "../src/canvas/engine.js";

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
    xf.panBy(100, 40);
    // dragging right/down moves the view left/up, scaled by zoom
    expect(xf.cam.x).toBeCloseTo(x0 - 100, 6);
    expect(xf.cam.y).toBeCloseTo(900 - 40, 6);
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
  it("never lets the view leave the town", () => {
    const xf = makeXf();
    // zoom 1 over a 1200x560 view on a 3360x2048 map: the camera can put the
    // view flush against any edge, and no further. panBy is a drag delta, so a
    // positive delta moves the camera west.
    xf.panBy(100000, 100000);
    expect(xf.cam.x).toBe(VIEW_W / 2);
    expect(xf.cam.y).toBe(VIEW_H / 2);
    xf.panBy(-100000, -100000);
    expect(xf.cam.x).toBe(xf.worldW - VIEW_W / 2);
    expect(xf.cam.y).toBe(xf.worldH - VIEW_H / 2);
  });

  it("pins to the world centre when the view is larger than the map", () => {
    const xf = new Xf();
    // a viewport wider than the whole town: the camera has nowhere to go
    xf.setViewport(xf.worldW * 2, xf.worldH * 2, 1);
    xf.panBy(5000, 5000);
    expect(xf.cam.x).toBeCloseTo(xf.worldW / 2, 6);
    expect(xf.cam.y).toBeCloseTo(xf.worldH / 2, 6);
  });

  it("still allows roaming the whole map at minimum zoom", () => {
    const xf = makeXf();
    for (let i = 0; i < 20; i++) xf.zoomAt(VIEW_W / 2, VIEW_H / 2, 0.5);
    expect(xf.cam.zoom).toBe(MIN_ZOOM);
    // zoomed all the way out the view is narrower than the map, so the camera
    // can reach both edges — the user is not walled in the middle
    xf.panBy(100000, 100000);
    expect(xf.cam.x).toBeCloseTo(VIEW_W / (2 * MIN_ZOOM), 6);
    xf.panBy(-100000, -100000);
    expect(xf.cam.x).toBeCloseTo(xf.worldW - VIEW_W / (2 * MIN_ZOOM), 6);
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
    xf.setFollow("a");
    xf.zoomAt(10, 10, 2);
    xf.panBy(600, 300);
    xf.resetCam();
    expect(xf.followId).toBeNull();
    expect(xf.cam.tx).toBe(1600);
    expect(xf.cam.ty).toBe(900);
    expect(xf.cam.zoom).toBe(1);
    expect(xf.cam.tx).toBe(xf.cam.x);
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
