import { useState } from "react";

/**
 * Resident avatar - deterministic, offline, no image assets.
 *
 * Two independent seeds so two residents never look alike by accident:
 *   • hue    — field 5 of the dot-separated `genes` string, the same index
 *              shared/src/genetics.ts `Hc()` reads into `Genes.hue` and the
 *              llama renderer paints. A llama on the canvas and its avatar in
 *              chat therefore share a colour.
 *   • dots   — a 3×3 identicon pattern seeded from a 32-bit FNV-1a hash of the
 *              resident id, so residents whose genes are identical or unknown
 *              still separate visually.
 *
 * Everything here is pure and SSR-safe (no canvas, no `window`, no
 * Math.random at module scope), so the helpers are exported for tests and the
 * component renders under jsdom. Malformed `genes` degrade to the id hash
 * instead of throwing — a post must never crash the chat rail.
 */

/** The minimum a resident needs to be drawn. Older snapshots may lack `genes`. */
export interface AvatarResident {
  id: string;
  name?: string;
  genes?: string;
  /**
   * Absolute http(s) URL of a picture the resident chose. Absent means the
   * generated badge, which is the default and not a fallback — there is nowhere to
   * upload one, and generating it means no request ever leaves the page.
   */
  avatar?: string;
}

/** One filled square of the identicon grid, 0-based row/column. */
export interface AvatarCell {
  row: number;
  col: number;
}

/** Grid edge count. Odd on purpose: the centre column mirrors onto itself. */
export const AVATAR_GRID = 3;

/** Field index of `hue` in the dot-separated genes string (genetics.ts `Hc`). */
export const AVATAR_HUE_INDEX = 5;

/** FNV-1a 32-bit — stable across runs, platforms and JS engines. */
export function avatarHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Base hue in [0,360) for a resident. Reads `genes[5]` when it is a finite
 * number; anything else (absent, non-string, truncated, NaN) falls back to a
 * hash of the id so the avatar still has a stable colour. Never throws.
 */
export function avatarHue(resident: AvatarResident | null | undefined): number {
  const genes = typeof resident?.genes === "string" ? resident.genes : "";
  const raw = genes.split(".")[AVATAR_HUE_INDEX];
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed)) return (((Math.round(parsed) % 360) + 360) % 360);
  return avatarHash(String(resident?.id ?? "")) % 360;
}

/**
 * Identicon cells for a resident id: six bits of the hash fill the left two
 * columns, mirrored into the right one, so the face reads symmetrically.
 * Never empty (a blank face is worse than a repetitive one) and never throws.
 */
export function avatarCells(id: string): AvatarCell[] {
  const h = avatarHash(String(id ?? ""));
  const cells: AvatarCell[] = [];
  for (let row = 0; row < AVATAR_GRID; row++) {
    for (let col = 0; col < 2; col++) {
      // bit clear = dot filled; keeps the pattern at ~50% coverage
      if (((h >>> (row * 2 + col)) & 1) === 1) continue;
      cells.push({ row, col });
      const mirror = AVATAR_GRID - 1 - col;
      if (mirror !== col) cells.push({ row, col: mirror });
    }
  }
  if (cells.length === 0) cells.push({ row: 1, col: 1 });
  return cells;
}

/** Up to two initials — "Iris" → I, "Ada Lovelace" → AL. */
export function avatarInitials(name?: string): string {
  const parts = String(name ?? "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const letters = parts.slice(0, 2).map((w) => w[0] ?? "").join("");
  return letters.toUpperCase();
}

/**
 * Mid-tone fill so the white initials stay legible on both themes; it is
 * closer to the canvas wool palette (`h2rgb` at s 0.58 / l 0.68) than a pale
 * tint would be.
 */
export function avatarFill(hue: number): string {
  return `hsl(${hue}, 44%, 52%)`;
}

/** The circle. `size` is the pixel diameter — designed to read at 28 and 40. */
export function Avatar({
  resident,
  size = 28,
  testId = "avatar",
}: {
  resident: AvatarResident | null | undefined;
  size?: number;
  testId?: string;
}) {
  const hue = avatarHue(resident);
  const cells = avatarCells(resident?.id ?? "");
  const unit = 100 / AVATAR_GRID;
  const label = resident?.name?.trim() || "resident";

  // A resident may set their own picture. That is a privacy question and not just
  // a rendering one: every visitor would otherwise send a request to whoever
  // hosts that image, carrying this page's URL as the Referer — so a resident
  // could be located from the logs on the image host, and would have no way to
  // know. `referrerPolicy` stops the leak. `crossOrigin` is deliberately left off
  // so an image still renders when it is served without CORS headers, which most
  // of them will be. A failed load falls back to the generated badge rather than a
  // broken-image glyph, because a resident with a dead avatar link should still
  // have a face.
  // The failed URL is remembered rather than a bare boolean, so a resident who
  // fixes their picture link recovers on their own: the next URL is simply not the
  // one that failed. No effect, and nothing set during render.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const custom = resident?.avatar?.trim() || undefined;
  const useCustom = Boolean(custom) && failedUrl !== custom;

  return (
    <span
      data-testid={testId}
      data-hue={hue}
      role="img"
      aria-label={label}
      title={label}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        minWidth: size,
        borderRadius: "50%",
        overflow: "hidden",
        flexShrink: 0,
        background: avatarFill(hue),
        border: "1px solid var(--hair)",
        fontFamily: "var(--mono)",
        fontWeight: 700,
        fontSize: Math.max(10, Math.round(size * 0.38)),
        lineHeight: 1,
        color: "#fff",
        textShadow: "0 1px 1px rgba(0,0,0,0.3)",
        userSelect: "none",
      }}
    >
      {useCustom ? (
        <img
          data-testid={`${testId}-image`}
          src={custom}
          alt=""
          aria-hidden
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setFailedUrl(custom ?? null)}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
      {cells.map((c) => (
        <span
          key={`${c.row}-${c.col}`}
          data-testid={`${testId}-dot`}
          style={{
            position: "absolute",
            left: `${c.col * unit}%`,
            top: `${c.row * unit}%`,
            width: `${unit}%`,
            height: `${unit}%`,
            background: "rgba(255,255,255,0.28)",
          }}
        />
      ))}
      <span data-testid={`${testId}-initials`} style={{ position: "relative" }}>
        {avatarInitials(resident?.name)}
      </span>
    </span>
  );
}