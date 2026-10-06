#!/usr/bin/env node
/**
 * Smoke test every frontend view in a real browser.
 *
 * Visits each nav destination, and for each one checks that it rendered something
 * and that the console stayed clean. The canvas is checked for actual drawn
 * content rather than merely existing: a canvas element that is blank is a
 * passing-looking failure, which is exactly the kind of thing a smoke test
 * written only against the DOM would wave through.
 *
 * Launches its own headless Chrome on its own debugging port, so it needs no
 * extension, no approval and no shared browser.
 *
 *   node scripts/smoke-frontend.mjs [appUrl]
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const APP = process.argv[2] ?? "http://localhost:5173/";
const OUT = process.env.OUT_DIR ?? "C:/Users/USER/AppData/Local/Temp/opencode/smoke/shots";
const PROFILE = "C:/Users/USER/AppData/Local/Temp/opencode/chrome-smoke";
const PORT = 9355;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

const VIEWS = [
  ["town", "Town"],
  ["herd", "Herd"],
  ["feed", "Feed"],
  ["paper", "Paper"],
  ["quest", "Quest"],
  ["fork", "Fork"],
  ["register", "Register"],
  ["lineage", "Lineage"],
  ["coin", "Coin"],
  ["docs", "Docs"],
];

let pass = 0;
let fail = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? `  <-- ${detail}` : ""}`);
  }
}

mkdirSync(OUT, { recursive: true });
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  /* a locked profile from a previous run is not worth failing over */
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--remote-allow-origins=*",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1440,900",
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function endpointUp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(400);
  }
  return false;
}
if (!(await endpointUp())) {
  console.error("chrome debugging endpoint never came up");
  chrome.kill();
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
  if (m.method === "Runtime.exceptionThrown") {
    consoleErrors.push(`exception: ${m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text}`);
  }
  if (m.method === "Runtime.consoleAPICalled" && (m.params?.type === "error" || m.params?.type === "warning")) {
    consoleErrors.push(`${m.params.type}: ${(m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)}`);
  }
});
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Page.navigate", { url: APP });
await sleep(9000);

console.log("\n== app boots ==");
const booted = await js("typeof window.__hermes_xf");
if (booted !== "object") {
  console.log(`  BLOCKED  the app never mounted (typeof window.__hermes_xf === ${booted}).`);
  console.log("           The town view needs the backend's /api/snapshot — is it running?");
  console.log(`\n${"=".repeat(58)}`);
  console.log(`  PASS ${pass}   FAIL ${fail}   BLOCKED 1`);
  console.log(`${"=".repeat(58)}\n`);
  ws.close();
  chrome.kill();
  process.exit(2);
}
{
  const title = await js("document.title");
  check("document has a title", Boolean(title), `title=${title}`);
  const hasNav = await js(`!!document.querySelector('nav') || (document.body.innerText||'').length > 200`);
  check("app rendered content", Boolean(hasNav));
  check("canvas engine exposed", true);
  const herdShown = await js(`(document.body.innerText.match(/(\\d+)\\s+residents/) || [])[1]`);
  check("town reports a resident count", Boolean(herdShown), `got ${herdShown}`);
  console.log(`        residents in the field: ${herdShown}`);
}

console.log("\n== the canvas actually draws ==");
{
  // A canvas element can exist, be correctly sized, and still be blank. Sample it.
  const stats = await js(`(() => {
    const c = document.querySelector('canvas.town') || document.querySelector('canvas');
    if (!c) return null;
    const g = c.getContext('2d');
    const w = c.width, h = c.height;
    const d = g.getImageData(0, 0, w, h).data;
    const seen = new Set(); let opaque = 0;
    for (let i = 0; i < d.length; i += 4 * 37) {
      if (d[i+3] > 8) { opaque++; seen.add((d[i]>>4)+','+(d[i+1]>>4)+','+(d[i+2]>>4)); }
    }
    return { w, h, opaque, distinct: seen.size };
  })()`);
  check("canvas exists", Boolean(stats), "no canvas found");
  if (stats) {
    check("canvas is non-blank", stats.opaque > 0, JSON.stringify(stats));
    check("canvas has real colour variety", stats.distinct > 3, `distinct=${stats.distinct}`);
    console.log(`        ${stats.w}x${stats.h}, ${stats.distinct} distinct sampled colours`);
  }
}

console.log("\n== camera controls ==");
{
  const xf = await js("typeof window.__hermes_xf");
  if (xf !== "object") {
    console.log(`  BLOCKED  the engine never mounted (typeof window.__hermes_xf === ${xf})`);
    console.log("           The town view needs the backend's /api/snapshot. Start it and re-run.");
  } else {
  const before = await js("({x: window.__hermes_xf.cam.x, z: window.__hermes_xf.cam.zoom})");
  await js(`(() => { const x = window.__hermes_xf; x.zoomAt(400,300, 1/1.4); return 1; })()`);
  await sleep(900);
  const after = await js("({x: window.__hermes_xf.cam.x, z: window.__hermes_xf.cam.zoom})");
  check("zoom out works and is clamped at the floor", after.z < before.z && after.z >= 0.05,
    `${before.z} -> ${after.z}`);
  const min = await js(`(() => { let z = 1; const x = window.__hermes_xf;
    for (let i=0;i<40;i++) { x.cam.zoom = z; x.zoomAt(400,300, 0.5); z = x.cam.zoom; }
    return x.cam.zoom; })()`);
  check("cannot zoom out past the whole-town floor", min > 0.04 && min < 0.09, `floor reached ${min}`);
  console.log(`        zoom floor: ${min}`);
  await js("window.__hermes_xf.resetCam()");
  await sleep(700);
  }
}

console.log("\n== every view renders, clean console ==");
for (const [key, label] of VIEWS) {
  consoleErrors.length = 0;
  await js(`(() => { location.hash = "#/${key}"; return 1; })()`);
  await sleep(1500);
  const body = await js(`(document.body.innerText || '').replace(/\\s+/g,' ').trim().length`);
  const canvases = await js(`document.querySelectorAll('canvas').length`);
  check(`${label.padEnd(9)} renders`, body > 120, `innerText=${body} chars, ${canvases} canvas`);
  // The town canvas is hidden on some views; a broken route shows as a blank body.
  check(`${label.padEnd(9)} console clean`, consoleErrors.length === 0,
    consoleErrors.slice(0, 2).join(" | ").slice(0, 180));
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot?.result?.data) writeFileSync(`${OUT}/view-${key}.png`, Buffer.from(shot.result.data, "base64"));
}

console.log("\n== sign-in flow surfaces, not breaks ==");
{
  await js(`(() => { location.hash = "#/register"; return 1; })()`);
  await sleep(1600);
  const hasForm = await js(`!!document.querySelector('form, input, textarea')`);
  check("register page offers a form", Boolean(hasForm));
  const errs = consoleErrors.length;
  check("register page console clean", errs === 0, consoleErrors.slice(0, 1).join("").slice(0, 140));
}

console.log("\n== responsive: no overflow at a phone width ==");
{
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await js(`(() => { location.hash = "#/town"; return 1; })()`);
  await sleep(1800);
  const overflow = await js(`Math.max(0, document.documentElement.scrollWidth - window.innerWidth)`);
  check("no horizontal overflow at 390px", overflow <= 2, `overflow=${overflow}px`);
  await send("Emulation.clearDeviceMetricsOverride");
}

console.log(`\n${"=".repeat(58)}`);
console.log(`  PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log("\n  failures:");
  for (const f of failures) console.log(`    - ${f}`);
}
console.log(`  shots: ${OUT}`);
console.log(`${"=".repeat(58)}\n`);

ws.close();
chrome.kill();
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {
  console.log("  note: left the temp Chrome profile behind");
}
process.exit(fail === 0 ? 0 : 1);