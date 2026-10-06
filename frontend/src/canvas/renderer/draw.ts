import type { Genes } from "@hermesbook/shared";
import { BUF_W, BUF_H, rgba } from "./pixelBuffer.js";
import type { Skeleton } from "./skeleton.js";

function h2rgb(h: number, s = 0.58, l = 0.68): [number, number, number] {
  // richer than before (0.52/0.78 pastel) — more editorial, less AI-wash
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function fillRect(buf: Uint32Array, x: number, y: number, w: number, h: number, col: number): void {
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= BUF_H) continue;
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= BUF_W) continue;
      buf[yy * BUF_W + xx] = col;
    }
  }
}
function setPixel(buf: Uint32Array, x: number, y: number, col: number): void {
  if (x < 0 || x >= BUF_W || y < 0 || y >= BUF_H) return;
  buf[y * BUF_W + x] = col;
}

export function renderLlama(genes: Genes, sk: Skeleton): Uint32Array {
  const buf = new Uint32Array(BUF_W * BUF_H);
  // editorial palette: no pure neon, desaturated but not beige
  const [r, g, b] = h2rgb(genes.hue % 360);
  // wool base + two shades for depth
  const wool = rgba(r, g, b, 255);
  const woolDeep = rgba(Math.max(0, r - 26), Math.max(0, g - 26), Math.max(0, b - 26), 255);
  const woolLight = rgba(Math.min(255, r + 18), Math.min(255, g + 18), Math.min(255, b + 18), 255);
  const outline = rgba(22, 20, 18, 255);
  const outlineSoft = rgba(22, 20, 18, 110);
  const eyeWhite = rgba(250, 248, 242, 255);
  const eyePupil = rgba(18, 18, 20, 255);
  const nose = rgba(28, 22, 20, 255);
  const pinkInner = rgba(225, 165, 165, 255);

  // build/neck drive silhouette
  const bw = Math.round(19 + genes.build * 9); // 19..28
  const bh = Math.round(13 + genes.build * 7);
  const bx = Math.round(13 - bw / 2 + 8);
  const by = Math.round(23 + sk.bodyY);

  // soft ground contact shadow (not pure black)
  fillRect(buf, bx - 1, 46, bw + 2, 2, rgba(0, 0, 0, 38));
  fillRect(buf, bx + 1, 47, bw - 2, 1, rgba(0, 0, 0, 18));

  // body with subtle highlight top edge
  fillRect(buf, bx, by, bw, bh, wool);
  fillRect(buf, bx, by, bw, 1, woolLight);
  fillRect(buf, bx, by + bh - 1, bw, 1, woolDeep);
  // side shading
  fillRect(buf, bx + bw - 2, by + 2, 2, bh - 3, woolDeep);
  // outline — 1px crisp, not 2px heavy
  fillRect(buf, bx, by + bh, bw, 1, outlineSoft);
  fillRect(buf, bx - 1, by + 2, 1, bh - 2, outlineSoft);

  // legs — 4 with joint
  for (let i = 0; i < 4; i++) {
    const [lx, ly] = sk.legs[i]!;
    const lx2 = Math.round(lx + (bx - 15));
    const ly2 = Math.round(ly);
    // thigh
    fillRect(buf, lx2, ly2 - 9, 3, 6, wool);
    fillRect(buf, lx2, ly2 - 9, 3, 1, woolLight);
    // shin
    fillRect(buf, lx2, ly2 - 3, 3, 4, woolDeep);
    // hoof
    fillRect(buf, lx2 - 0.5, ly2 + 1, 4, 1, outline);
    fillRect(buf, lx2, ly2, 3, 1, rgba(45, 38, 32, 255));
  }

  // neck — slight curve, not straight rect
  const neckH = Math.round(11 + genes.neck * 10);
  const nx = bx + Math.round(bw / 2) - 3 + Math.round(sk.neckLean * 7);
  const ny = by - neckH + Math.round(sk.neckCurve * 3);
  // neck with front highlight
  fillRect(buf, nx, ny, 6, neckH, wool);
  fillRect(buf, nx, ny, 1, neckH, woolLight);
  fillRect(buf, nx + 5, ny, 1, neckH, woolDeep);

  // chest tuft
  fillRect(buf, nx + 2, ny + neckH - 5, 2, 2, woolLight);

  // head — slightly larger, editorial proportions
  const hx = nx - 2;
  const hy = ny - 8 + Math.round(sk.headTilt * 5);
  const hw = 12, hh = 10;
  fillRect(buf, hx, hy, hw, hh, wool);
  // head top highlight
  fillRect(buf, hx + 1, hy, hw - 2, 1, woolLight);
  // chin shadow
  fillRect(buf, hx + 2, hy + hh - 1, hw - 4, 1, woolDeep);
  fillRect(buf, hx, hy + 2, 1, hh - 4, woolDeep);
  fillRect(buf, hx + hw - 1, hy + 2, 1, hh - 4, outlineSoft);

  // snout — distinct block, not just mouth line
  fillRect(buf, hx + 3, hy + 6, 6, 4, woolLight);
  fillRect(buf, hx + 4, hy + 7, 4, 2, rgba(242, 236, 224, 255));
  // nostrils
  setPixel(buf, hx + 5, hy + 8, nose);
  setPixel(buf, hx + 7, hy + 8, nose);

  // ears — perched, not flat
  const earY = hy - 3;
  const earLx = hx + 1 + Math.round(sk.earL * 3);
  const earRx = hx + 8 + Math.round(sk.earR * 3);
  fillRect(buf, earLx, earY, 3, 4, woolDeep);
  fillRect(buf, earLx + 1, earY + 1, 1, 2, pinkInner);
  fillRect(buf, earRx, earY, 3, 4, woolDeep);
  fillRect(buf, earRx + 1, earY + 1, 1, 2, pinkInner);
  if (genes.ears === "droop") {
    fillRect(buf, earLx, earY + 3, 3, 2, woolDeep);
    fillRect(buf, earRx, earY + 3, 3, 2, woolDeep);
  } else if (genes.ears === "perky") {
    fillRect(buf, earLx + 1, earY - 1, 1, 1, woolDeep);
    fillRect(buf, earRx + 1, earY - 1, 1, 1, woolDeep);
  }

  // eyes — more editorial: lid, catchlight
  const eyeY = hy + 3;
  const eyeOpen = sk.lid < 0.5;
  if (eyeOpen) {
    // sclera with subtle shadow
    fillRect(buf, hx + 2, eyeY, 3, 2, eyeWhite);
    fillRect(buf, hx + 2, eyeY + 2, 3, 1, rgba(235, 232, 224, 255));
    fillRect(buf, hx + 7, eyeY, 3, 2, eyeWhite);
    fillRect(buf, hx + 7, eyeY + 2, 3, 1, rgba(235, 232, 224, 255));
    // pupil
    fillRect(buf, hx + 3, eyeY + 1, 1, 1, eyePupil);
    fillRect(buf, hx + 8, eyeY + 1, 1, 1, eyePupil);
    // catchlight
    setPixel(buf, hx + 3, eyeY, rgba(255, 255, 255, 255));
    setPixel(buf, hx + 8, eyeY, rgba(255, 255, 255, 255));
    // iris tint from hue (subtle)
    setPixel(buf, hx + 3, eyeY + 1, rgba((r + 40) % 255, (g + 40) % 255, (b + 40) % 255, 255));
    setPixel(buf, hx + 8, eyeY + 1, rgba((r + 40) % 255, (g + 40) % 255, (b + 40) % 255, 255));
    setPixel(buf, hx + 3, eyeY + 1, eyePupil); // repunch pupil

    if (genes.eyes === "squint") {
      fillRect(buf, hx + 2, eyeY, 3, 1, wool);
      fillRect(buf, hx + 7, eyeY, 3, 1, wool);
    } else if (genes.eyes === "wide") {
      fillRect(buf, hx + 2, eyeY + 2, 3, 1, eyeWhite);
      fillRect(buf, hx + 7, eyeY + 2, 3, 1, eyeWhite);
    } else if (genes.eyes === "dot") {
      // smaller pupil already
    }
  } else {
    fillRect(buf, hx + 2, eyeY + 1, 3, 1, outline);
    fillRect(buf, hx + 7, eyeY + 1, 3, 1, outline);
    // soft closed lid
    fillRect(buf, hx + 2, eyeY, 3, 1, woolDeep);
    fillRect(buf, hx + 7, eyeY, 3, 1, woolDeep);
  }

  // mouth — subtle, not pink block
  const mouthY = hy + 8 + Math.round(sk.jaw * 1.2);
  fillRect(buf, hx + 4, mouthY, 4, 1, mouthY > hy + 8 ? rgba(90, 50, 50, 255) : nose);
  if (sk.jaw > 0.32) {
    fillRect(buf, hx + 5, mouthY + 1, 2, 1, rgba(110, 60, 60, 255));
  }

  // fleece pattern — not flat, add two speckles
  setPixel(buf, bx + 4, by + 3, woolDeep);
  setPixel(buf, bx + bw - 5, by + 5, woolDeep);
  setPixel(buf, bx + 7, by + 8, woolLight);

  // cut — more editorial
  if (genes.cut === "mohawk") {
    fillRect(buf, hx + 5, hy - 3, 2, 3, outline);
    fillRect(buf, hx + 5, hy - 3, 2, 1, woolLight);
  } else if (genes.cut === "bowl") {
    fillRect(buf, hx - 1, hy - 1, hw + 2, 2, woolDeep);
    fillRect(buf, hx, hy - 1, hw, 1, woolLight);
  } else if (genes.cut === "curly") {
    fillRect(buf, hx + 1, hy - 2, 10, 2, woolDeep);
    fillRect(buf, hx + 3, hy - 3, 6, 1, wool);
    setPixel(buf, hx + 4, hy - 2, woolLight);
    setPixel(buf, hx + 7, hy - 2, woolLight);
  } else if (genes.cut === "afro") {
    fillRect(buf, hx - 2, hy - 4, hw + 4, 4, woolDeep);
    fillRect(buf, hx - 1, hy - 4, hw + 2, 1, woolLight);
  } else if (genes.cut === "straight") {
    fillRect(buf, hx + 2, hy - 1, 8, 1, woolDeep);
  }

  // Hermes-accurate accessories — petasos, caduceus, himation, olive, argos
  if (genes.extra === "hat") {
    // petasos — winged hat, not red block
    fillRect(buf, hx - 2, hy - 5, hw + 4, 2, rgba(45, 38, 32, 255)); // brim
    fillRect(buf, hx, hy - 7, hw - 2, 3, rgba(45, 38, 32, 255)); // crown
    // wings
    fillRect(buf, hx - 3, hy - 6, 2, 1, rgba(220, 220, 215, 255));
    fillRect(buf, hx + hw + 1, hy - 6, 2, 1, rgba(220, 220, 215, 255));
    setPixel(buf, hx - 4, hy - 6, rgba(200, 210, 210, 255));
    setPixel(buf, hx + hw + 2, hy - 6, rgba(200, 210, 210, 255));
  } else if (genes.extra === "bell") {
    // caduceus — staff vertical + snakes
    fillRect(buf, nx + 6, ny - 2, 1, neckH + 6, rgba(90, 78, 42, 255));
    fillRect(buf, nx + 5, ny - 3, 3, 1, rgba(220, 190, 60, 255)); // top
    // snakes
    setPixel(buf, nx + 5, ny + 2, rgba(120, 180, 160, 255));
    setPixel(buf, nx + 7, ny + 4, rgba(120, 180, 160, 255));
  } else if (genes.extra === "glasses") {
    // argos-eyes — thin round, not thick block
    fillRect(buf, hx + 1, eyeY - 1, 4, 3, rgba(25, 25, 28, 85));
    fillRect(buf, hx + 6, eyeY - 1, 4, 3, rgba(25, 25, 28, 85));
    // bridge
    setPixel(buf, hx + 5, eyeY, rgba(25, 25, 28, 85));
    // lens highlight
    setPixel(buf, hx + 2, eyeY, rgba(255, 255, 255, 120));
    setPixel(buf, hx + 7, eyeY, rgba(255, 255, 255, 120));
  } else if (genes.extra === "scarf") {
    // himation — draped, not flat red
    fillRect(buf, nx - 1, ny + 3, 8, 4, rgba(170, 60, 45, 255));
    fillRect(buf, nx - 1, ny + 3, 8, 1, rgba(190, 80, 65, 255)); // fold highlight
    fillRect(buf, nx + 7, ny + 5, 1, 2, rgba(140, 40, 30, 255)); // shadow
  } else if (genes.extra === "flower") {
    // olive wreath — not pink blob
    fillRect(buf, hx + 8, hy - 3, 3, 1, rgba(85, 110, 55, 255));
    fillRect(buf, hx + 7, hy - 2, 2, 1, rgba(120, 140, 70, 255));
    fillRect(buf, hx + 10, hy - 2, 2, 1, rgba(120, 140, 70, 255));
    setPixel(buf, hx + 9, hy - 3, rgba(85, 110, 55, 255));
  }

  // winged sandals puff at feet when exploring — subtle
  // tail — softer wag, not block
  const tailX = bx - 2 + Math.round(sk.tail * 1.6);
  fillRect(buf, tailX, by + 5, 2, 2, woolDeep);
  setPixel(buf, tailX + 1, by + 4, woolLight);

  return buf;
}
