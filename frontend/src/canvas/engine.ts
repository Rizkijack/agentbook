import { V, WorldWidth, WorldHeight } from "./constants.js";
import { LOCATIONS } from "./locationsData.js";
import { pf } from "./pf.js";
import { DAY_LENGTH_SEC, Hc } from "@hermesbook/shared";
import { renderLlama } from "./renderer/draw.js";
import { sf } from "./renderer/skeleton.js";
import { BUF_W, BUF_H } from "./renderer/pixelBuffer.js";
import { drawTerrainDecor, pushScenery, tickScenery, LAMP_GLOWS, type View, type SceneDraw } from "./scenery.js";

export const MIN_ZOOM = 0.45;
export const MAX_ZOOM = 2.8;
/** Where the camera starts, and where "Reset" returns to. */
const CAM_HOME_X = 1600;
const CAM_HOME_Y = 900;

/** 08 §10.2 — name-tag / ring colour by finishing rank: 1st, 2nd, 3rd. */
export const RANK_COLORS = ["#c9a86a", "#b9c0c4", "#b87333"] as const;
/** Entrants before a result exists — everyone competing gets the same mark. */
export const ENTRANT_COLOR = "#7a5cc4";

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
  /** current Hermes Trials contest, or null on a quiet day (08 §10.1) */
  contest: ContestMark | null = null;
  private t = 0;

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

  setFollow(id: string | null) {
    this.followId = id;
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
    this.followId = null;
    this.clampCam();
  }

  /**
   * Zoom by `factor` anchored on a canvas-relative screen point: the world
   * point under that point stays put (unless clampCam pulls it back inside the
   * map). Applied instantly so the anchor cannot drift between zoom targets.
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
    this.followId = null;
    this.clampCam();
  }

  /**
   * Keep the viewport over the town instead of letting it drift into empty
   * space. When the view is wider than the world (zoomed out past the map) the
   * camera is pinned to the world centre.
   */
  clampCam(): void {
    const cam = this.cam;
    const z = cam.zoom || 1;
    const halfW = this.viewW / (2 * z);
    const halfH = this.viewH / (2 * z);
    const cx = this.worldW / 2;
    const cy = this.worldH / 2;
    const loX = Math.min(cx, halfW);
    const hiX = Math.max(cx, this.worldW - halfW);
    const loY = Math.min(cy, halfH);
    const hiY = Math.max(cy, this.worldH - halfH);
    cam.tx = Math.max(loX, Math.min(hiX, cam.tx));
    cam.ty = Math.max(loY, Math.min(hiY, cam.ty));
    cam.x = Math.max(loX, Math.min(hiX, cam.x));
    cam.y = Math.max(loY, Math.min(hiY, cam.y));
  }

  /** Back to the town overview, follow dropped. */
  resetCam(): void {
    this.followId = null;
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
    this.cam.x += (this.cam.tx - this.cam.x) * 0.08;
    this.cam.y += (this.cam.ty - this.cam.y) * 0.08;
    this.cam.zoom += (this.cam.tz - this.cam.zoom) * 0.08;

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

      if (a.path.length > 0) {
        const next = a.path[0]!;
        // add organic wobble to target tile center
        const wobbleX = Math.sin(this.t * 0.9 + hashId(a.id) * 0.01) * 1.8;
        const wobbleY = Math.cos(this.t * 1.1 + hashId(a.id) * 0.013) * 1.2;
        const tx = next.x * V + V / 2 + wobbleX;
        const ty = next.y * V + V / 2 + wobbleY;
        const dx = tx - a.x;
        const dy = ty - a.y;
        const dist = Math.hypot(dx, dy);
        // arrival slowdown
        const slowFactor = dist < 18 ? dist / 18 : 1;
        const jitter = 0.88 + Math.random() * 0.24; // per-frame speed variation
        const speed = targetSpeedBase * slowFactor * jitter * dt;

        if (dist < Math.max(2, speed)) {
          a.x = tx;
          a.y = ty;
          a.path.shift();
          // occasional dust puff when stepping
          if (Math.random() < 0.18 && targetSpeedBase > 20) {
            this.puffs.push({ x: a.x, y: a.y + 8, vx: (Math.random() - 0.5) * 18, vy: -8 - Math.random() * 12, life: 0.42, kind: "dust" });
          }
        } else {
          // acceleration smoothing
          const targetVx = (dx / dist) * targetSpeedBase;
          const targetVy = (dy / dist) * targetSpeedBase;
          a.vx += (targetVx - a.vx) * 0.22;
          a.vy += (targetVy - a.vy) * 0.22;
          // add slight perpendicular sway for organic
          const sway = Math.sin(this.t * 2.4 + hashId(a.id) * 0.02) * 0.45;
          const perpX = - (dy / dist) * sway;
          const perpY = (dx / dist) * sway;
          a.x += (a.vx * dt * 0.06 + perpX * dt);
          a.y += (a.vy * dt * 0.06 + perpY * dt);
          // smooth facing, hysteresis 4px
          if (Math.abs(dx) > 3) a.facing = dx > 0 ? 1 : -1;
          // walk phase advances by distance
          const step = Math.hypot(a.vx, a.vy) * dt * 0.04;
          a.walkPhase = (a.walkPhase + step) % 1;
          // slight idle phase for breathing while moving
          a.idlePhase += dt * 0.6;
        }
      } else {
        // no path — autonomous idle wander if not sleeping
        if (!isSleeping) {
          a.wanderTimer -= dt;
          // separation: push away from nearby agents if too close
          for (const other of this.byId.values()) {
            if (other.id === a.id) continue;
            const dx = a.x - other.x;
            const dy = a.y - other.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < 22 * 22 && d2 > 0.1) {
              const push = 18 * dt / Math.max(1, Math.sqrt(d2));
              a.x += dx * push * 0.08;
              a.y += dy * push * 0.08;
              a.vx += dx * push * 0.02;
            }
          }

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
            nx = Math.max(2, Math.min(207, nx));
            ny = Math.max(2, Math.min(125, ny));
            const sx = Math.floor(a.x / V);
            const sy = Math.floor(a.y / V);
            if (nx !== sx || ny !== sy) {
              const mapLike = {
                at(_x: number, _y: number) { return 0; },
                solid(x: number, y: number) { return x < 0 || y < 0 || x >= 210 || y >= 128; },
              };
              const path = pf(mapLike, sx, sy, nx, ny);
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
            // idle micro-movement: breathing sway + occasional step-in-place
            a.idlePhase += dt * (0.7 + a.baseSpeed * 0.3);
            const breathX = Math.sin(a.idlePhase * 0.9) * 0.35;
            const breathY = Math.cos(a.idlePhase * 0.7) * 0.22;
            a.x += breathX * dt * 0.5;
            a.y += breathY * dt * 0.5;
            // walkPhase still ticks slowly when idle (fidget)
            a.walkPhase = (a.walkPhase + dt * 0.08) % 1;
            if (Math.random() < 0.006) {
              // tiny fidget step
              a.x += (Math.random() - 0.5) * 4;
              a.y += (Math.random() - 0.5) * 3;
              a.walkPhase += 0.08;
            }
          }
        } else {
          // sleeping: just breathing
          a.idlePhase += dt * 0.5;
          a.x += Math.sin(a.idlePhase) * 0.04;
        }
      }

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
        this.followId = null; // followed agent left the herd — stop chasing
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
      const mapLike = {
        at(_x: number, _y: number) { return 0; },
        solid(x: number, y: number) { return x < 0 || y < 0 || x >= 210 || y >= 128; },
      };
      const path = pf(mapLike, sx, sy, tx, ty);
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
      this.puffs.push({ x: attacker.x + attacker.facing * 22, y: attacker.y - 26, vx: attacker.facing * 140, vy: -30, life: 0.8, kind: "spit" });
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
    ctx.save();
    ctx.clearRect(0, 0, viewportW, viewportH);
    ctx.translate(viewportW / 2, viewportH / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    const isDarkTheme = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark";
    const fieldCol = typeof document !== "undefined" ? (getComputedStyle(document.documentElement).getPropertyValue("--field").trim() || (isDarkTheme ? "#1e2e22" : "#cfe8c0")) : "#cfe8c0";
    const hillCol = typeof document !== "undefined" ? (getComputedStyle(document.documentElement).getPropertyValue("--field-hill").trim() || (isDarkTheme ? "#243628" : "#b8d8a8")) : "#b8d8a8";
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
    const sceneView: View = { l: viewLeft0, r: viewRight0, t: viewTop0, b: viewBottom0 };
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
    pushScenery(queue, ctx, sceneView, sceneDraw);

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
            // label
            ctx.fillStyle = isDarkTheme ? "#a49c90" : "#1b1915";
            ctx.font = "7px JetBrains Mono";
            ctx.textAlign = "center";
            ctx.globalAlpha = 0.85;
            ctx.fillText(b.name.replace("The ", ""), bx + bw / 2, by + bh + 10);
            ctx.globalAlpha = 1;
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
          // per-category palette
          let wall = isDarkTheme ? "#2a2622" : "#e8ddd0";
          let roof = isDarkTheme ? "#6b4a35" : "#8b5a3c";
          let trim = isDarkTheme ? "#3a3530" : "#1b1915";
          let wood = isDarkTheme ? "#3d2f1e" : "#c9a86a";
          if (b.category === "Social") {
            // tavern/baths/square/fire/dock — warm wood + open porch
            wall = isDarkTheme ? "#2e2418" : "#efe6d5";
            roof = isDarkTheme ? "#7a4a2e" : "#a66a3a";
            trim = isDarkTheme ? "#4a3a28" : "#5a3a1e";
          } else if (b.category === "Civic") {
            // hall/vault/station/board/booth — stone formal, columns
            wall = isDarkTheme ? "#2c2e30" : "#e6e2dd";
            roof = isDarkTheme ? "#4a4a4e" : "#6b6a6e";
            trim = isDarkTheme ? "#3a3a3e" : "#2b2a2e";
          } else if (b.category === "Work") {
            // market/press/bank/library/clinic/school/post/shed/mill — brick/industrial
            wall = isDarkTheme ? "#2f2520" : "#e8d5c0";
            roof = isDarkTheme ? "#5a3a28" : "#9a6a3a";
            trim = isDarkTheme ? "#4a3a2e" : "#3d2a18";
          } else if (b.category === "Rest") {
            // barn/pens — barn red + gambrel
            wall = isDarkTheme ? "#3a1e1a" : "#b54a3a";
            roof = isDarkTheme ? "#4a2a24" : "#7a2e22";
            trim = isDarkTheme ? "#5a3028" : "#4a1e14";
            wood = isDarkTheme ? "#4a3a2a" : "#d8c9a8";
          }
          if (isDark && !isDarkTheme) wall = isDarkTheme ? wall : "#5a4a3a";
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
          // label
          ctx.fillStyle = isDarkTheme ? "#a49c90" : "#1b1915";
          ctx.font = "7px JetBrains Mono";
          ctx.textAlign = "center";
          ctx.globalAlpha = 0.9;
          // strip behind label
          ctx.fillStyle = isDarkTheme ? "rgba(28,26,24,0.92)" : "rgba(244,241,234,0.92)";
          const lblW = b.name.length * 4.2 + 8;
          ctx.fillRect(bx + bw / 2 - lblW / 2, by + bh + 2, lblW, 9);
          ctx.fillStyle = isDarkTheme ? "#d8d2c6" : "#1b1915";
          ctx.fillText(b.name.replace("The ", ""), bx + bw / 2, by + bh + 9);
          ctx.globalAlpha = 1;
          ctx.restore();
        },
      });
    }

    for (const a of this.byId.values()) {
      if (a.x < viewLeft || a.x > viewRight || a.y < viewTop || a.y > viewBottom) continue;
      queue.push({
        y: a.y,
        draw: () => {
          const genes = Hc(a.genes);
          // walkPhase is now maintained per-agent, not global t
          const walkPhase = a.walkPhase % 1;
          const sk = sf({ t: this.t + hashId(a.id) * 0.01, walkPhase, doing: a.doing, facing: a.facing });
          const shake = a.doing === "shake" ? Math.sin(this.t * 38 + hashId(a.id)) * 2.2 : 0;
          const idleBob = Math.sin(a.idlePhase * 0.9) * 0.6;
          const speedBob = a.path.length > 0 ? Math.abs(Math.sin(walkPhase * Math.PI * 2)) * 1.0 : 0;
          const buf = renderLlama(genes, sk);
          const scale = 1.4;
          const w = BUF_W * scale;
          const h = BUF_H * scale;
          const off = document.createElement("canvas");
          off.width = BUF_W;
          off.height = BUF_H;
          const octx = off.getContext("2d")!;
          const img = octx.createImageData(BUF_W, BUF_H);
          for (let i = 0; i < buf.length; i++) {
            const v = buf[i]!;
            const a8 = v & 0xff;
            if (a8 === 0) continue;
            img.data[i * 4 + 0] = (v >>> 24) & 0xff;
            img.data[i * 4 + 1] = (v >>> 16) & 0xff;
            img.data[i * 4 + 2] = (v >>> 8) & 0xff;
            img.data[i * 4 + 3] = a8;
          }
          octx.putImageData(img, 0, 0);

          ctx.save();
          // add bob + shake
          ctx.translate(a.x + shake, a.y + idleBob * 0.3 - speedBob * 0.4);
          // subtle squash/stretch when walking
          const stretch = a.path.length > 0 ? 1 + Math.sin(walkPhase * Math.PI * 2) * 0.035 : 1;
          const squash = a.path.length > 0 ? 1 - Math.sin(walkPhase * Math.PI * 2) * 0.02 : 1;
          ctx.scale(a.facing === -1 ? -stretch : stretch, squash);
          ctx.drawImage(off, -w / 2, -h + 12, w, h);
          ctx.restore();

          // shadow ellipse
          ctx.fillStyle = "rgba(0,0,0,0.13)";
          ctx.beginPath();
          ctx.ellipse(a.x, a.y + 6, 14 * scale * 0.6, 5 * scale * 0.5, 0, 0, Math.PI * 2);
          ctx.fill();

          // 08 §10.2 — a coloured ring under every contestant, so the roster is
          // readable off the ground plane even when the name tags overlap
          const ringCol = this.contestColor(a.id);
          if (ringCol) {
            ctx.strokeStyle = ringCol;
            ctx.lineWidth = 2.2;
            ctx.globalAlpha = this.contest?.state === "live"
              ? 0.7 + 0.3 * Math.sin(this.t * 5 + hashId(a.id) * 0.01)
              : 0.9;
            ctx.beginPath();
            ctx.ellipse(a.x, a.y + 7, 17, 6.5, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          ctx.save();
          ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
          const sx = (a.x - cam.x) * cam.zoom + viewportW / 2;
          const sy = (a.y - 56 * scale - cam.y) * cam.zoom + viewportH / 2 + idleBob * cam.zoom * 0.3;
          ctx.font = "10px JetBrains Mono";
          ctx.textAlign = "center";
          const labelBgW = a.name.length * 6 + 8;
          ctx.fillStyle = "rgba(244,241,234,0.92)";
          ctx.fillRect(sx - labelBgW / 2, sy - 14, labelBgW, 14);
          ctx.strokeStyle = "#1b1915";
          ctx.lineWidth = 0.5;
          ctx.strokeRect(sx - labelBgW / 2, sy - 14, labelBgW, 14);
          ctx.fillStyle = this.tagColor(a.id);
          ctx.fillText(a.name, sx, sy - 4);
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
      ctx.arc(p.x, p.y, p.kind === "spit" ? 4 : 3, 0, Math.PI * 2);
      ctx.fillStyle = p.kind === "spit" ? "#cfe8f2" : "rgba(200,180,150,0.7)";
      ctx.fill();
      ctx.strokeStyle = "rgba(27,25,21,0.15)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    const sortedBubbles = [...this.bubbles].sort((a, b) => {
      if (a.by === this.followId) return -1;
      if (b.by === this.followId) return 1;
      return b.until - a.until;
    });
    for (const bub of sortedBubbles.slice(0, 3)) {
      const ag = this.byId.get(bub.by);
      if (!ag) continue;
      const sx = ag.x;
      const sy = ag.y - 62 - Math.sin(ag.idlePhase * 0.8) * 1.2;
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
