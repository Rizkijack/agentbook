import { LOCATIONS } from "./locationsData.js";
import { V } from "./constants.js";

// ---------------------------------------------------------------------------
// Scenery: roads, forest, trees, street furniture, vehicles, traffic lights.
// Everything deterministic (hash-based) so the world looks the same each frame.
// ---------------------------------------------------------------------------

export interface QueueItem { y: number; draw: () => void; }
export interface View { l: number; r: number; t: number; b: number; }
export interface SceneDraw { isDark: boolean; night: number; time: number; }

interface RoadRect { x1: number; y1: number; x2: number; y2: number; } // tiles, inclusive

// Road network (2 tiles wide, verified against LOCATIONS footprints)
export const ROADS: RoadRect[] = [
  { x1: 42, y1: 76, x2: 202, y2: 77 }, // Main St (horizontal)
  { x1: 50, y1: 40, x2: 170, y2: 41 }, // North St
  { x1: 12, y1: 88, x2: 74, y2: 89 },  // Orchard Lane
  { x1: 12, y1: 44, x2: 13, y2: 100 }, // West Loop
  { x1: 63, y1: 34, x2: 64, y2: 113 }, // West Ave
  { x1: 114, y1: 40, x2: 115, y2: 113 }, // Center Ave
  { x1: 128, y1: 36, x2: 129, y2: 111 }, // East Ave
  { x1: 156, y1: 36, x2: 157, y2: 107 }, // Station Rd
];

// Intersections of h-road and v-road -> traffic lights
interface Light { ix: number; iy: number; cx: number; cy: number; x: number; y: number; }
const H_ROADS = ROADS.filter((r) => r.y2 - r.y1 < r.x2 - r.x1);
const V_ROADS = ROADS.filter((r) => r.x2 - r.x1 <= r.y2 - r.y1);

export const LIGHTS: Light[] = [];
for (const h of H_ROADS) {
  for (const v of V_ROADS) {
    if (v.x1 <= h.x2 && v.x2 >= h.x1 && v.y1 <= h.y2 && v.y2 >= h.y1) {
      const ix = v.x1, iy = h.y1;
      LIGHTS.push({
        ix, iy,
        cx: (ix + 1) * V, cy: (iy + 1) * V,
        x: ix * V - 8, y: iy * V - 8,
      });
    }
  }
}

function h2(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >> 13)) * 1274126177;
  return ((n ^ (n >> 16)) >>> 0) / 4294967295;
}

function insideRect(tx: number, ty: number, r: { x: number; y: number; w: number; h: number }, m: number): boolean {
  return tx >= r.x - m && tx < r.x + r.w + m && ty >= r.y - m && ty < r.y + r.h + m;
}

function onRoad(tx: number, ty: number, m: number): boolean {
  for (const r of ROADS) {
    if (tx >= r.x1 - m && tx <= r.x2 + m && ty >= r.y1 - m && ty <= r.y2 + m) return true;
  }
  return false;
}

function onBuilding(tx: number, ty: number, m: number): boolean {
  for (const l of LOCATIONS) {
    if (insideRect(tx, ty, l, m)) return true;
  }
  return false;
}

function natureFree(tx: number, ty: number): boolean {
  if (tx < 2 || ty < 2 || tx > 207 || ty > 125) return false;
  return !onRoad(tx, ty, 1) && !onBuilding(tx, ty, 1);
}

// --- forest zones ----------------------------------------------------------
const FORESTS = [
  { x: 0, y: 0, w: 34, h: 34, name: "Northwest Forest" },
  { x: 176, y: 0, w: 34, h: 28, name: "Northeast Forest" },
  { x: 0, y: 84, w: 26, h: 44, name: "Southwest Forest" },
  { x: 180, y: 86, w: 30, h: 42, name: "Southeast Forest" },
];

function forestDensity(tx: number, ty: number): number {
  for (const f of FORESTS) {
    if (tx >= f.x && tx < f.x + f.w && ty >= f.y && ty < f.y + f.h) return 0.5;
  }
  // sparse tree belt outside town core
  if (ty < 32 || ty > 112) return 0.14;
  if (tx < 12 || tx > 198) return 0.14;
  return 0.035;
}

export interface Tree { x: number; y: number; kind: "oak" | "pine" | "bush"; s: number; }

export const TREES: Tree[] = [];
for (let gx = 1; gx < 209; gx += 4) {
  for (let gy = 1; gy < 127; gy += 4) {
    const jx = gx + Math.floor(h2(gx, gy) * 3) - 1;
    const jy = gy + Math.floor(h2(gy + 7, gx) * 3) - 1;
    if (!natureFree(jx, jy)) continue;
    const r = h2(jx * 7 + 3, jy * 11 + 5);
    if (r > forestDensity(jx, jy)) continue;
    const k = h2(jy * 5 + 1, jx * 13 + 9);
    const kind: Tree["kind"] = k < 0.5 ? "oak" : k < 0.8 ? "pine" : "bush";
    TREES.push({ x: jx * V + 8 + (h2(jx + 2, jy + 4) - 0.5) * 8, y: jy * V + 14, kind, s: 0.8 + h2(jx, jy + 3) * 0.55 });
  }
}

// --- props -----------------------------------------------------------------
interface Prop { kind: string; x: number; y: number; seed: number; }

function grassProp(kind: string, tx: number, ty: number): Prop | null {
  if (!natureFree(tx, ty)) return null;
  return { kind, x: tx * V + 8, y: ty * V + 14, seed: h2(tx, ty) };
}

function roadProp(kind: string, tx: number, ty: number): Prop {
  // sits on the sidewalk strip inside a road rect -> always safe
  return { kind, x: tx * V + 8, y: ty * V + 12, seed: h2(tx, ty) };
}

export const PROPS: Prop[] = [];
export const LAMP_GLOWS: Array<{ x: number; y: number }> = [];

// street lamps: Main St (both sides) + Center Ave (both sides)
function addLamp(x: number, y: number): void {
  PROPS.push({ kind: "lamp", x, y, seed: h2(Math.floor(x), Math.floor(y)) });
  LAMP_GLOWS.push({ x, y: y - 24 });
}
for (let x = 46; x <= 198; x += 14) {
  addLamp(x * V + 8, 76 * V + 4);          // north sidewalk of Main St
  addLamp(x * V + 8, 77 * V + 28);         // south sidewalk
}
for (let y = 44; y <= 110; y += 16) {
  addLamp(114 * V + 4, y * V + 8);         // west sidewalk of Center Ave
  addLamp(115 * V + 28, y * V + 8);        // east sidewalk
}
// telephone poles along Main St
for (let x = 53; x <= 195; x += 14) PROPS.push(roadProp("pole", x, 76));

// hand-placed street furniture on grass
const grass: Array<[string, number, number]> = [
  ["bench", 94, 54], ["bench", 115, 54], ["bench", 94, 71], ["bench", 116, 71],
  ["busstop", 150, 74], ["busstop", 58, 74],
  ["mailbox", 141, 58], ["mailbox", 107, 75],
  ["hydrant", 117, 67],
  ["billboard", 160, 50],
  ["bale", 74, 80], ["bale", 74, 100], ["bale", 71, 82],
  ["crate", 93, 68], ["crate", 83, 69], ["crate", 82, 71],
  ["barrel", 124, 67], ["barrel", 125, 65],
  ["picnic", 106, 88], ["picnic", 116, 89],
  ["well", 50, 46],
  ["sign", 43, 74], ["sign", 171, 74],
  ["windmill", 186, 66],
  ["watertower", 100, 33],
];
for (const [kind, tx, ty] of grass) {
  const p = grassProp(kind, tx, ty);
  if (p) PROPS.push(p);
}

// deterministic scatter: flowers + rocks + small tufts markers
const SCATTER: Prop[] = [];
for (let gx = 3; gx < 208; gx += 5) {
  for (let gy = 3; gy < 126; gy += 5) {
    const r = h2(gx * 3 + 11, gy * 9 + 7);
    if (r > 0.16) continue;
    const tx = gx + Math.floor(h2(gx, gy + 1) * 3);
    const ty = gy + Math.floor(h2(gy, gx + 2) * 3);
    if (!natureFree(tx, ty)) continue;
    const kind = r < 0.07 ? "flower" : "rock";
    SCATTER.push({ kind, x: tx * V + 6, y: ty * V + 12, seed: h2(tx + 5, ty + 6) });
  }
}

// --- vehicles --------------------------------------------------------------
interface Vehicle {
  route: number[][];
  seg: number; d: number;
  x: number; y: number;
  fx: number; fy: number;
  speed: number; base: number;
  color: string;
  axis: "h" | "v";
}

const ROUTES: number[][][] = [
  [[44, 77.3], [200, 77.3], [200, 76.7], [44, 76.7]],
  [[44, 76.7], [200, 76.7], [200, 77.3], [44, 77.3]],
  [[52, 41.3], [168, 41.3], [168, 40.7], [52, 40.7]],
  [[14, 89.3], [72, 89.3], [72, 88.7], [14, 88.7]],
  [[64.3, 36], [64.3, 112], [63.7, 112], [63.7, 36]],
  [[115.3, 42], [115.3, 112], [114.7, 112], [114.7, 42]],
  [[129.3, 38], [129.3, 110], [128.7, 110], [128.7, 38]],
  [[157.3, 38], [157.3, 104], [156.7, 104], [156.7, 38]],
];

const CAR_COLORS = ["#b83a2e", "#2c6fb3", "#e8e6df", "#2f8f5b", "#d8a12a", "#3c3c42", "#d96b2b", "#2f9ea3"];

export const VEHICLES: Vehicle[] = ROUTES.map((route, i) => {
  const first = route[0]!, second = route[1]!;
  const len = Math.hypot((second[0] - first[0]) * V, (second[1] - first[1]) * V) || 1;
  const base = 44 + h2(i * 13, i * 7) * 30;
  return {
    route,
    seg: 0,
    d: (h2(i + 1, i + 3) * len) % len,
    x: first[0] * V, y: first[1] * V,
    fx: Math.sign(second[0] - first[0]) || 1,
    fy: Math.sign(second[1] - first[1]) || 0,
    speed: base,
    base,
    color: CAR_COLORS[i % CAR_COLORS.length]!,
    axis: Math.abs(second[0] - first[0]) >= Math.abs(second[1] - first[1]) ? "h" : "v",
  };
});

export type LightState = "red" | "yellow" | "green";

export function lightState(time: number, axis: "h" | "v"): LightState {
  const c = time % 12;
  if (axis === "h") return c < 5 ? "green" : c < 6 ? "yellow" : "red";
  return c < 6 ? "red" : c < 11 ? "green" : "yellow";
}

export function tickScenery(dt: number, time: number): void {
  for (const v of VEHICLES) {
    // brake for a red/yellow light just ahead
    let target = v.base;
    for (const L of LIGHTS) {
      if (v.axis === "h") {
        const dy = Math.abs(L.cy - v.y);
        const ahead = (L.cx - v.x) * v.fx;
        if (dy < 16 && ahead > 2 && ahead < 30 && lightState(time, "h") !== "green") { target = 0; break; }
      } else {
        const dx = Math.abs(L.cx - v.x);
        const ahead = (L.cy - v.y) * v.fy;
        if (dx < 16 && ahead > 2 && ahead < 30 && lightState(time, "v") !== "green") { target = 0; break; }
      }
    }
    v.speed += (target - v.speed) * Math.min(1, dt * (target < v.speed ? 7 : 1.6));

    v.d += v.speed * dt;
    let guard = 0;
    while (guard++ < 4) {
      const a = v.route[v.seg]!;
      const b = v.route[(v.seg + 1) % v.route.length]!;
      const len = Math.hypot((b[0] - a[0]) * V, (b[1] - a[1]) * V) || 1;
      if (v.d < len) break;
      v.d -= len;
      v.seg = (v.seg + 1) % v.route.length;
    }
    const a = v.route[v.seg]!;
    const b = v.route[(v.seg + 1) % v.route.length]!;
    const ax = a[0] * V, ay = a[1] * V;
    const dx = b[0] * V - ax, dy = b[1] * V - ay;
    const len = Math.hypot(dx, dy) || 1;
    const p = v.d / len;
    v.x = ax + dx * p;
    v.y = ay + dy * p;
    if (Math.abs(dx) > 0.5) { v.fx = Math.sign(dx); v.fy = 0; }
    else if (Math.abs(dy) > 0.5) { v.fy = Math.sign(dy); v.fx = 0; }
    v.axis = Math.abs(dx) >= Math.abs(dy) ? "h" : "v";
  }
}

// --- terrain decoration (roads, crosswalks, fences, forest floor) -----------
function visible(x: number, y: number, w: number, h: number, view: View, m = 80): boolean {
  return x + w > view.l - m && x < view.r + m && y + h > view.t - m && y < view.b + m;
}

export function drawTerrainDecor(ctx: CanvasRenderingContext2D, view: View, d: SceneDraw): void {
  const { isDark } = d;

  // forest floor
  ctx.fillStyle = isDark ? "rgba(10,26,14,0.45)" : "rgba(52,92,48,0.18)";
  for (const f of FORESTS) {
    const x = f.x * V, y = f.y * V, w = f.w * V, h = f.h * V;
    if (!visible(x, y, w, h, view, 0)) continue;
    ctx.beginPath();
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // forest labels
  ctx.font = "7px JetBrains Mono";
  ctx.textAlign = "center";
  ctx.globalAlpha = isDark ? 0.5 : 0.42;
  ctx.fillStyle = isDark ? "#8fb88a" : "#2f5a2c";
  for (const f of FORESTS) {
    const cx = (f.x + f.w / 2) * V, cy = (f.y + f.h / 2) * V;
    if (!visible(cx - 60, cy - 10, 120, 20, view, 0)) continue;
    ctx.fillText(f.name, cx, cy);
  }
  ctx.globalAlpha = 1;

  // roads
  for (const r of ROADS) {
    const x = r.x1 * V, y = r.y1 * V;
    const w = (r.x2 - r.x1 + 1) * V, h = (r.y2 - r.y1 + 1) * V;
    if (!visible(x, y, w, h, view, 0)) continue;
    const asphalt = isDark ? "#2b2926" : "#8f8a80";
    const walk = isDark ? "#38352f" : "#d9d4c7";
    ctx.fillStyle = asphalt;
    ctx.fillRect(x, y, w, h);
    // sidewalks inside edges (5px)
    ctx.fillStyle = walk;
    if (w >= h) {
      ctx.fillRect(x, y, w, 5);
      ctx.fillRect(x, y + h - 5, w, 5);
      // edge lines
      ctx.fillStyle = isDark ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.5)";
      ctx.fillRect(x, y + 5, w, 1);
      ctx.fillRect(x, y + h - 6, w, 1);
      // dashed center line
      ctx.strokeStyle = isDark ? "rgba(216,182,78,0.5)" : "#d8b64e";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 9]);
      ctx.beginPath();
      ctx.moveTo(x + 6, y + h / 2);
      ctx.lineTo(x + w - 6, y + h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillRect(x, y, 5, h);
      ctx.fillRect(x + w - 5, y, 5, h);
      ctx.fillStyle = isDark ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.5)";
      ctx.fillRect(x + 5, y, 1, h);
      ctx.fillRect(x + w - 6, y, 1, h);
      ctx.strokeStyle = isDark ? "rgba(216,182,78,0.5)" : "#d8b64e";
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 9]);
      ctx.beginPath();
      ctx.moveTo(x + w / 2, y + 6);
      ctx.lineTo(x + w / 2, y + h - 6);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // crosswalks + traffic light corners
  const zebra = isDark ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.8)";
  ctx.fillStyle = zebra;
  for (const L of LIGHTS) {
    if (!visible(L.cx - 44, L.cy - 44, 88, 88, view, 0)) continue;
    // across Main/North-style horizontal road (west approach): rungs perpendicular to travel
    for (let i = 0; i < 4; i++) ctx.fillRect(L.cx - 32 + i * 7, L.cy - 15, 4, 30);
    // across vertical road (north approach)
    for (let i = 0; i < 4; i++) ctx.fillRect(L.cx - 15, L.cy - 32 + i * 7, 30, 4);
  }

  // fences (picket)
  const FENCES = [
    { x: 66, y: 61, w: 11, h: 8 },   // schoolyard
    { x: 92, y: 81, w: 10, h: 7 },   // trough garden
    { x: 27, y: 95, w: 24, h: 18 },  // orchard
  ];
  ctx.strokeStyle = isDark ? "#5a5148" : "#f2ede2";
  ctx.lineWidth = 1.4;
  for (const f of FENCES) {
    const x = f.x * V, y = f.y * V, w = f.w * V, h = f.h * V;
    if (!visible(x, y, w, h, view, 0)) continue;
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([3, 5]);
    ctx.strokeRect(x + 2, y + 2, w - 4, h - 4);
    ctx.setLineDash([]);
  }

  // grass tufts
  ctx.strokeStyle = isDark ? "rgba(120,160,110,0.28)" : "rgba(70,120,60,0.35)";
  ctx.lineWidth = 1;
  for (let gx = 2; gx < 208; gx += 6) {
    for (let gy = 2; gy < 126; gy += 6) {
      const r = h2(gx * 5 + 2, gy * 3 + 8);
      if (r > 0.5) continue;
      const x = gx * V + r * 40, y = gy * V + (1 - r) * 40;
      if (!visible(x, y, 2, 2, view, 0)) continue;
      if (onRoad(gx, gy, 1) || onBuilding(gx, gy, 0)) continue;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 2, y - 4);
      ctx.moveTo(x, y);
      ctx.lineTo(x - 2, y - 3);
      ctx.stroke();
    }
  }
}

// --- sortable drawables (trees, props, vehicles) ---------------------------
function drawTree(ctx: CanvasRenderingContext2D, t: Tree, d: SceneDraw): void {
  const { isDark } = d;
  const x = t.x, y = t.y, s = t.s;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.ellipse(x, y, 10 * s, 4 * s, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  if (t.kind === "pine") {
    ctx.fillStyle = isDark ? "#3a2a1a" : "#6b4a2c";
    ctx.fillRect(-2, -8, 4, 8);
    ctx.fillStyle = isDark ? "#24402a" : "#3d7a48";
    for (let i = 0; i < 3; i++) {
      const w = 12 - i * 3, top = -10 - i * 8;
      ctx.beginPath();
      ctx.moveTo(0, top - 10);
      ctx.lineTo(w, top + 6);
      ctx.lineTo(-w, top + 6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = isDark ? "rgba(140,190,150,0.16)" : "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.moveTo(0, -34);
    ctx.lineTo(-4, -20);
    ctx.lineTo(-9, -4);
    ctx.closePath();
    ctx.fill();
  } else if (t.kind === "bush") {
    ctx.fillStyle = isDark ? "#2b4a28" : "#5a9450";
    ctx.beginPath(); ctx.arc(0, -5, 7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(5, -4, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = isDark ? "#3c6234" : "#74ad66";
    ctx.beginPath(); ctx.arc(-2, -8, 4, 0, Math.PI * 2); ctx.fill();
  } else {
    // oak
    ctx.fillStyle = isDark ? "#3a2a1a" : "#6b4a2c";
    ctx.fillRect(-2.5, -12, 5, 12);
    ctx.fillStyle = isDark ? "#2b4a28" : "#4f8f45";
    ctx.beginPath(); ctx.arc(-5, -17, 9, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(6, -15, 8, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -24, 9.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = isDark ? "#3c6234" : "#63a855";
    ctx.beginPath(); ctx.arc(-2, -26, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = isDark ? "rgba(160,200,160,0.14)" : "rgba(255,255,255,0.25)";
    ctx.beginPath(); ctx.arc(-4, -27, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawProp(ctx: CanvasRenderingContext2D, p: Prop, d: SceneDraw): void {
  const { isDark, night, time } = d;
  const x = p.x, y = p.y;
  const metal = isDark ? "#4a4741" : "#3c3a35";
  const wood = isDark ? "#4a3a2a" : "#a07a4a";
  ctx.save();
  ctx.translate(x, y);
  switch (p.kind) {
    case "lamp": {
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.beginPath(); ctx.ellipse(0, 0, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = metal; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -24); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(5, -26); ctx.stroke();
      ctx.fillStyle = night > 0.15 ? "#ffd977" : isDark ? "#6a655c" : "#c9c4b6";
      ctx.beginPath(); ctx.arc(6, -25, 3, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case "light": break; // handled separately
    case "pole": {
      ctx.strokeStyle = isDark ? "#3a3026" : "#6b5540";
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -26); ctx.stroke();
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-6, -24); ctx.lineTo(6, -24); ctx.stroke();
      ctx.fillStyle = isDark ? "#57534b" : "#8a8478";
      ctx.fillRect(-1.5, -27, 3, 3);
      break;
    }
    case "bench": {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath(); ctx.ellipse(0, 0, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = wood;
      ctx.fillRect(-9, -7, 18, 3);   // backrest
      ctx.fillRect(-9, -3, 18, 3);   // seat
      ctx.fillStyle = metal;
      ctx.fillRect(-8, 0, 2, 3);
      ctx.fillRect(6, 0, 2, 3);
      break;
    }
    case "busstop": {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath(); ctx.ellipse(0, 0, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = metal; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(-12, -20); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(12, -20); ctx.stroke();
      ctx.fillStyle = isDark ? "#3d5566" : "#7fa8c4";
      ctx.fillRect(-15, -24, 30, 5); // canopy
      ctx.fillStyle = wood;
      ctx.fillRect(-9, -6, 18, 3);
      ctx.fillStyle = isDark ? "#8fb88a" : "#2f5a2c";
      ctx.fillRect(13, -30, 6, 9);   // stop sign
      break;
    }
    case "mailbox": {
      ctx.fillStyle = metal;
      ctx.fillRect(-1, -10, 2, 10);
      ctx.fillStyle = isDark ? "#5c5850" : "#e6e1d5";
      ctx.fillRect(-5, -15, 10, 6);
      ctx.fillStyle = "#b83a2e";
      ctx.fillRect(4, -16, 2, 4);
      break;
    }
    case "hydrant": {
      ctx.fillStyle = "#b83a2e";
      ctx.fillRect(-3, -11, 6, 11);
      ctx.beginPath(); ctx.arc(0, -11, 3.4, Math.PI, 0); ctx.fill();
      ctx.fillStyle = "#8a2a20";
      ctx.fillRect(-4.5, -8, 9, 2);
      break;
    }
    case "billboard": {
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.beginPath(); ctx.ellipse(0, 0, 16, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = wood;
      ctx.fillRect(-11, -14, 3, 14);
      ctx.fillRect(8, -14, 3, 14);
      ctx.fillStyle = isDark ? "#26241f" : "#f2ede2";
      ctx.fillRect(-16, -32, 32, 18);
      ctx.strokeStyle = isDark ? "#4a4741" : "#1b1915";
      ctx.lineWidth = 1;
      ctx.strokeRect(-16, -32, 32, 18);
      ctx.fillStyle = isDark ? "#c9a86a" : "#b83a2e";
      ctx.fillRect(-13, -29, 18, 4);
      ctx.fillStyle = isDark ? "#8a857c" : "#8a857c";
      ctx.fillRect(-13, -23, 26, 2);
      ctx.fillRect(-13, -19, 20, 2);
      break;
    }
    case "bale": {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath(); ctx.ellipse(0, 0, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#8a7440" : "#d8b968";
      ctx.beginPath(); ctx.arc(0, -8, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isDark ? "#6a5a34" : "#a88a48";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, -8, 5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -8, 2, 0, Math.PI * 2); ctx.stroke();
      break;
    }
    case "crate": {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath(); ctx.ellipse(0, 0, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#4a3a28" : "#b8905a";
      ctx.fillRect(-7, -12, 14, 12);
      ctx.strokeStyle = isDark ? "#3a2e20" : "#8a6a3a";
      ctx.lineWidth = 1;
      ctx.strokeRect(-7, -12, 14, 12);
      ctx.beginPath(); ctx.moveTo(-7, -6); ctx.lineTo(7, -6); ctx.stroke();
      break;
    }
    case "barrel": {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath(); ctx.ellipse(0, 0, 6, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#4a3a2a" : "#8a5a34";
      ctx.fillRect(-5, -14, 10, 14);
      ctx.fillStyle = isDark ? "#5c4a36" : "#a8764a";
      ctx.beginPath(); ctx.ellipse(0, -14, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = isDark ? "#33281e" : "#5a3a1e";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-5, -10); ctx.lineTo(5, -10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-5, -5); ctx.lineTo(5, -5); ctx.stroke();
      break;
    }
    case "picnic": {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = wood;
      ctx.fillRect(-11, -7, 22, 6);
      ctx.fillRect(-11, 1, 22, 3);
      ctx.fillStyle = isDark ? "#3a2e20" : "#7a5a34";
      ctx.fillRect(-9, -1, 2, 4);
      ctx.fillRect(7, -1, 2, 4);
      break;
    }
    case "well": {
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.beginPath(); ctx.ellipse(0, 0, 9, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#4a4741" : "#9a958a";
      ctx.beginPath(); ctx.ellipse(0, -6, 8, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#1e1a18" : "#3a3630";
      ctx.beginPath(); ctx.ellipse(0, -6, 4.5, 2.6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = wood;
      ctx.fillRect(-7, -22, 2, 14);
      ctx.fillRect(5, -22, 2, 14);
      ctx.fillStyle = isDark ? "#5a3a2e" : "#a66a3a";
      ctx.beginPath(); ctx.moveTo(-10, -22); ctx.lineTo(0, -28); ctx.lineTo(10, -22); ctx.closePath(); ctx.fill();
      break;
    }
    case "sign": {
      ctx.fillStyle = wood;
      ctx.fillRect(-1.5, -18, 3, 18);
      ctx.fillStyle = isDark ? "#5a4a34" : "#c9a86a";
      ctx.fillRect(-9, -22, 18, 6);
      ctx.strokeStyle = isDark ? "#3a2e20" : "#7a5a34";
      ctx.lineWidth = 1;
      ctx.strokeRect(-9, -22, 18, 6);
      break;
    }
    case "windmill": {
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.beginPath(); ctx.ellipse(0, 0, 12, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#4a4741" : "#c9c4b6";
      ctx.beginPath();
      ctx.moveTo(-8, 0); ctx.lineTo(-4, -30); ctx.lineTo(4, -30); ctx.lineTo(8, 0);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = isDark ? "#33302b" : "#8a857c";
      ctx.fillRect(-3, -10, 6, 10);
      // rotating blades
      ctx.save();
      ctx.translate(0, -32);
      ctx.rotate(time * 0.7);
      ctx.strokeStyle = isDark ? "#8a857c" : "#f2ede2";
      ctx.lineWidth = 3;
      for (let i = 0; i < 4; i++) {
        ctx.rotate(Math.PI / 2);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(16, 0); ctx.stroke();
      }
      ctx.restore();
      break;
    }
    case "watertower": {
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.beginPath(); ctx.ellipse(0, 0, 13, 4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = metal; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-9, 0); ctx.lineTo(-6, -24); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(6, -24); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-8, -10); ctx.lineTo(8, -10); ctx.stroke();
      ctx.fillStyle = isDark ? "#3d5566" : "#7fa8c4";
      ctx.fillRect(-11, -40, 22, 16);
      ctx.fillStyle = isDark ? "#2e4455" : "#5f8aa8";
      ctx.beginPath(); ctx.moveTo(-13, -40); ctx.lineTo(0, -47); ctx.lineTo(13, -40); ctx.closePath(); ctx.fill();
      ctx.fillStyle = isDark ? "#c9a86a" : "#1b1915";
      ctx.font = "6px JetBrains Mono";
      ctx.textAlign = "center";
      ctx.fillText("HERMES", 0, -30);
      break;
    }
    case "flower": {
      const cols = ["#d85a6a", "#e8b83a", "#b06ad0", "#e88a3a"];
      ctx.strokeStyle = isDark ? "#3c6234" : "#4f8f45";
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const fx = (i - 1) * 4, fy = -4 - (i % 2) * 2;
        ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, fy); ctx.stroke();
        ctx.fillStyle = cols[(Math.floor(p.seed * 10) + i) % cols.length]!;
        ctx.beginPath(); ctx.arc(fx, fy - 1.5, 2, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case "rock": {
      ctx.fillStyle = "rgba(0,0,0,0.1)";
      ctx.beginPath(); ctx.ellipse(0, 0, 5, 2, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#4a4741" : "#a8a49a";
      ctx.beginPath(); ctx.ellipse(0, -3, 5, 3.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = isDark ? "#5c5850" : "#c4c0b6";
      ctx.beginPath(); ctx.ellipse(-1.5, -4, 2.2, 1.4, 0, 0, Math.PI * 2); ctx.fill();
      break;
    }
  }
  ctx.restore();
}

function drawTrafficLight(ctx: CanvasRenderingContext2D, L: Light, d: SceneDraw): void {
  const { isDark, time } = d;
  const x = L.x, y = L.y;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath(); ctx.ellipse(0, 0, 5, 2.2, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = isDark ? "#4a4741" : "#3c3a35";
  ctx.lineWidth = 2.6;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -30); ctx.stroke();
  ctx.fillStyle = isDark ? "#26241f" : "#2b2a26";
  ctx.fillRect(-6, -54, 12, 25);
  ctx.strokeStyle = isDark ? "#8a857c" : "#1b1915";
  ctx.lineWidth = 0.9;
  ctx.strokeRect(-6, -54, 12, 25);
  const states: Record<LightState, string> = { red: "#e0402f", yellow: "#e8b83a", green: "#3ab35a" };
  const hS = lightState(time, "h");
  const vS = lightState(time, "v");
  const order: LightState[] = ["red", "yellow", "green"];
  order.forEach((st, i) => {
    const cy = -48.5 + i * 7.5;
    const lit = st === hS; // this lamp faces the horizontal road
    ctx.globalAlpha = lit ? 1 : 0.3;
    ctx.fillStyle = states[st];
    ctx.beginPath(); ctx.arc(0, cy, 3.3, 0, Math.PI * 2); ctx.fill();
    if (lit) {
      ctx.globalAlpha = 0.38;
      ctx.beginPath(); ctx.arc(0, cy, 6, 0, Math.PI * 2); ctx.fill();
    }
  });
  ctx.globalAlpha = 1;
  // v-road indicator on the side
  ctx.fillStyle = states[vS];
  ctx.globalAlpha = 0.95;
  ctx.fillRect(7.5, -46, 3.4, 3.4);
  ctx.globalAlpha = 1;
  ctx.restore();
}

function drawVehicle(ctx: CanvasRenderingContext2D, v: Vehicle, d: SceneDraw): void {
  const { isDark, night } = d;
  ctx.save();
  ctx.translate(v.x, v.y);
  let ang = 0;
  if (v.axis === "v") ang = v.fy >= 0 ? Math.PI / 2 : -Math.PI / 2;
  else ang = v.fx >= 0 ? 0 : Math.PI;
  ctx.rotate(ang);
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.14)";
  ctx.beginPath();
  ctx.ellipse(0, 2, 15, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  // wheels
  ctx.fillStyle = "#1e1a18";
  ctx.fillRect(-10, -7.5, 5, 2.5);
  ctx.fillRect(6, -7.5, 5, 2.5);
  ctx.fillRect(-10, 5, 5, 2.5);
  ctx.fillRect(6, 5, 5, 2.5);
  // body
  ctx.fillStyle = v.color;
  roundRectLocal(ctx, -14, -6, 28, 12, 3);
  ctx.fill();
  // roof
  ctx.fillStyle = isDark ? "rgba(0,0,0,0.35)" : "rgba(0,0,0,0.18)";
  roundRectLocal(ctx, -6, -5, 13, 10, 2);
  ctx.fill();
  // windshield + rear glass
  ctx.fillStyle = isDark ? "#2e3a44" : "#bcd4e2";
  ctx.fillRect(7, -4.5, 3.5, 9);
  ctx.fillRect(-9, -4.5, 2.5, 9);
  // headlights / taillights
  if (night > 0.1) {
    ctx.fillStyle = "rgba(255,240,180,0.95)";
  } else {
    ctx.fillStyle = "rgba(255,244,200,0.8)";
  }
  ctx.fillRect(13, -5, 1.6, 3);
  ctx.fillRect(13, 2, 1.6, 3);
  ctx.fillStyle = "#c03a2a";
  ctx.fillRect(-14.4, -5, 1.4, 3);
  ctx.fillRect(-14.4, 2, 1.4, 3);
  ctx.restore();

  // headlight beams at night
  if (night > 0.12) {
    ctx.save();
    ctx.translate(v.x, v.y);
    let ang2 = 0;
    if (v.axis === "v") ang2 = v.fy >= 0 ? Math.PI / 2 : -Math.PI / 2;
    else ang2 = v.fx >= 0 ? 0 : Math.PI;
    ctx.rotate(ang2);
    const grad = ctx.createLinearGradient(14, 0, 52, 0);
    grad.addColorStop(0, `rgba(255,240,190,${0.35 * night})`);
    grad.addColorStop(1, "rgba(255,240,190,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(14, -5);
    ctx.lineTo(52, -14);
    ctx.lineTo(52, 14);
    ctx.lineTo(14, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function roundRectLocal(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function pushScenery(queue: QueueItem[], ctx: CanvasRenderingContext2D, view: View, d: SceneDraw): void {
  const inView = (x: number, y: number) => x > view.l && x < view.r && y > view.t && y < view.b;

  for (const t of TREES) {
    if (!inView(t.x, t.y)) continue;
    queue.push({ y: t.y, draw: () => drawTree(ctx, t, d) });
  }
  for (const p of PROPS) {
    if (!inView(p.x, p.y)) continue;
    queue.push({ y: p.y, draw: () => drawProp(ctx, p, d) });
  }
  for (const p of SCATTER) {
    if (!inView(p.x, p.y)) continue;
    queue.push({ y: p.y, draw: () => drawProp(ctx, p, d) });
  }
  for (const L of LIGHTS) {
    if (!inView(L.x, L.y)) continue;
    queue.push({ y: L.y, draw: () => drawTrafficLight(ctx, L, d) });
  }
  for (const v of VEHICLES) {
    if (!inView(v.x, v.y)) continue;
    queue.push({ y: v.y, draw: () => drawVehicle(ctx, v, d) });
  }
}
