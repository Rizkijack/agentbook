// Screenshot the live map from chosen vantage points, headlessly.
//
// Chrome's --screenshot flag alone cannot pan the camera, and driving it through
// the desktop browser harness needs a per-connection "Allow remote debugging"
// approval. This launches its own headless Chrome on its own debugging port, so
// there is nothing to approve and nothing to bill.
//
// The camera is moved through the same window.__hermes_xf the app already
// exposes, then read back so the log states where each shot was actually taken.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const URL_APP = process.env.APP_URL ?? "http://localhost:5173/";
const OUT = process.env.OUT_DIR ?? "C:/Users/USER/AppData/Local/Temp/opencode/shots";
const W = 1600, H = 900;

const SHOTS = [
  { name: "1-town-square", theme: "light", x: 524, y: 315, zoom: 1, note: "the original core" },
  { name: "2-northgate", theme: "light", x: 520, y: 178, zoom: 1, note: "Northgate district" },
  { name: "3-ironworks", theme: "light", x: 240, y: 150, zoom: 1, note: "Ironworks + quarry" },
  { name: "4-wharf", theme: "light", x: 260, y: 420, zoom: 1, note: "Riverside Wharf" },
  { name: "5-commons", theme: "light", x: 795, y: 302, zoom: 1, note: "The Commons" },
  { name: "6-university", theme: "light", x: 810, y: 150, zoom: 1, note: "University Quarter" },
  { name: "7-farm-hollow", theme: "light", x: 700, y: 480, zoom: 1, note: "Farm Belt / Hollowmere" },
  { name: "8-whole-map", theme: "light", x: 525, y: 320, zoom: 0.14, note: "the entire 1050x640 grid" },
  { name: "9-whole-map-dark", theme: "dark", x: 525, y: 320, zoom: 0.14, note: "same, dark theme" },
  { name: "10-as Moor-peat", theme: "light", x: 200, y: 558, zoom: 1, note: "Ashen Moor peat works" },
  // MIN_ZOOM is 0.45, so this is the furthest a player can actually pull back
  { name: "11-min-zoom-core", theme: "light", x: 525, y: 320, zoom: 0.45, note: "MIN_ZOOM over the core" },
  { name: "12-min-zoom-north", theme: "light", x: 520, y: 240, zoom: 0.45, note: "MIN_ZOOM, core + Northgate" },
  // Parcel-framed: each district is wider than a zoom-1 viewport, so its dashed
  // boundary and name only read from further out. These are below MIN_ZOOM on
  // purpose — they check the drawing, not what a player can currently reach.
  { name: "13-parcel-northgate", theme: "light", x: 518, y: 175, zoom: 0.26, note: "Northgate parcel, all four edges" },
  { name: "14-parcel-commons", theme: "light", x: 797, y: 302, zoom: 0.3, note: "The Commons parcel" },
  { name: "15-parcel-wharf", theme: "light", x: 263, y: 422, zoom: 0.32, note: "Riverside Wharf parcel" },
];

const profile = "C:/Users/USER/AppData/Local/Temp/opencode/chrome-shots";
// A previous headless Chrome may still hold the profile lock for a second after
// exit. Not worth failing the whole run over a stale temp dir.
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
} catch {
  console.log("note: could not clear the old profile dir; reusing it");
}
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`,
  "about:blank",
], { stdio: "ignore" });

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out`)); }
    }, 45000);
  });
}

async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result?.value;
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("Chrome debugging endpoint never came up");
}

try {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP socket failed"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable").catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", {
    width: W, height: H, deviceScaleFactor: 1, mobile: false,
  });

  await send("Page.navigate", { url: URL_APP });
  // the app fetches /api/snapshot then starts a render loop; give it real time
  await sleep(9000);

  // The sim clock was at 03:59 AM, which renders the whole town in the night
  // palette and makes a screenshot near useless for judging the map. Force noon.
  const clock = await evaluate(`(() => {
    const xf = window.__hermes_xf;
    xf.clock = 0.42;              // late morning
    return { clock: xf.clock };
  })()`);
  console.log("clock forced to:", JSON.stringify(clock));

  const ready = await evaluate(`(() => {
    const xf = window.__hermes_xf;
    if (!xf) return { ok: false, why: "no __hermes_xf" };
    return { ok: true, agents: xf.byId ? xf.byId.size : -1,
             cam: { x: xf.cam.x, y: xf.cam.y, zoom: xf.cam.zoom },
             world: { w: xf.worldW, h: xf.worldH } };
  })()`);
  console.log("page ready:", JSON.stringify(ready));
  if (!ready?.ok) throw new Error(`engine not ready: ${JSON.stringify(ready)}`);

  const errors = await evaluate(`(window.__errs ?? []).slice(0, 5)`);
  if (errors?.length) console.log("page errors:", JSON.stringify(errors));

  for (const s of SHOTS) {
    // tiles -> world px, then let the camera settle on the target.
    // The clock is re-pinned every shot: a town day is short, so it walks out of
    // daylight while the previous frame is still settling.
    const info = await evaluate(`(() => {
      document.documentElement.setAttribute("data-theme", ${JSON.stringify(s.theme)});
      const xf = window.__hermes_xf;
      xf.setFollow?.(null);
      xf.clock = 0.42;
      xf.cam.x = xf.cam.tx = ${s.x} * 16;
      xf.cam.y = xf.cam.ty = ${s.y} * 16;
      xf.cam.zoom = xf.cam.tz = ${s.zoom};
      xf.clampCam();
      return { cam: { x: xf.cam.x, y: xf.cam.y, zoom: xf.cam.zoom },
               theme: document.documentElement.getAttribute("data-theme"),
               night: xf.nightIntensity(),
               world: { w: xf.worldW, h: xf.worldH } };
    })()`);
    await sleep(2600); // let a few frames draw at the new camera
    // re-pin the clock once more: 2.6 s of sim time is enough to drift into dusk
    await evaluate(`(() => { const xf = window.__hermes_xf; xf.clock = 0.42; })()`);
    await sleep(500);
    const shot = await send("Page.captureScreenshot", { format: "png" });
    const file = `${OUT}/${s.name}.png`;
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(
      `${s.name.padEnd(18)} ${info.theme.padEnd(5)} tile(${s.x},${s.y}) zoom ${s.zoom} ` +
      `-> cam(${Math.round(info.cam.x)},${Math.round(info.cam.y)}) night ${info.night.toFixed(2)} ` +
      `world ${info.world.w}x${info.world.h}  ${(shot.data.length * 0.75 / 1024).toFixed(0)}kb  ${s.note}`,
    );
  }

  // What is that pale bar across the lower-left of the canvas? Ask the DOM
  // directly instead of guessing from pixels.
  const probe = await evaluate(`(() => {
    const cv = document.querySelector("canvas.town");
    if (!cv) return { why: "no canvas.town" };
    const r = cv.getBoundingClientRect();
    const pts = [[0.35, 0.95], [0.5, 0.93], [0.15, 0.9]];
    return pts.map(([fx, fy]) => {
      const x = r.left + r.width * fx, y = r.top + r.height * fy;
      const els = document.elementsFromPoint(x, y).slice(0, 4);
      return {
        at: [Math.round(x), Math.round(y)],
        stack: els.map(e => e.tagName.toLowerCase() +
          (e.className ? "." + String(e.className).split(" ").filter(Boolean).slice(0,2).join(".") : "") +
          " [" + (e.textContent ?? "").trim().slice(0, 42).replace(/\\s+/g, " ") + "]"),
      };
    });
  })()`);
  console.log("DOM probe under the pale bar:");
  for (const p of probe ?? []) console.log("  ", p.at.join(","), "->", p.stack.join("  |  "));

  // Census from the live app, which is the only place the real numbers exist.
  const census = await evaluate(`(() => {
    const mods = window.__hermes_scenery ?? null;
    const xf = window.__hermes_xf;
    return { hasSceneryModule: !!mods, agents: xf.byId.size };
  })()`);
  console.log("engine probe:", JSON.stringify(census));

  // a last look at where the residents actually are, in tiles
  const spread = await evaluate(`(() => {
    const xf = window.__hermes_xf;
    const tiles = [...xf.byId.values()].map(a => [Math.floor(a.x/16), Math.floor(a.y/16)]);
    const xs = tiles.map(t => t[0]), ys = tiles.map(t => t[1]);
    return { n: tiles.length,
             x: [Math.min(...xs), Math.max(...xs)],
             y: [Math.min(...ys), Math.max(...ys)],
             inCore: tiles.filter(t => t[0] > 430 && t[0] < 620 && t[1] > 270 && t[1] < 370).length };
  })()`);
  console.log("resident spread (tiles):", JSON.stringify(spread));
  console.log(`\nwrote ${SHOTS.length} shots to ${OUT}`);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(1500);
  // Chrome can hold the profile lock well past its own exit on Windows; the
  // shots are already written, so a failure here must not fail the run.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 });
  } catch { console.log("note: left the temp Chrome profile behind"); }
}