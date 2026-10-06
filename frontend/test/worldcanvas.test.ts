import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { WorldCanvas } from "../src/canvas/WorldCanvas.js";

// Regression cover for "the camera keeps snapping back to the middle".
// These are the four causes, exercised through the real component:
//   1. a snapshot push rebuilt the engine (and its camera)
//   2. listener registration leaked on every rebuild (one wheel = N zooms)
//   3. a pan gesture also emitted a click, which re-armed follow mode
//   4. DPR transform was wiped each frame, so cursor maths drifted

const VIEW_W = 1200;
const VIEW_H = 560;
const GENES = "2.1.0.3.1.42.55.62.1";

type Snap = { herd: Array<{ id: string; name: string; handle: string; genes: string; mind: { doing: { place: string; act: string } }; born: number }> };

function snap(ids: string[] = ["a1"]): Snap {
  return { herd: ids.map((id) => ({ id, name: id, handle: id, genes: GENES, mind: { doing: { place: "square", act: "wander" } }, born: 0 })) };
}

const CTX_METHODS = [
  "setTransform", "clearRect", "translate", "scale", "rotate", "fillRect", "strokeRect",
  "beginPath", "closePath", "moveTo", "lineTo", "rect", "arc", "arcTo", "ellipse",
  "quadraticCurveTo", "bezierCurveTo", "clip", "fill", "stroke", "setLineDash",
  "fillText", "strokeText", "drawImage", "save", "restore", "putImageData", "getImageData",
];

/** Every setTransform the renderer asked for, so the DPR test can inspect them. */
let transformCalls: number[][] = [];

function installDomStubs() {
  const ctx: Record<string, unknown> = {};
  for (const m of CTX_METHODS) ctx[m] = () => ctx;
  ctx.setTransform = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    transformCalls.push([a, b, c, d, e, f]);
    return ctx;
  };
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
  // jsdom reports 1, which would make a DPR bug invisible — force a real one
  Object.defineProperty(window, "devicePixelRatio", { value: 1.5, configurable: true });
}

/** jsdom has no PointerEvent; MouseEvent + a pointerId reads the same to the handler. */
function pe(type: string, clientX: number, clientY: number, pointerId = 1): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(e, "pointerId", { value: pointerId });
  return e;
}

function xfOf(): any {
  return (window as unknown as Record<string, any>).__hermes_xf;
}

let host: HTMLDivElement;
let root: Root;

function mount(snapshot: Snap) {
  act(() => { root.render(createElement(WorldCanvas, { snapshot })); });
}

function canvasOf(): HTMLCanvasElement {
  return host.querySelector("canvas.town") as HTMLCanvasElement;
}

/** Run the component's rAF loop long enough to paint at least one frame. */
async function paintFrame() {
  transformCalls = [];
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

beforeAll(installDomStubs);

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
});

describe("WorldCanvas camera", () => {
  it("keeps the camera where the user put it when a snapshot arrives", () => {
    mount(snap());

    const xf = xfOf();
    act(() => { xf.panBy(240, 120); });
    const where = { x: xf.cam.tx, y: xf.cam.ty };

    // the SSE store replaces the snapshot object a few times a second
    for (let i = 0; i < 5; i++) mount(snap(["a1", `fork${i}`]));
    act(() => { for (let i = 0; i < 30; i++) xf.tick(1 / 60); });

    expect(xf).toBe(xfOf());          // same engine — not rebuilt
    expect(xf.cam.tx).toBe(where.x);   // still exactly where it was left
    expect(xf.cam.ty).toBe(where.y);
    expect(xf.cam.x).toBeCloseTo(where.x, 4);
    expect(xf.cam.y).toBeCloseTo(where.y, 4);
    expect(xf.byId.has("a1")).toBe(true);
    // each push swapped the herd, so only the latest forks survive
    expect([...xf.byId.keys()].sort()).toEqual(["a1", "fork4"]);
  });

  it("applies one zoom step per wheel event, however many snapshots have arrived", () => {
    mount(snap());
    const xf = xfOf();
    for (let i = 0; i < 6; i++) mount(snap(["a1", `fork${i}`]));

    const canvas = canvasOf();
    act(() => {
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -300 }));
    });
    // one step of exp(300 * 0.0015) — six leaked listeners would cap at 2.8
    expect(xf.cam.zoom).toBeCloseTo(Math.exp(0.45), 6);

    act(() => {
      canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 300 }));
    });
    expect(xf.cam.zoom).toBeCloseTo(1, 6);
  });

  it("pans 1:1 with the pointer", () => {
    mount(snap());
    const xf = xfOf();
    const before = { x: xf.cam.tx, y: xf.cam.ty };
    const canvas = canvasOf();

    act(() => { canvas.dispatchEvent(pe("pointerdown", 600, 300)); });
    act(() => { canvas.dispatchEvent(pe("pointermove", 700, 360)); });
    act(() => { canvas.dispatchEvent(pe("pointerup", 700, 360)); });

    expect(xf.cam.tx).toBeCloseTo(before.x - 100, 4);
    expect(xf.cam.ty).toBeCloseTo(before.y - 60, 4);
  });

  it("does not re-arm follow when the gesture was a pan", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();
    act(() => { xf.setFollow("a1"); });

    act(() => { canvas.dispatchEvent(pe("pointerdown", 600, 300)); });
    act(() => { canvas.dispatchEvent(pe("pointermove", 700, 360)); });
    act(() => { canvas.dispatchEvent(pe("pointerup", 700, 360)); });

    expect(xf.followId).toBeNull();
  });

  it("still follows a resident on a tap, and the camera tracks them", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();
    const a = xf.byId.get("a1");
    const onScreen = (worldX: number, worldY: number) => ({
      x: (worldX - xf.cam.x) * xf.cam.zoom + VIEW_W / 2,
      y: (worldY - xf.cam.y) * xf.cam.zoom + VIEW_H / 2,
    });

    const at = onScreen(a.x, a.y);
    act(() => { canvas.dispatchEvent(pe("pointerdown", at.x, at.y)); });
    act(() => { canvas.dispatchEvent(pe("pointerup", at.x, at.y)); });
    expect(xf.followId).toBe("a1");

    a.x = 1800;
    act(() => { for (let i = 0; i < 200; i++) xf.tick(1 / 60); });
    // what the player sees is cam.x, and the resident keeps breathing in place
    expect(Math.abs(xf.cam.x - xf.byId.get("a1").x)).toBeLessThan(6);
  });

  it("pans with the keyboard and resets with 0", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();
    const start = xf.cam.tx;

    // panBy takes a drag delta, so an arrow key is the negated view direction:
    // ArrowRight shows more of the east, i.e. the camera target moves east
    act(() => { canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(xf.cam.tx).toBeCloseTo(start + 70, 4);
    act(() => { canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })); });
    expect(xf.cam.tx).toBeCloseTo(start, 4);

    act(() => { xf.zoomAt(0, 0, 1.5); });
    act(() => { canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "0", bubbles: true, cancelable: true })); });
    expect(xf.cam.zoom).toBe(1);
    expect(xf.cam.tx).toBe(1600);
  });

  it("paints at the device pixel ratio instead of wiping the DPR transform", async () => {
    mount(snap());
    const xf = xfOf();
    expect(xf.dpr).toBe(1.5);
    const canvas = canvasOf();
    expect(canvas.width).toBe(Math.round(VIEW_W * 1.5));
    expect(canvas.height).toBe(Math.round(VIEW_H * 1.5));

    await paintFrame();
    expect(transformCalls.length).toBeGreaterThan(0);
    // the old frame loop reset to identity every frame, which parked the whole
    // town in the top-left corner on a retina screen
    expect(transformCalls.some((c) => c[0] === 1 && c[3] === 1)).toBe(false);
    for (const c of transformCalls) expect(c[0]).toBe(1.5);
  });

  it("gives the canvas keyboard and screen-reader affordances", () => {
    mount(snap());
    const canvas = canvasOf();
    expect(canvas.classList.contains("town")).toBe(true);
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute("aria-label")).toBeTruthy();
  });

  it("keeps touch panning possible via the stylesheet rule", () => {
    const css = readFileSync(resolve(import.meta.dirname, "../src/styles/tokens.css"), "utf8");
    const rule = css.slice(css.indexOf("canvas.town"));
    expect(rule.slice(0, rule.indexOf("}"))).toContain("touch-action: none");
  });

  it("keeps panning with one finger after a pinch, but never reads it as a tap", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();

    // two fingers down, then one lifted: the survivor must inherit the pan
    act(() => { canvas.dispatchEvent(pe("pointerdown", 500, 300, 1)); });
    act(() => { canvas.dispatchEvent(pe("pointerdown", 700, 300, 2)); });
    act(() => { canvas.dispatchEvent(pe("pointerup", 700, 300, 2)); });

    const before = xf.cam.tx;
    act(() => { canvas.dispatchEvent(pe("pointermove", 560, 300, 1)); });
    expect(xf.cam.tx).toBeCloseTo(before - 60, 4);

    // and lifting that last finger must not turn the pinch into a follow
    act(() => { canvas.dispatchEvent(pe("pointerup", 560, 300, 1)); });
    expect(xf.followId).toBeNull();
  });

  it("ignores a cancelled gesture instead of following whoever is under it", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();
    const a = xf.byId.get("a1");
    const at = {
      x: (a.x - xf.cam.x) * xf.cam.zoom + VIEW_W / 2,
      y: (a.y - xf.cam.y) * xf.cam.zoom + VIEW_H / 2,
    };

    // the browser takes the gesture away (palm rejection / OS gesture) right
    // on top of a resident — that must not set follow
    act(() => { canvas.dispatchEvent(pe("pointerdown", at.x, at.y)); });
    act(() => { canvas.dispatchEvent(pe("pointercancel", at.x, at.y)); });
    expect(xf.followId).toBeNull();
  });

  it("ignores a right-click", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();
    const a = xf.byId.get("a1");
    const at = {
      x: (a.x - xf.cam.x) * xf.cam.zoom + VIEW_W / 2,
      y: (a.y - xf.cam.y) * xf.cam.zoom + VIEW_H / 2,
    };
    const right = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 });
    Object.defineProperty(right, "pointerId", { value: 1 });
    Object.defineProperty(right, "pointerType", { value: "mouse" });

    act(() => { canvas.dispatchEvent(right); });
    act(() => { canvas.dispatchEvent(pe("pointerup", at.x, at.y)); });
    expect(xf.followId).toBeNull();
  });

  it("leaves browser shortcuts alone", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();
    const start = xf.cam.tx;
    const ev = new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { canvas.dispatchEvent(ev); });
    expect(xf.cam.tx).toBe(start);
    // Ctrl+S must still reach the browser
    expect(ev.defaultPrevented).toBe(false);
  });

  it("drops residents the server no longer has, without resetting the ones it keeps", () => {
    mount(snap(["a1", "a2", "a3"]));
    const xf = xfOf();
    const a1 = xf.byId.get("a1");
    a1!.x = 1234;
    expect(xf.byId.size).toBe(3);

    // the engine is built once now, so a shrinking herd has to be applied
    mount(snap(["a1", "fork0"]));
    expect(xf.byId.size).toBe(2);
    expect(xf.byId.has("a2")).toBe(false);
    // and the survivor keeps its position — a delete-all-then-readd would blink
    expect(xf.byId.get("a1")).toBe(a1);
    expect(xf.byId.get("a1")!.x).toBe(1234);
  });

  it("detaches every listener on unmount", () => {
    mount(snap());
    const xf = xfOf();
    const canvas = canvasOf();
    const zoom = xf.cam.zoom;
    const tx = xf.cam.tx;

    act(() => { root.unmount(); });
    expect(xfOf()).toBeUndefined();

    // no listener may survive to touch a torn-down world
    canvas.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -300 }));
    canvas.dispatchEvent(pe("pointerdown", 100, 100));
    canvas.dispatchEvent(pe("pointermove", 300, 300));
    expect(xf.cam.zoom).toBe(zoom);
    expect(xf.cam.tx).toBe(tx);

    // the window resize listener must be gone too
    const width = canvas.width;
    window.dispatchEvent(new Event("resize"));
    expect(canvas.width).toBe(width);

    root = createRoot(host); // re-mount so afterEach can unmount cleanly
  });
});
