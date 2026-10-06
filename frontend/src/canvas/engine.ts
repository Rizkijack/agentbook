import { V, Pe, vt, WorldWidth, WorldHeight, WorldSize } from "./constants.js";
import { LOCATIONS } from "./locationsData.js";
import { pf } from "./pf.js";
import { navmap } from "./navmap.js";
import { DAY_LENGTH_SEC, Hc } from "@slopagentbook/shared";
import { renderLlama } from "./renderer/draw.js";
import { sf } from "./renderer/skeleton.js";
import { BUF_W, BUF_H } from "./renderer/pixelBuffer.js";
import { drawTerrainDecor, pushScenery, tickScenery, LAMP_GLOWS, type View, type SceneDraw } from "./scenery.js";

/**
 * The box the whole town has to fit inside, in CSS px.
 *
 * Read off the layout rather than picked: 560 is the height WorldCanvas gives
 * the canvas, and 1280 - 2x24 is the widest content box the page will ever hand
 * it (`.page { max-width: 1280px; padding: 24px }`).
 */
const FIT_BOX = { w: 1280 - 24 * 2, h: 560 };

/**
 * MIN_ZOOM — how far out a player may pull, derived from the world, not chosen.
 *
 * It used to be the literal 0.45. That number was picked when the map was
 * 210x128 (3360x2048 world px), where 0.45 in an ~890px viewport showed about
 * half the town. The map grew 5x to 1050x640 and the literal stayed, so the
 * floor silently became 9x too tight: at 0.45 you saw 124 of the 1050 tiles,
 * 12% of the town, and there was no whole-town view at all.
 *
 * This is the *contain* zoom for FIT_BOX: the smaller of the two ratios, so the
 * entire world is inside the viewport along whichever axis binds.
 * Today: min(1232/16800, 560/10240) = min(0.0733, 0.0546875) = 0.0546875 —
 * all 640 rows, and all 1050 columns in any window at least 919px wide. It is
 * WorldSize (Pe*V by vt*V) in both numerator and denominator, so growing the
 * grid again moves this number with it; a test recomputes it from Pe/vt/V.
 */
export const MIN_ZOOM = Math.min(FIT_BOX.w / WorldSize.width, FIT_BOX.h / WorldSize.height);
export const MAX_ZOOM = 2.8;
/** Where the camera starts, and where "Reset" returns to. */
/**
 * Where the camera opens: the town square.
 *
 * Derived, not pinned. This used to be the literal 1600/900, which happened to
 * sit on the square only while the map was 210x128 — grow the world and the
 * camera opens over empty field with the whole town off-screen to the right.
 * Square is at the centre of the grid by construction (the original 42
 * locations were translated, not rescaled, to put it there).
 */
const SQUARE = LOCATIONS.find((l) => l.id === "square")!;
const CAM_HOME_X = (SQUARE.x + SQUARE.w / 2) * V;
const CAM_HOME_Y = (SQUARE.y + SQUARE.h / 2) * V;

/**
 * Resident height in world px — the proportion lock for the whole sprite.
 *
 * Derived, not picked: 1/10 of the town's own median built structure.
 * Characteristic size = average of the median footprint width and height
 * over every solid location (Food/Water are terrain, not buildings), in
 * world px, divided by ten and rounded. Today that is
 * ((128 + 80) / 2) / 10 = 10.4 → 10px — which also lands within a pixel
 * of 1/3 of a car body (28px), so the two readings still agree and the
 * number stays a spec, not a taste call. When the town grows, this moves
 * with it (npc-proportions.test.ts recomputes it independently).
 *
 * Before this, the sprite was blitted at scale 1.4 = 63px tall: as tall as a
 * house and twice a car. Every offset below is derived from NPC_H instead of
 * being hand-tuned, so the whole figure (shadow, ring, name tag, bubble) moves
 * together when this one number changes.
 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
const BUILT = LOCATIONS.filter((l) => l.category !== "Food" && l.category !== "Water");
const TOWN_MED_W = median(BUILT.map((l) => l.w * V));
const TOWN_MED_H = median(BUILT.map((l) => l.h * V));
export const NPC_H = Math.round(((TOWN_MED_W + TOWN_MED_H) / 2) / 10);
/** Buffer row in renderer/pixelBuffer where the hooves land (see draw.ts). */
const NPC_GROUND_ROW = 45;
/** Buffer px → world px, i.e. what makes the sprite exactly NPC_H tall. */
export const NPC_SCALE = NPC_H / NPC_GROUND_ROW;
/** Ratio against offsets that were sized for the old 63px sprite. */
const NPC_K = NPC_H / 63;

/**
 * Building ink — one palette per theme, one entry per category.
 *
 * This used to be a ternary per colour inside the draw loop, with the dark
 * theme's values chosen by eye next to the light ones. In the dark theme every
 * wall was DARKER than the ground it stood on, so a building read as a hole
 * rather than a mass. Relative luminance against the #33302a district apron
 * (0.0298) that drawTerrainDecor paints the city on:
 *
 *   was:  wall 0.019-0.027  roof 0.032-0.083  trim 0.037-0.046   → 0.7x / 1.2-2.8x / 1.2-1.6x
 *   now:  wall 0.050-0.061  roof 0.075-0.163  trim 0.177-0.280   → 1.7-2.1x / 2.5-5.5x / 5.9-9.4x
 *
 * Same relationship the light theme already has (wall 0.73, roof 0.13, trim
 * 0.01 on a 0.55 ground — a dark roofline on a pale mass), inverted for ground
 * that is itself dark: the roof is the shape that reads and the trim is the edge
 * that separates a building from its neighbour. The night mood is intact —
 * nothing here is brighter than a street lamp.
 *
 * Tables rather than CSS custom properties: nothing in the cascade consumes
 * these sixteen colours, so tokens would be a data file pretending to be a
 * stylesheet. The two colours the engine DOES take from tokens are the ground
 * pair, read once per frame at the top of draw().
 */
interface BuildInk { wall: string; roof: string; trim: string; wood: string; }
export const BUILD_INK: Record<"light" | "dark", Record<string, BuildInk>> = {
  light: {
    base: { wall: "#e8ddd0", roof: "#8b5a3c", trim: "#1b1915", wood: "#c9a86a" },
    Social: { wall: "#efe6d5", roof: "#a66a3a", trim: "#5a3a1e", wood: "#c9a86a" },
    Civic: { wall: "#e6e2dd", roof: "#6b6a6e", trim: "#2b2a2e", wood: "#c9a86a" },
    Work: { wall: "#e8d5c0", roof: "#9a6a3a", trim: "#3d2a18", wood: "#c9a86a" },
    Rest: { wall: "#b54a3a", roof: "#7a2e22", trim: "#4a1e14", wood: "#d8c9a8" },
  },
  dark: {
    base: { wall: "#443e37", roof: "#7d5738", trim: "#7f7362", wood: "#6b5a42" },
    Social: { wall: "#4c4238", roof: "#8a5c3a", trim: "#857660", wood: "#6b5a42" },
    Civic: { wall: "#454648", roof: "#6f7076", trim: "#8e9099", wood: "#6b5a42" },
    Work: { wall: "#4a4038", roof: "#7d5738", trim: "#857660", wood: "#6b5a42" },
    Rest: { wall: "#5a3a30", roof: "#6b4438", trim: "#95705e", wood: "#7b6a54" },
  },
};

/** 08 §10.2 — name-tag / ring colour by finishing rank: 1st, 2nd, 3rd. */
export const RANK_COLORS = ["#c9a86a", "#b9c0c4", "#b87333"] as const;
/** Entrants before a result exists — everyone competing gets the same mark. */
export const ENTRANT_COLOR = "#7a5cc4";

/**
 * Level of detail — the zoom floors below are all "an object this small on
 * screen is not worth a draw call", stated in screen px and divided by the
 * object's world-px size. Nothing here is a taste number: each one is a
 * visibility floor, and each floor came from measuring the cost of not having
 * it (zoom-lod.test.ts pins the numbers this is derived from).
 */

/** Name-tag text height, in screen px. Fixed: the tag does not scale. */
const TAG_PX = 8;

/**
 * Below this zoom, name tags stop being drawn (except for the followed
 * resident).
 *
 * A tag is a fixed 8 screen px, so pulling the camera back makes each one cover
 * MORE world, not less. At MIN_ZOOM (0.0547) a tag is 14x the resident it
 * names — the resident is 0.5 screen px and the tag is 8 — and 64 of them stack
 * into an unreadable mass that hides the town they are labelling. Above this
 * zoom the tag is no taller than the figure it names and reads as a caption.
 *
 * Derived from NPC_H, which is itself derived from the town's own median
 * building, so "a tag is smaller than its resident" stays true when the town
 * grows instead of being a number someone picked once.
 */
export const TAG_MIN_ZOOM = TAG_PX / NPC_H;

/** A resident is drawn while it is at least this many screen px tall. */
const NPC_MIN_PX = 1.5;

/** Resident world px -> the zoom at which it is still NPC_MIN_PX tall. */
export const NPC_MIN_ZOOM = NPC_MIN_PX / NPC_H;

/**
 * Tallest silhouette the scenery pass draws: a full-size pine, 36 world px of
 * trunk-to-crown times the largest per-tree scale (1.35) = ~48.
 */
const SCENERY_TALLEST_W = 48;

/**
 * Per-object scenery (trees, props, traffic lights, vehicles) stops being drawn
 * while the largest silhouette is under this many screen px.
 *
 * This is the one that matters. Measured at an 890x560 viewport, one frame of
 * draw() issues: 10.5k canvas ops at the old MIN_ZOOM 0.45, of which 7.8k is
 * scenery; and 299k ops at 0.0547, of which 249k — 83% — is the per-object pass
 * over 6,012 trees, 2,482 props, 203 lights and 738 vehicles, every one of them
 * two to three screen px tall. Six screen px is the legibility floor set for
 * this pass: under it the trees stop being shapes and become texture, and the
 * opaque park plates, the road grid and the district aprons that
 * drawTerrainDecor already paints carry the map on their own. With the gate the
 * same frame is 49k ops.
 *
 * The gate is all-or-nothing because the queue pushScenery hands back is a flat
 * list of opaque draw closures — the engine can count them but cannot thin them
 * by kind. Real thinning (skipping a deterministic fraction of the trees as the
 * camera pulls back, the way a tile pyramid does) has to happen inside
 * pushScenery in scenery.ts, which also owns the only thing left in the frame at
 * this zoom: drawTerrainDecor's grass-tuft loop, 46.7k of the 49k ops that
 * remain after this gate.
 */
const SCENERY_MIN_PX = 6;
export const SCENERY_MIN_ZOOM = SCENERY_MIN_PX / SCENERY_TALLEST_W;

/** A lamp glow has a 34 world-px radius; under this many screen px it is a haze. */
const GLOW_MIN_PX = 6;
export const GLOW_MIN_ZOOM = GLOW_MIN_PX / 34;

/** Building labels are drawn at LABEL_PX world px, inside the camera transform. */
const LABEL_PX = 7;
/** Below this many screen px of label there is no text left to read. */
const LABEL_MIN_PX = 2;
export const LABEL_MIN_ZOOM = LABEL_MIN_PX / LABEL_PX;

/**
 * Movement constants — the three numbers the walking behaviour hangs on.
 *
 * ARRIVE_R is a fixed radius consumed from the agent's real position: no snap
 * to the tile centre, and no speed-dependent threshold that can flicker a
 * waypoint in and out as the sprite wobbles around it.
 */
const ARRIVE_R = 4;
/** Below this distance to the waypoint the walk eases off instead of lurching. */
const SLOW_R = 18;
/** Personal space (world px): separation kicks in under this gap. */
const SEP_R = 14;
/** Separation is a speed, not a shove: it may add at most this many px/s. */
const SEP_V = 48;
/** walkPhase is distance-driven: one gait cycle per 25px actually travelled. */
const STEP_PER_PX = 0.04;
/** How fast velocity re-aims at the desired velocity (per-frame, ~60Hz). */
const STEER_K = 0.22;

/** The slice of a contest the renderer needs (08 §9, §10.2). */
export interface ContestMark {
  state: "announced" | "live" | "resolved";
  /** venue location id — the glow target and the audience's destination */
  place: string;
  entrants: readonly string[];
  /** entrant id → 1-based rank; empty until the contest resolves */
  ranks: Readonly<Record<string, number>>;
}

export interface AgentSprite {
  id: string;
  name: string;
  handle: string;
  genes: string;
  x: number;
  y: number;
  tx: number;
  ty: number;
  path: Array<{ x: number; y: number }>;
  facing: 1 | -1;
  doing: string;
  place: string;
  mood: number;
  born: number;
  // movement realism
  vx: number;
  vy: number;
  baseSpeed: number;
  wanderTimer: number;
  walkPhase: number;
  idlePhase: number;
  targetPlace: string;
  /**
   * Rendered sprite cache. The llama bitmap is re-rendered only when the
   * quantized pose changes — without this every visible resident allocated a
   * fresh DOM canvas + ImageData and ran the 3,016px copy loop every frame,
   * which was the main source of camera stutter at town zoom.
   */
  sprite?: { key: string; canvas: HTMLCanvasElement; img: ImageData };
}

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  kind: "spit" | "dust";
}

interface SpeechBubble {
  text: string;
  until: number;
  by: string;
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export class Xf {
  cam = { x: CAM_HOME_X, y: CAM_HOME_Y, tx: CAM_HOME_X, ty: CAM_HOME_Y, zoom: 1, tz: 1 };
  clock = 0; // 0..1
  dayLength = DAY_LENGTH_SEC;
  byId = new Map<string, AgentSprite>();
  puffs: Puff[] = [];
  bubbles: SpeechBubble[] = [];
  followId: string | null = null;
  /** Fires on every follow change; WorldCanvas forwards it to the HUD. */
  onFollow: ((id: string | null) => void) | null = null;
  /** current Hermes Trials contest, or null on a quiet day (08 §10.1) */
  contest: ContestMark | null = null;
  private t = 0;

  /** Ground colours from CSS. getComputedStyle forces a style recalc, so read
   *  once per theme instead of once per frame (draw() ran it 60x/sec). */
  private groundCols = { theme: "", field: "#cfe8c0", hill: "#b8d8a8" };

  private groundColors(isDark: boolean): { field: string; hill: string } {
    const theme = isDark ? "dark" : "light";
    const c = this.groundCols;
    if (c.theme !== theme && typeof document !== "undefined") {
      const cs = getComputedStyle(document.documentElement);
      c.field = cs.getPropertyValue("--field").trim() || (isDark ? "#1e2e22" : "#cfe8c0");
      c.hill = cs.getPropertyValue("--field-hill").trim() || (isDark ? "#243628" : "#b8d8a8");
      c.theme = theme;
    }
    return c;
  }

  worldW = WorldWidth;
  worldH = WorldHeight;
  /** CSS px size of the canvas viewport, kept fresh by setViewport(). */
  viewW = 0;
  viewH = 0;
  dpr = 1;

  constructor(snapshot?: { herd: Array<{ id: string; name: string; handle: string; genes: string; mind: { doing: { place: string; act: string } }; born: number; }>; }) {
    if (snapshot) {
      for (const h of snapshot.herd) {
        const loc = LOCATIONS.find((l) => l.id === h.mind.doing.place) ?? LOCATIONS[0]!;
        const sx = loc.spot[0] * V + (Math.random() * 24 - 12);
        const sy = loc.spot[1] * V + (Math.random() * 24 - 12);
        const hid = hashId(h.id);
        this.byId.set(h.id, {
          id: h.id,
          name: h.name,
          handle: h.handle,
          genes: h.genes,
          x: sx,
          y: sy,
          tx: sx,
          ty: sy,
          path: [],
          facing: Math.random() < 0.5 ? 1 : -1,
          doing: h.mind.doing.act,
          place: h.mind.doing.place,
          mood: 0,
          born: h.born,
          vx: 0,
          vy: 0,
          baseSpeed: 0.88 + (hid % 100) / 250, // 0.88 - 1.28
          wanderTimer: 1.0 + Math.random() * 2.5,
          walkPhase: Math.random(),
          idlePhase: Math.random() * Math.PI * 2,
          targetPlace: h.mind.doing.place,
        });
      }
    }
  }

  /**
   * Follow mode — and the single door every release walks through: Free Cam,
   * Escape, a pan, a zoom, a tap on open ground, the resident leaving town.
   *
   * Releasing stops the camera dead where the player can see it instead of
   * letting it keep easing toward the last target, and it reports the change,
   * so the HUD can never claim a follow the engine already dropped (or miss
   * one it just picked up).
   */
  setFollow(id: string | null): void {
    const prev = this.followId;
    this.followId = id;
    if (id === null && prev !== null) {
      this.cam.tx = this.cam.x;
      this.cam.ty = this.cam.y;
    }
    if (prev !== id) this.onFollow?.(id);
  }

  /**
   * Contest channel (08 §10.2). `null` is the default and the common case: a
   * town with no contest draws exactly as it did before the Trials existed.
   */
  setContest(mark: ContestMark | null) {
    this.contest = mark;
  }

  /**
   * Ring + name-tag colour for a sprite, or null when it is not competing.
   * While the contest runs every entrant shares one colour; the ranks colour
   * them separately the moment there is a result to show (08 §10.2).
   */
  contestColor(id: string): string | null {
    const c = this.contest;
    if (!c || !c.entrants.includes(id)) return null;
    const rank = c.ranks[id];
    return c.state === "resolved" && rank ? (RANK_COLORS[rank - 1] ?? ENTRANT_COLOR) : ENTRANT_COLOR;
  }

  /** Follow mode still wins the tag; a contestant's rank colour comes next. */
  private tagColor(id: string): string {
    if (id === this.followId) return "#c9a86a";
    return this.contestColor(id) ?? "#1b1915";
  }

  // ---- camera -------------------------------------------------------------
  // Rule: any manual pan/zoom owns the camera and drops follow, so the view
  // never fights the pointer. The camera is only re-targeted by follow mode.

  setViewport(w: number, h: number, dpr = this.dpr): void {
    this.viewW = w;
    this.viewH = h;
    this.dpr = dpr > 0 ? dpr : 1;
  }

  /** Pan by a screen-space delta (CSS px), 1:1 with the pointer. */
  panBy(dxScreen: number, dyScreen: number): void {
    const z = this.cam.zoom || 1;
    this.cam.tx -= dxScreen / z;
    this.cam.ty -= dyScreen / z;
    this.cam.x = this.cam.tx;
    this.cam.y = this.cam.ty;
    this.setFollow(null);
    this.clampCam();
  }

  /**
   * Zoom by `factor` anchored on a canvas-relative screen point: the world
   * point under that point stays put. Applied instantly so the anchor cannot
   * drift between zoom targets. Zoom never moves the camera on its own — the
   * anchor shifts it by however much the cursor sat off-centre, and no more.
   */
  zoomAt(sx: number, sy: number, factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const cam = this.cam;
    const z0 = cam.zoom;
    const z1 = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z0 * factor));
    if (z1 === z0) return;
    const ox = sx - this.viewW / 2;
    const oy = sy - this.viewH / 2;
    const wx = cam.x + ox / z0;
    const wy = cam.y + oy / z0;
    cam.zoom = z1;
    cam.tz = z1;
    cam.tx = wx - ox / z1;
    cam.ty = wy - oy / z1;
    cam.x = cam.tx;
    cam.y = cam.ty;
    this.setFollow(null);
    this.clampCam();
  }

  /**
   * The one rule the camera never breaks: its centre stays over the town.
   *
   * The bounds are deliberately independent of zoom. A zoom-dependent band
   * shrinks as you zoom out, so clamping against it used to yank the camera
   * back toward the middle of the map — measured in Chrome at 752,9 world px
   * (2744 → 1991) panning the east edge at zoom 1 down to the old MIN_ZOOM.
   * With fixed bounds zooming only changes what you see, never where the camera
   * is, and a pan stops against a wall instead of springing back to a band
   * around the centre.
   *
   * Keeping the centre on the map is what bounds the emptiness: at least half
   * the viewport always shows town, and the rest is open field in the same
   * colour as the ground. That still holds at the new MIN_ZOOM — at an 890px
   * viewport the view is 16,274 world px wide against a 16,800px map, so even
   * pinned to a corner at least half the screen is town.
   */
  clampCam(): void {
    const cam = this.cam;
    cam.tx = Math.max(0, Math.min(this.worldW, cam.tx));
    cam.ty = Math.max(0, Math.min(this.worldH, cam.ty));
    cam.x = Math.max(0, Math.min(this.worldW, cam.x));
    cam.y = Math.max(0, Math.min(this.worldH, cam.y));
  }

  /** Back to the town overview, follow dropped. */
  resetCam(): void {
    this.setFollow(null);
    this.cam.x = this.cam.tx = CAM_HOME_X;
    this.cam.y = this.cam.ty = CAM_HOME_Y;
    this.cam.zoom = this.cam.tz = 1;
    this.clampCam();
  }

  /** Viewport centre in CSS px — the anchor for keyboard zoom. */
  centerPoint(): { x: number; y: number } {
    return { x: this.viewW / 2, y: this.viewH / 2 };
  }

  tick(dt: number): void {
    this.t += dt;
    this.clock = (this.clock + dt / this.dayLength) % 1;
    // Frame-rate-independent exponential smoothing. The old 0.08/frame factor
    // made the camera converge at a different speed on every refresh rate and
    // stutter whenever frames dropped; k matches 0.08 at 60fps exactly.
    const k = 1 - Math.exp(-dt * 5);
    this.cam.x += (this.cam.tx - this.cam.x) * k;
    this.cam.y += (this.cam.ty - this.cam.y) * k;
    this.cam.zoom += (this.cam.tz - this.cam.zoom) * k;

    const actSpeed: Record<string, number> = {
      sleep: 0,
      spit: 0,
      shake: 0,
      graze: 26,
      drink: 28,
      wander: 34,
      stroll: 30,
      explore: 44,
      work: 36,
      talk: 30,
      argue: 34,
    };

    // move agents along path + autonomous idle wander
    for (const a of this.byId.values()) {
      const isSleeping = a.doing === "sleep";
      const targetSpeedBase = (actSpeed[a.doing] ?? 32) * a.baseSpeed;
      const prevX = a.x;
      const prevY = a.y;

      // Desired velocity this frame (px/s). The walk branch fills it in from
      // the current waypoint; the idle branch below leaves it at rest, and the
      // shared block at the end of the loop adds separation and integrates.
      let steerX = 0;
      let steerY = 0;

      if (a.path.length > 0) {
        const next = a.path[0]!;
        // The waypoint centre is fixed — no wobble, so the distance to it can
        // only shrink and the arrival test cannot flicker around a threshold.
        const tx = next.x * V + V / 2;
        const ty = next.y * V + V / 2;
        const dx = tx - a.x;
        const dy = ty - a.y;
        const dist = Math.hypot(dx, dy);

        if (dist < ARRIVE_R) {
          // consume the waypoint from the agent's real position — never snap
          a.path.shift();
          // occasional dust puff when stepping
          if (Math.random() < 0.18 && targetSpeedBase > 20) {
            // spawn point rides with the resident: the hooves are on a.y now,
            // so +8 would drop the dust a body-height behind them
            this.puffs.push({ x: a.x, y: a.y + 1.5, vx: (Math.random() - 0.5) * 18 * NPC_K, vy: (-8 - Math.random() * 12) * NPC_K, life: 0.42, kind: "dust" });
          }
        } else {
          // arrival slowdown + per-frame speed variation — both in px/s now
          const slowFactor = dist < SLOW_R ? dist / SLOW_R : 1;
          const jitter = 0.88 + Math.random() * 0.24; // per-frame speed variation
          const speed = targetSpeedBase * slowFactor * jitter;
          const dirX = dx / dist;
          const dirY = dy / dist;
          // A zero-speed act (sleep/spit/shake) holds a stale waypoint — the
          // sway term below would still be a live velocity and make them
          // jiggle in place all night, keeping moved > 0 so the gait animates
          // while asleep. No speed, no steer: steerX/steerY stay at rest.
          if (speed > 0) {
            // slight perpendicular sway for organic — a velocity, not a position kick
            const sway = Math.sin(this.t * 2.4 + hashId(a.id) * 0.02) * 2;
            steerX = dirX * speed - dirY * sway;
            steerY = dirY * speed + dirX * sway;
            // smooth facing, hysteresis 4px
            if (Math.abs(dx) > 3) a.facing = dx > 0 ? 1 : -1;
            // slight idle phase for breathing while moving
            a.idlePhase += dt * 0.6;
          }
        }
      } else {
        // no path — autonomous idle wander if not sleeping
        if (!isSleeping) {
          a.wanderTimer -= dt;

          if (a.wanderTimer <= 0) {
            // pick new idle target
            const r = Math.random();
            let nx: number, ny: number;
            if (r < 0.32) {
              // wander to random nearby spot (radius 50-110)
              const ang = Math.random() * Math.PI * 2;
              const rad = 48 + Math.random() * 62;
              nx = Math.floor((a.x + Math.cos(ang) * rad) / V);
              ny = Math.floor((a.y + Math.sin(ang) * rad) / V);
            } else if (r < 0.62) {
              // 08 §9 — while a contest is live the town walks to the venue.
              // A bias on the same random pick the residents already make, never
              // a forced path: they are an audience, not a queued crowd, and the
              // sim keeps owning where they actually go.
              const mark = this.contest;
              const venue = mark && mark.state === "live" && !mark.entrants.includes(a.id)
                ? LOCATIONS.find((l) => l.id === mark.place)
                : undefined;
              const loc = venue && Math.random() < 0.62 ? venue : LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)]!;
              nx = loc.spot[0] + Math.floor((Math.random() - 0.5) * 3);
              ny = loc.spot[1] + Math.floor((Math.random() - 0.5) * 3);
              a.targetPlace = loc.id;
              // 40% keep doing as stroll, else wander
              if (Math.random() < 0.4) a.doing = Math.random() < 0.5 ? "stroll" : "wander";
            } else {
              // small jitter in place
              nx = Math.floor(a.x / V + (Math.random() - 0.5) * 2);
              ny = Math.floor(a.y / V + (Math.random() - 0.5) * 2);
            }
            // Clamp to the grid, not to a remembered copy of it. This read
            // `Math.min(207, nx)` / `Math.min(125, ny)` — the old 210x128 world.
            // The town sits at the CENTRE of the new 1050x640 grid, so every
            // wander target past x=207 or y=125 was snapped back to the empty
            // north-west corner, several thousand pixels from the square. The
            // residents were not stranded in the snapshot; they were being
            // actively teleported there every few seconds.
            nx = Math.max(2, Math.min(Pe - 3, nx));
            ny = Math.max(2, Math.min(vt - 3, ny));
            const sx = Math.floor(a.x / V);
            const sy = Math.floor(a.y / V);
            if (nx !== sx || ny !== sy) {
              // the town's real collision map: buildings are solid, doors and
              // spots are carved walkable, roads are cheap (navmap.ts)
              const nav = navmap();
              const from = nav.nearestWalkable(sx, sy);
              const to = nav.nearestWalkable(nx, ny);
              const path = pf(nav, from.x, from.y, to.x, to.y);
              // smooth: drop every other point for less grid-locked (decimate)
              const smooth = path.filter((_, i) => i % 2 === 0 || i === path.length - 1);
              if (smooth.length > 0) {
                a.path = smooth;
                a.wanderTimer = 1.4 + Math.random() * 2.6;
                // don't reset doing if it's sleep
                if (!["sleep", "spit", "shake"].includes(a.doing)) {
                  if (Math.random() < 0.55) a.doing = Math.random() < 0.6 ? "wander" : "stroll";
                }
                // give a little initial velocity wobble
                a.vx += (Math.random() - 0.5) * 6;
                a.vy += (Math.random() - 0.5) * 6;
              } else {
                a.wanderTimer = 0.6 + Math.random();
              }
            } else {
              a.wanderTimer = 0.8 + Math.random();
            }
          } else {
            // idle: animation phase only — an idle resident does not move.
            // (the old breathing/fidget kicks here were position teleports:
            // an idle agent drifted and jumped tiles over a few hundred ticks)
            a.idlePhase += dt * (0.7 + a.baseSpeed * 0.3);
          }
        } else {
          // sleeping: just breathing
          a.idlePhase += dt * 0.5;
        }
      }

      // ---- shared every-frame block: separation + integration -------------
      // separation runs while walking too, and it is a speed (px/s), never a
      // positional shove: the integration below is the only thing that moves
      // an agent, so nothing can jump more than one frame of velocity.
      if (!isSleeping) {
        let sepX = 0;
        let sepY = 0;
        for (const other of this.byId.values()) {
          if (other.id === a.id) continue;
          const dx = a.x - other.x;
          const dy = a.y - other.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < SEP_R * SEP_R && d2 > 0.1) {
            const d = Math.sqrt(d2);
            const w = (SEP_R - d) / SEP_R;
            sepX += (dx / d) * w;
            sepY += (dy / d) * w;
          }
        }
        if (sepX || sepY) {
          const m = Math.hypot(sepX, sepY);
          if (m > 1) { sepX /= m; sepY /= m; }
          steerX += sepX * SEP_V;
          steerY += sepY * SEP_V;
        }
      } else {
        a.vx = 0;
        a.vy = 0;
      }

      // pure pos += v*dt: velocity eases toward the desired velocity, then
      // the position advances by exactly one frame of it
      a.vx += (steerX - a.vx) * STEER_K;
      a.vy += (steerY - a.vy) * STEER_K;
      a.x += a.vx * dt;
      a.y += a.vy * dt;

      // walkPhase follows the ground actually covered — it advances while the
      // resident walks and stops the frame they stop (AC6)
      const moved = Math.hypot(a.x - prevX, a.y - prevY);
      if (moved > 0) a.walkPhase = (a.walkPhase + moved * STEP_PER_PX) % 1;

      // clamp to world
      a.x = Math.max(12, Math.min(this.worldW - 12, a.x));
      a.y = Math.max(12, Math.min(this.worldH - 12, a.y));
    }

    // puffs life
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 40 * dt; // gravity
      p.life -= dt;
      if (p.life <= 0) this.puffs.splice(i, 1);
    }

    // bubbles expire
    const now = Date.now();
    this.bubbles = this.bubbles.filter((b) => b.until > now);

    // follow
    if (this.followId) {
      const f = this.byId.get(this.followId);
      if (f) {
        this.cam.tx = f.x;
        this.cam.ty = f.y;
      } else {
        this.setFollow(null); // followed agent left the herd — stop chasing
      }
    }
    this.clampCam();

    // vehicles drive the road network (traffic lights brake them)
    tickScenery(dt, this.t);
  }

  order(id: string, act: string, place: string, _secs: number): void {
    const a = this.byId.get(id);
    if (!a) return;
    // don't override shake/spit mid-animation
    if (a.doing === "shake" || a.doing === "spit") {
      // queue will be handled after animation ends; store targetPlace for later
      a.targetPlace = place;
      return;
    }
    a.doing = act;
    a.place = place;
    a.targetPlace = place;
    a.wanderTimer = 1.2 + Math.random() * 1.4; // reset wander so server order has priority
    const loc = LOCATIONS.find((l) => l.id === place);
    if (loc) {
      // add jitter to spot so not all agents stack exactly
      const jitterX = (hashId(a.id) % 7 - 3) * 2 + (Math.random() - 0.5) * 6;
      const jitterY = (hashId(a.id) % 5 - 2) * 2 + (Math.random() - 0.5) * 6;
      const tx = loc.spot[0] + Math.floor(jitterX / V);
      const ty = loc.spot[1] + Math.floor(jitterY / V);
      const sx = Math.floor(a.x / V);
      const sy = Math.floor(a.y / V);
      // the town's real collision map — same one the wander picker uses, so
      // both pf() call sites see buildings as walls and doors as doors
      const nav = navmap();
      const from = nav.nearestWalkable(sx, sy);
      const to = nav.nearestWalkable(tx, ty);
      const path = pf(nav, from.x, from.y, to.x, to.y);
      // smooth path: keep first, decimate middle, keep last
      const smooth = path.length > 6 ? path.filter((_, i) => i % 2 === 0 || i === path.length - 1) : path;
      a.path = smooth;
      // give initial push for snappier start
      if (smooth.length > 0) {
        const dx = smooth[0].x * V - a.x;
        const dy = smooth[0].y * V - a.y;
        const d = Math.hypot(dx, dy) || 1;
        a.vx = (dx / d) * 12;
        a.vy = (dy / d) * 12;
      }
    }
  }

  spit(fromId: string, toId: string): void {
    const attacker = this.byId.get(fromId);
    const victim = this.byId.get(toId);
    if (!attacker || !victim) return;
    attacker.facing = victim.x > attacker.x ? 1 : -1;
    attacker.doing = "spit";
    attacker.path = [];
    attacker.vx = attacker.facing * 8;
    setTimeout(() => {
      // launched from head height and scaled like the sprite: the old offsets
      // were tuned for a 63px figure and would fire over the roofline now
      this.puffs.push({ x: attacker.x + attacker.facing * 22 * NPC_K, y: attacker.y - 26 * NPC_K, vx: attacker.facing * 140 * NPC_K, vy: -30 * NPC_K, life: 0.8, kind: "spit" });
      victim.doing = "shake";
      victim.path = [];
      victim.mood -= 0.6;
      victim.vx = -attacker.facing * 10;
      setTimeout(() => { if (victim.doing === "shake") { victim.doing = "wander"; victim.wanderTimer = 0.4; } }, 700);
      setTimeout(() => { if (attacker.doing === "spit") { attacker.doing = "wander"; attacker.wanderTimer = 0.3; } }, 520);
    }, 120);
  }

  post(post: { t: number; by: string; text: string }): void {
    this.bubbles.push({ text: post.text, by: post.by, until: Date.now() + 6500 });
    if (this.bubbles.length > 8) this.bubbles.shift();
    // speaker does a little head bob
    const s = this.byId.get(post.by);
    if (s) s.idlePhase += 0.6;
  }

  nightIntensity(): number {
    const c = this.clock;
    if (c < 0.72 || c > 0.95) return 0;
    if (c < 0.78) return (c - 0.72) / 0.06;
    if (c < 0.88) return 1;
    return Math.max(0, 1 - (c - 0.88) / 0.07);
  }

  /**
   * 08 §10.2 — "something is starting", told by the world rather than by an
   * overlay: the venue carries a warm pool of light and a dashed outline of
   * the exact spot. An announcement lights the hall and the notice board too,
   * so the call still reads when the venue itself is a pond off to one side.
   */
  private drawVenueGlow(ctx: CanvasRenderingContext2D): void {
    const mark = this.contest!;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 3.1);
    const colour: [number, number, number] = mark.state === "resolved" ? [150, 190, 255] : [255, 205, 110];
    const alpha = mark.state === "live" ? 0.4 : mark.state === "announced" ? 0.28 : 0.16;
    if (mark.state === "announced") {
      this.glowAt(ctx, "hall", colour, alpha * 0.8, pulse);
      this.glowAt(ctx, "board", colour, alpha * 0.8, pulse);
    }
    this.glowAt(ctx, mark.place, colour, alpha, pulse);
  }

  private glowAt(ctx: CanvasRenderingContext2D, locId: string, colour: [number, number, number], alpha: number, pulse: number): void {
    const loc = LOCATIONS.find((l) => l.id === locId);
    if (!loc) return;
    const cx = (loc.x + loc.w / 2) * V;
    const cy = (loc.y + loc.h / 2) * V;
    const r = Math.max(loc.w, loc.h) * V * 0.7 + 46;
    const a = alpha * (0.75 + 0.25 * pulse);
    const [cr, cg, cb] = colour;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
    grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    // dashed footprint: the pool says "somewhere here", this says exactly where
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},${Math.min(0.95, a * 2)})`;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([11, 7]);
    ctx.strokeRect(loc.x * V - 5, loc.y * V - 5, loc.w * V + 10, loc.h * V + 10);
    ctx.setLineDash([]);
  }

  draw(ctx: CanvasRenderingContext2D, viewportW: number, viewportH: number): void {
    const cam = this.cam;
    // which level of detail this frame is drawn at, read once so every gate
    // below and the night's lamp pass agree on it
    const z = cam.zoom;
    const lod = {
      scenery: z >= SCENERY_MIN_ZOOM,
      residents: z >= NPC_MIN_ZOOM,
      labels: z >= LABEL_MIN_ZOOM,
      glows: z >= GLOW_MIN_ZOOM,
    };
    ctx.save();
    ctx.clearRect(0, 0, viewportW, viewportH);
    ctx.translate(viewportW / 2, viewportH / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    const isDarkTheme = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
    // cached per theme — getComputedStyle every frame forces a style recalc
    const { field: fieldCol, hill: hillCol } = this.groundColors(isDarkTheme);
    ctx.fillStyle = fieldCol;
    ctx.fillRect(0, 0, this.worldW, this.worldH);

    ctx.fillStyle = hillCol;
    for (let i = 0; i < 30; i++) {
      const x = (i * 137) % this.worldW;
      const y = (i * 241) % this.worldH;
      ctx.beginPath();
      ctx.ellipse(x, y, 80, 40, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const viewLeft0 = cam.x - viewportW / 2 / cam.zoom - 120;
    const viewRight0 = cam.x + viewportW / 2 / cam.zoom + 120;
    const viewTop0 = cam.y - viewportH / 2 / cam.zoom - 120;
    const viewBottom0 = cam.y + viewportH / 2 / cam.zoom + 120;
    const sceneDraw: SceneDraw = { isDark: isDarkTheme, night: this.nightIntensity(), time: this.t };
    const sceneView: View = { l: viewLeft0, r: viewRight0, t: viewTop0, b: viewBottom0, zoom: cam.zoom };
    drawTerrainDecor(ctx, sceneView, sceneDraw);

    ctx.strokeStyle = isDarkTheme ? "#2e2a25" : "#d8c9a8";
    ctx.lineWidth = 8;
    ctx.beginPath();
    for (const loc of LOCATIONS) {
      if (loc.category === "Social" || loc.category === "Civic") {
        ctx.rect(loc.x * V, loc.y * V, loc.w * V, loc.h * V);
      }
    }
    ctx.stroke();

    type Q = { y: number; draw: () => void };
    const queue: Q[] = [];

    const viewLeft = cam.x - viewportW / 2 / cam.zoom - 120;
    const viewRight = cam.x + viewportW / 2 / cam.zoom + 120;
    const viewTop = cam.y - viewportH / 2 / cam.zoom - 120;
    const viewBottom = cam.y + viewportH / 2 / cam.zoom + 120;

    // trees, street furniture, vehicles — pushed first so buildings/agents win ties
    if (lod.scenery) pushScenery(queue, ctx, sceneView, sceneDraw);

    for (const b of LOCATIONS) {
      const bx = b.x * V, by = b.y * V, bw = b.w * V, bh = b.h * V;
      if (bx + bw < viewLeft || bx > viewRight || by + bh < viewTop || by > viewBottom) continue;
      // skip pure field/water from building queue — they get terrain treatment below
      if (b.category === "Food" || b.category === "Water") {
        queue.push({
          y: by + bh,
          draw: () => {
            const isPond = b.id === "pond";
            const isMeadow = b.id === "meadowW" || b.id === "meadowE";
            const isOrchard = b.id === "orchard";
            const isTrough = b.id === "trough";
            // base field
            ctx.save();
            if (isPond) {
              ctx.fillStyle = isDarkTheme ? "rgba(74,122,150,0.55)" : "rgba(118,184,216,0.55)";
              ctx.beginPath();
              // organic pond shape
              ctx.ellipse(bx + bw / 2, by + bh / 2, bw / 2 - 4, bh / 2 - 6, 0, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = isDarkTheme ? "rgba(90,140,170,0.9)" : "rgba(90,160,190,0.9)";
              ctx.lineWidth = 1.5;
              ctx.stroke();
              // highlight ripple
              ctx.fillStyle = isDarkTheme ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.35)";
              ctx.beginPath();
              ctx.ellipse(bx + bw / 2 - 8, by + bh / 2 - 4, 18, 8, -0.2, 0, Math.PI * 2);
              ctx.fill();
            } else if (isOrchard) {
              ctx.fillStyle = isDarkTheme ? "rgba(45,62,38,0.45)" : "rgba(190,220,170,0.35)";
              ctx.fillRect(bx, by, bw, bh);
              ctx.strokeStyle = isDarkTheme ? "#2e3d2a" : "#8fb88a";
              ctx.setLineDash([4, 3]);
              ctx.strokeRect(bx, by, bw, bh);
              ctx.setLineDash([]);
              // trees as dots
              ctx.fillStyle = isDarkTheme ? "#3d5a32" : "#5a8a4a";
              for (let tx = 0; tx < 3; tx++) for (let ty = 0; ty < 2; ty++) {
                const x = bx + 14 + tx * 28 + (ty % 2 ? 14 : 0);
                const y = by + 14 + ty * 26;
                ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = isDarkTheme ? "#6b7a3a" : "#8ab66a";
                ctx.beginPath(); ctx.arc(x, y - 3, 3, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = isDarkTheme ? "#3d5a32" : "#5a8a4a";
              }
            } else if (isTrough) {
              ctx.fillStyle = isDarkTheme ? "#3d2f1e" : "#8b6a3a";
              ctx.fillRect(bx, by + bh - 10, bw, 10);
              ctx.fillStyle = isDarkTheme ? "#5a4328" : "#c9a86a";
              ctx.fillRect(bx + 2, by + bh - 12, bw - 4, 3);
              ctx.fillStyle = isDarkTheme ? "#d8c9a8" : "#f4f1ea";
              ctx.fillRect(bx + 4, by + bh - 10, bw - 8, 2);
            } else if (isMeadow) {
              // meadow field with subtle furrows
              ctx.fillStyle = isMeadow && b.id === "meadowW" ? (isDarkTheme ? "rgba(46,74,42,0.5)" : "rgba(180,220,160,0.45)") : (isDarkTheme ? "rgba(62,58,32,0.45)" : "rgba(210,200,140,0.4)");
              ctx.fillRect(bx, by, bw, bh);
              ctx.strokeStyle = isDarkTheme ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)";
              ctx.lineWidth = 0.6;
              for (let fx = bx + 6; fx < bx + bw; fx += 12) {
                ctx.beginPath(); ctx.moveTo(fx, by + 4); ctx.lineTo(fx - 4, by + bh - 4); ctx.stroke();
              }
              ctx.setLineDash([6, 4]); ctx.strokeStyle = isDarkTheme ? "rgba(201,168,106,0.35)" : "rgba(201,168,106,0.45)"; ctx.strokeRect(bx, by, bw, bh); ctx.setLineDash([]);
            } else {
              ctx.fillStyle = isDarkTheme ? "rgba(40,55,40,0.35)" : "rgba(200,230,190,0.25)";
              ctx.fillRect(bx, by, bw, bh);
              ctx.strokeStyle = isDarkTheme ? "#2e3d2a" : "#a8c9a0";
              ctx.strokeRect(bx, by, bw, bh);
            }
            ctx.restore();
            // label — 7px inside the camera transform, so below LABEL_MIN_ZOOM
            // it is under 2 screen px and the shaping cost buys nothing
            if (lod.labels) {
              ctx.fillStyle = isDarkTheme ? "#a49c90" : "#1b1915";
              ctx.font = `${LABEL_PX}px JetBrains Mono`;
              ctx.textAlign = "center";
              ctx.globalAlpha = 0.85;
              ctx.fillText(b.name.replace("The ", ""), bx + bw / 2, by + bh + 10);
              ctx.globalAlpha = 1;
            }
          },
        });
        continue;
      }
      queue.push({
        y: by + bh,
        draw: () => {
          ctx.save();
          // shadow
          ctx.fillStyle = "rgba(0,0,0,0.10)";
          ctx.fillRect(bx + 5, by + 5, bw, bh);
          const isDark = isDarkTheme || this.nightIntensity() > 0.5;
          // per-category palette, one table per theme (see BUILD_INK)
          const inkTable = isDarkTheme ? BUILD_INK.dark : BUILD_INK.light;
          const ink = inkTable[b.category] ?? inkTable.base!;
          const roof = ink.roof;
          const trim = ink.trim;
          const wood = ink.wood;
          // night inside the light theme darkens the walls without swapping palette
          let wall = isDark && !isDarkTheme ? "#5a4a3a" : ink.wall;
          // wall
          ctx.fillStyle = wall;
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = trim;
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, bw, bh);
          // roof — per category silhouette
          ctx.fillStyle = roof;
          if (b.category === "Rest" && b.id === "barn") {
            // gambrel
            ctx.beginPath(); ctx.moveTo(bx - 3, by); ctx.lineTo(bx + bw / 2, by - 10); ctx.lineTo(bx + bw + 3, by); ctx.lineTo(bx + bw, by + 2); ctx.lineTo(bx, by + 2); ctx.closePath(); ctx.fill();
            ctx.strokeStyle = trim; ctx.stroke();
          } else if (b.category === "Civic" && b.id === "hall") {
            // pediment
            ctx.beginPath(); ctx.moveTo(bx - 2, by); ctx.lineTo(bx + bw / 2, by - 12); ctx.lineTo(bx + bw + 2, by); ctx.closePath(); ctx.fill();
            // columns
            ctx.fillStyle = isDarkTheme ? "#d8d2c6" : "#f4f1ea";
            for (let cx = 0; cx < 3; cx++) ctx.fillRect(bx + 6 + cx * (bw - 12) / 2, by + 4, 3, bh - 8);
          } else if (b.id === "vault") {
            ctx.fillRect(bx - 2, by - 4, bw + 4, 4); // flat stone
            ctx.fillStyle = isDarkTheme ? "#c9a86a" : "#1b1915"; ctx.fillRect(bx + bw / 2 - 4, by + bh / 2 - 6, 8, 10); // door
          } else if (b.id === "station") {
            ctx.fillRect(bx - 3, by - 5, bw + 6, 5); // canopy
            ctx.fillStyle = trim; ctx.fillRect(bx, by + bh - 3, bw, 3);
          } else {
            // default gable
            ctx.fillRect(bx - 2, by - 6, bw + 4, 6);
            // trim line
            ctx.fillStyle = "rgba(0,0,0,0.08)"; ctx.fillRect(bx - 2, by, bw + 4, 1);
          }
          // details per sub-type
          if (b.id === "market") {
            // awning stripes
            ctx.fillStyle = isDarkTheme ? "#c9a86a" : "#e8e3d7";
            for (let ax = 0; ax < bw; ax += 8) ctx.fillRect(bx + ax, by + bh - 6, 4, 6);
            ctx.fillStyle = isDarkTheme ? "#7a4a2e" : "#a66a3a"; ctx.fillRect(bx, by + bh - 6, bw, 1);
          } else if (b.id === "tavern") {
            ctx.fillStyle = "rgba(255,220,120,0.45)"; ctx.fillRect(bx + 4, by + 6, bw - 8, 8); // warm window
            ctx.fillStyle = wood; ctx.fillRect(bx + bw / 2 - 6, by + 10, 12, bh - 14); // door
          } else if (b.id === "library") {
            ctx.fillStyle = isDarkTheme ? "#2e2a25" : "#1b1915"; for (let wx = 0; wx < 2; wx++) ctx.fillRect(bx + 6 + wx * (bw - 14), by + 6, 5, 8);
          } else if (b.id === "mill") {
            // wheel
            ctx.strokeStyle = isDarkTheme ? "#4a3a2e" : "#5a3a1e"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(bx + bw + 6, by + bh / 2, 10, 0, Math.PI * 2); ctx.stroke();
            for (let a = 0; a < 4; a++) { const ang = (a * Math.PI / 2); ctx.beginPath(); ctx.moveTo(bx + bw + 6, by + bh / 2); ctx.lineTo(bx + bw + 6 + Math.cos(ang) * 10, by + bh / 2 + Math.sin(ang) * 10); ctx.stroke(); }
          } else if (b.id === "shed") {
            ctx.fillStyle = wood; for (let fx = bx + 4; fx < bx + bw - 4; fx += 6) ctx.fillRect(fx, by + 4, 2, bh - 8);
          } else if (b.id === "depot" || b.id === "garage") {
            // cargo doors + dock stripe
            ctx.fillStyle = isDarkTheme ? "#3a3a3e" : "#4a443c";
            ctx.fillRect(bx + 6, by + 8, bw - 12, bh - 16);
            ctx.fillStyle = isDarkTheme ? "#c9a86a" : "#e8b83a";
            ctx.fillRect(bx + 6, by + bh - 12, bw - 12, 2);
            ctx.strokeStyle = isDarkTheme ? "#5c5850" : "#8a857c"; ctx.lineWidth = 0.8;
            ctx.strokeRect(bx + 6, by + 8, bw - 12, bh - 16);
          } else if (b.id === "tower") {
            // belfry arch + bell
            ctx.fillStyle = isDarkTheme ? "#1e1a18" : "#2b2118";
            ctx.beginPath(); ctx.arc(bx + bw / 2, by + 10, 5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = isDarkTheme ? "#c9a86a" : "#e8b83a";
            ctx.beginPath(); ctx.arc(bx + bw / 2, by + 10, 2.5, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = trim; ctx.fillRect(bx, by + 16, bw, 2);
          } else if (b.id === "arcade") {
            // marquee lights
            ctx.fillStyle = isDarkTheme ? "#c9a86a" : "#b83a2e";
            ctx.fillRect(bx + 2, by + 2, bw - 4, 5);
            ctx.fillStyle = isDarkTheme ? "#ffe9a8" : "#ffe9a8";
            for (let lx = bx + 5; lx < bx + bw - 3; lx += 7) ctx.fillRect(lx, by + 3.5, 2, 2);
          } else if (b.id === "forge") {
            // chimney + ember glow
            ctx.fillStyle = isDarkTheme ? "#3a3530" : "#5a4a3a";
            ctx.fillRect(bx + bw - 14, by - 8, 8, 12);
            ctx.fillStyle = "rgba(255,120,40,0.8)";
            ctx.fillRect(bx + bw - 12, by - 6, 4, 4);
            ctx.fillStyle = isDarkTheme ? "#2e2018" : "#3d2a18";
            ctx.fillRect(bx + 6, by + 8, bw - 20, bh - 16);
          } else if (b.id === "lodge") {
            // antler mount + porch beam
            ctx.strokeStyle = isDarkTheme ? "#8a7a5a" : "#7a5a34"; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(bx + bw / 2 - 4, by + 8); ctx.lineTo(bx + bw / 2, by + 4); ctx.lineTo(bx + bw / 2 + 4, by + 8); ctx.stroke();
            ctx.fillStyle = wood; ctx.fillRect(bx + 2, by + bh - 6, bw - 4, 3);
          } else if (b.id === "observatory") {
            // dome + slit
            ctx.fillStyle = isDarkTheme ? "#3d5566" : "#7fa8c4";
            ctx.beginPath(); ctx.arc(bx + bw / 2, by + 2, bw / 2 - 4, Math.PI, 0); ctx.fill();
            ctx.fillStyle = isDarkTheme ? "#1e1a18" : "#2b2a26";
            ctx.fillRect(bx + bw / 2 - 2, by - 8, 4, 12);
          } else if (b.id === "exchange") {
            // ticker band + columns
            ctx.fillStyle = isDarkTheme ? "#1e2e22" : "#2e5a32";
            ctx.fillRect(bx + 3, by + 3, bw - 6, 7);
            ctx.fillStyle = isDarkTheme ? "#7ec46a" : "#d8f0c8";
            for (let tx = 0; tx < 3; tx++) ctx.fillRect(bx + 6 + tx * ((bw - 12) / 3), by + 5, (bw - 12) / 3 - 3, 3);
            ctx.fillStyle = isDarkTheme ? "#d8d2c6" : "#f4f1ea";
            ctx.fillRect(bx + 6, by + 14, 3, bh - 22);
            ctx.fillRect(bx + bw - 9, by + 14, 3, bh - 22);
          }
          // windows — night glow
          if (this.nightIntensity() > 0.18) {
            const glow = `rgba(255, 220, 120, ${0.52 * this.nightIntensity()})`;
            ctx.fillStyle = glow;
            // two windows
            ctx.fillRect(bx + 5, by + 6, 7, 7);
            ctx.fillRect(bx + bw - 12, by + 6, 7, 7);
            // window cross
            ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 0.6;
            ctx.strokeRect(bx + 5, by + 6, 7, 7); ctx.strokeRect(bx + bw - 12, by + 6, 7, 7);
          } else if (!isDarkTheme) {
            ctx.fillStyle = "#2e2a25"; ctx.fillRect(bx + 6, by + 7, 6, 6); ctx.fillRect(bx + bw - 12, by + 7, 6, 6);
          }
          // door
          ctx.fillStyle = isDarkTheme ? "#1e1a18" : "#2b2118";
          ctx.fillRect(bx + bw / 2 - 5, by + bh - 10, 10, 10);
          ctx.fillStyle = "rgba(201,168,106,0.9)"; ctx.fillRect(bx + bw / 2 + 2, by + bh - 6, 1.2, 1.2);
          // label — same screen-size floor as the terrain labels above
          if (lod.labels) {
            ctx.fillStyle = isDarkTheme ? "#a49c90" : "#1b1915";
            ctx.font = `${LABEL_PX}px JetBrains Mono`;
            ctx.textAlign = "center";
            ctx.globalAlpha = 0.9;
            // strip behind label
            ctx.fillStyle = isDarkTheme ? "rgba(28,26,24,0.92)" : "rgba(244,241,234,0.92)";
            const lblW = b.name.length * 4.2 + 8;
            ctx.fillRect(bx + bw / 2 - lblW / 2, by + bh + 2, lblW, 9);
            ctx.fillStyle = isDarkTheme ? "#d8d2c6" : "#1b1915";
            ctx.fillText(b.name.replace("The ", ""), bx + bw / 2, by + bh + 9);
            ctx.globalAlpha = 1;
          }
          ctx.restore();
        },
      });
    }

    for (const a of this.byId.values()) {
      if (a.x < viewLeft || a.x > viewRight || a.y < viewTop || a.y > viewBottom) continue;
      // Level of detail on the residents. Below NPC_MIN_ZOOM a resident is
      // under 1.5 screen px, so the sprite cannot be seen — but the blit is the
      // most expensive thing the engine does per object: a fresh offscreen
      // canvas, a 52x58 ImageData and a 3,016-iteration pixel loop, per
      // resident, per frame. The followed resident is exempt, the same rule the
      // name tags use: it is the one figure the player is actually tracking, and
      // losing it in follow mode is worse than the cost.
      if (!lod.residents && a.id !== this.followId) continue;
      queue.push({
        y: a.y,
        draw: () => {
          // walkPhase is now maintained per-agent, not global t
          const walkPhase = a.walkPhase % 1;
          const shake = a.doing === "shake" ? Math.sin(this.t * 38 + hashId(a.id)) * Math.max(0.6, 2.2 * NPC_K) : 0;
          const idleBob = Math.sin(a.idlePhase * 0.9) * 0.6;
          const speedBob = a.path.length > 0 ? Math.abs(Math.sin(walkPhase * Math.PI * 2)) * 1.0 : 0;
          // Sprite cache: re-render the bitmap only when the quantized pose
          // changes (12 walk buckets x 15 time buckets/s x activity). Facing
          // is applied as a draw-time mirror below, so it is not part of the
          // key. Reuses one offscreen canvas + ImageData per agent — zero DOM
          // allocation on cache hits.
          const at = this.t + hashId(a.id) * 0.01;
          const key = a.doing + "|" + ((walkPhase * 12) | 0) + "|" + ((at * 15) | 0);
          let spr = a.sprite;
          if (!spr || spr.key !== key) {
            const genes = Hc(a.genes);
            const sk = sf({ t: at, walkPhase, doing: a.doing, facing: a.facing });
            const buf = renderLlama(genes, sk);
            let canvas = spr?.canvas;
            if (!canvas) {
              canvas = document.createElement("canvas");
              canvas.width = BUF_W;
              canvas.height = BUF_H;
            }
            const octx = canvas.getContext("2d")!;
            const img = spr?.img ?? octx.createImageData(BUF_W, BUF_H);
            const data = img.data;
            data.fill(0);
            for (let i = 0; i < buf.length; i++) {
              const v = buf[i]!;
              const pa = v & 0xff;
              if (pa === 0) continue;
              const o = i * 4;
              data[o] = (v >>> 24) & 0xff;
              data[o + 1] = (v >>> 16) & 0xff;
              data[o + 2] = (v >>> 8) & 0xff;
              data[o + 3] = pa;
            }
            octx.putImageData(img, 0, 0);
            spr = a.sprite = { key, canvas, img };
          }
          const off = spr.canvas;
          // NPC_H/NPC_GROUND_ROW → town-median-derived resident, still 1/3 car
          const scale = NPC_SCALE;
          const w = BUF_W * scale;
          const h = BUF_H * scale;

          ctx.save();
          // add bob + shake
          ctx.translate(a.x + shake, a.y + idleBob * 0.3 - speedBob * 0.4);
          // subtle squash/stretch when walking
          const stretch = a.path.length > 0 ? 1 + Math.sin(walkPhase * Math.PI * 2) * 0.035 : 1;
          const squash = a.path.length > 0 ? 1 - Math.sin(walkPhase * Math.PI * 2) * 0.02 : 1;
          ctx.scale(a.facing === -1 ? -stretch : stretch, squash);
          // -NPC_H puts buffer row NPC_GROUND_ROW (the hooves) on the anchor,
          // so the resident stands on its path point instead of floating
          ctx.drawImage(off, -w / 2, -NPC_H, w, h);
          ctx.restore();

          // shadow ellipse — same ground line as the hooves, same ratio to the
          // body as the old 63px sprite (radius = 8.4 buffer px)
          ctx.fillStyle = "rgba(0,0,0,0.13)";
          ctx.beginPath();
          ctx.ellipse(a.x, a.y + 1, 14 * scale * 0.6, 5 * scale * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();

          // 08 §10.2 — a coloured ring under every contestant, so the roster is
          // readable off the ground plane even when the name tags overlap
          const ringCol = this.contestColor(a.id);
          if (ringCol) {
            ctx.strokeStyle = ringCol;
            ctx.lineWidth = 1.4;
            ctx.globalAlpha = this.contest?.state === "live"
              ? 0.7 + 0.3 * Math.sin(this.t * 5 + hashId(a.id) * 0.01)
              : 0.9;
            ctx.beginPath();
            // framed to the resident, not to the map — it has to read as a ring
            // around an NPC_H-tall figure rather than a hoop three residents wide
            ctx.ellipse(a.x, a.y + NPC_H * 0.2, NPC_H * 0.6, NPC_H * 0.24, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          ctx.save();
          ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
          const sx = (a.x - cam.x) * cam.zoom + viewportW / 2;
          // name tag: bottom 5px above the crown, box sized to the figure —
          // a 14px box was taller than the resident once the sprite shrank
          const sy = (a.y - (NPC_H + 5) - cam.y) * cam.zoom + viewportH / 2 + idleBob * cam.zoom * 0.3;
          // Pulled back past a readable zoom. The tag is a fixed 8 screen px, so
          // it does NOT shrink with the world — at MIN_ZOOM (0.0547) it is 14x
          // the height of the resident it names, and 64 of them turned the
          // whole town into an unreadable stack of white boxes. The followed
          // resident keeps their tag at any zoom, because that is the one the
          // player is actually tracking; everyone else fades in as you come
          // closer.
          if (cam.zoom < TAG_MIN_ZOOM && a.id !== this.followId) {
            ctx.restore();
            return;
          }
          ctx.font = "8px JetBrains Mono";
          ctx.textAlign = "center";
          const labelBgW = a.name.length * 4.8 + 7;
          ctx.fillStyle = "rgba(244,241,234,0.92)";
          ctx.fillRect(sx - labelBgW / 2, sy - 11, labelBgW, 11);
          ctx.strokeStyle = "#1b1915";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(sx - labelBgW / 2, sy - 11, labelBgW, 11);
          ctx.fillStyle = this.tagColor(a.id);
          ctx.fillText(a.name, sx, sy - 3);
          ctx.restore();
        },
      });
    }

    queue.sort((a, b) => a.y - b.y);
    for (const q of queue) q.draw();

    // 08 §10.2 — diegetic announcement: the venue lights up so the town knows
    // where to look before any overlay appears
    if (this.contest) this.drawVenueGlow(ctx);

    for (const p of this.puffs) {
      ctx.beginPath();
      // 4/3px were sized for a 63px figure — on a 10px one a 4px ball would be
      // bigger than its head, so keep them small but still on-screen
      ctx.arc(p.x, p.y, p.kind === "spit" ? 1.4 : 1, 0, Math.PI * 2);
      ctx.fillStyle = p.kind === "spit" ? "#cfe8f2" : "rgba(200,180,150,0.7)";
      ctx.fill();
      ctx.strokeStyle = "rgba(27,25,21,0.15)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    // a bubble is drawn in world px, so it shrinks with the camera and at
    // NPC_MIN_ZOOM it is a 6px smudge with unreadable text — and the resident it
    // belongs to is no longer drawn either. Same floor as the sprite.
    const sortedBubbles = lod.residents ? [...this.bubbles].sort((a, b) => {
      if (a.by === this.followId) return -1;
      if (b.by === this.followId) return 1;
      return b.until - a.until;
    }) : [];
    for (const bub of sortedBubbles.slice(0, 3)) {
      const ag = this.byId.get(bub.by);
      if (!ag) continue;
      const sx = ag.x;
      // box bottom + its 8px tail: the tip lands on the crown (a.y - NPC_H)
      const sy = ag.y - NPC_H - 8 - Math.sin(ag.idlePhase * 0.8) * 1.2;
      const pad = 6;
      ctx.font = "11px Instrument Serif";
      const metrics = ctx.measureText(bub.text);
      const bw = Math.min(220, metrics.width + pad * 2 + 10);
      const lines = wrapText(ctx, bub.text, bw - pad * 2);
      const bh = lines.length * 14 + pad * 2 + 6;
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#1b1915";
      ctx.lineWidth = 1.2;
      const bx = sx - bw / 2;
      const by = sy - bh;
      roundRect(ctx, bx, by, bw, bh, 8);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx - 6, by + bh);
      ctx.lineTo(sx, by + bh + 8);
      ctx.lineTo(sx + 6, by + bh);
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#1b1915";
      ctx.textAlign = "left";
      lines.forEach((line, i) => ctx.fillText(line, bx + pad, by + pad + 12 + i * 14));
    }

    ctx.restore();

    if (this.clock > 0.42 && this.clock < 0.72) {
      const alpha = (this.clock - 0.42) * 0.9;
      ctx.fillStyle = `rgba(255, 170, 90, ${Math.min(0.26, alpha)})`;
      ctx.fillRect(0, 0, viewportW, viewportH);
    }
    const night = this.nightIntensity();
    if (night > 0.01) {
      ctx.fillStyle = `rgba(22, 28, 60, ${night * 0.5})`;
      ctx.fillRect(0, 0, viewportW, viewportH);
      // The lamp pools are the most expensive thing in the frame: each one is a
      // fresh radial gradient plus an arc fill, and at the whole-town zoom all
      // 2,400 of them are in view — 2,404 gradient objects a frame (738 of them
      // are vehicle headlights). Below GLOW_MIN_ZOOM a pool is a 1.9px dot, so
      // the whole per-lamp pass goes and the night reads as unlit streets, which
      // is what 2,400 sub-pixel dots add up to anyway.
      if (lod.glows) {
        ctx.globalCompositeOperation = "lighter";
        const spots: Array<[number, number]> = [
          [104, 62], [120, 66], [110, 84], [72, 50],
        ];
        for (const [tx, ty] of spots) {
          const sx = (tx * V - cam.x) * cam.zoom + viewportW / 2;
          const sy = (ty * V - cam.y) * cam.zoom + viewportH / 2;
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, 44 * cam.zoom);
          grad.addColorStop(0, `rgba(255, 220, 120, ${0.38 * night})`);
          grad.addColorStop(1, "rgba(255, 220, 120, 0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, 44 * cam.zoom, 0, Math.PI * 2);
          ctx.fill();
        }
        // street lamps
        for (const g of LAMP_GLOWS) {
          if (g.x < viewLeft || g.x > viewRight || g.y < viewTop || g.y > viewBottom) continue;
          const sx = (g.x - cam.x) * cam.zoom + viewportW / 2;
          const sy = (g.y - cam.y) * cam.zoom + viewportH / 2;
          const r = 34 * cam.zoom;
          const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
          grad.addColorStop(0, `rgba(255, 224, 140, ${0.42 * night})`);
          grad.addColorStop(1, "rgba(255, 224, 140, 0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(sx, sy, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = "source-over";
      }
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const test = cur ? cur + " " + w : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}
