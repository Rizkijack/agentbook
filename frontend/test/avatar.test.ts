import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
  AVATAR_GRID,
  AVATAR_HUE_INDEX,
  Avatar,
  avatarCells,
  avatarFill,
  avatarHash,
  avatarHue,
  avatarInitials,
} from "../src/components/Avatar.js";

// The chat avatar: pure helpers first (determinism, divergence, the malformed
// genes fallback), then one jsdom render to prove the hue reaches a real style
// attribute at both dock sizes. No canvas and no window — it must render
// under SSR-safe conditions too.

const GENES_A = "3.1.2.0.4.212.62.58.2";
const GENES_B = "3.1.2.0.4.27.62.58.2";

function resident(over: Partial<{ id: string; name: string; genes: string }> = {}) {
  return { id: "lm1", name: "Iris", genes: GENES_A, ...over };
}

describe("avatarHue", () => {
  it("reads field 5 of the genes string — the same index genetics.ts Hc() uses", () => {
    expect(AVATAR_HUE_INDEX).toBe(5);
    expect(avatarHue(resident({ genes: GENES_A }))).toBe(212);
    expect(avatarHue(resident({ genes: GENES_B }))).toBe(27);
  });

  it("is deterministic: the same resident gives the same hue every call", () => {
    const a = Array.from({ length: 25 }, () => avatarHue(resident()));
    expect(new Set(a).size).toBe(1);
    expect(avatarHue(resident())).toBe(avatarHue(resident()));
  });

  it("gives two different residents different hues", () => {
    expect(avatarHue(resident({ genes: GENES_A }))).not.toBe(avatarHue(resident({ genes: GENES_B })));
  });

  it("normalises out-of-range and negative hue values into [0,360)", () => {
    expect(avatarHue(resident({ genes: "1.0.0.0.0.372" }))).toBe(12);
    expect(avatarHue(resident({ genes: "1.0.0.0.0.-30" }))).toBe(330);
  });

  it("falls back to an id hash on malformed genes instead of throwing", () => {
    const cases = [
      "",                       // empty
      "not-a-dna-string",       // no dots at all
      "1.2.3.4.5",              // truncated before the hue field
      "1.2.3.4.5.bogus",        // non-numeric hue field
      "1.2.3.4.5.",             // trailing dot, empty hue
      "undefined.null.NaN.x",   // noise
    ];
    for (const genes of cases) {
      const hue = avatarHue({ id: "lm9", name: "Bram", genes });
      expect(Number.isInteger(hue), genes).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      // deterministic fallback, and identical to the plain id hash
      expect(avatarHue({ id: "lm9", genes })).toBe(hue);
      expect(hue).toBe(avatarHash("lm9") % 360);
    }
    // absent / non-string genes behave the same way
    expect(avatarHue({ id: "lm9" })).toBe(avatarHash("lm9") % 360);
    expect(avatarHue({ id: "lm9", genes: undefined })).toBe(avatarHash("lm9") % 360);
    expect(avatarHue({ id: "lm9", genes: 42 as unknown as string })).toBe(avatarHash("lm9") % 360);
    expect(avatarHue(null)).toBe(avatarHash("") % 360);
    expect(avatarHue(undefined)).toBe(avatarHash("") % 360);
  });

  it("separates residents that share genes but differ by id", () => {
    // genes missing entirely: colour comes from the id, not a shared default
    expect(avatarHue({ id: "lm1", genes: "bad" })).not.toBe(avatarHue({ id: "lm2", genes: "bad" }));
  });
});

describe("avatarCells", () => {
  it("is deterministic for the same id", () => {
    const a = avatarCells("lm1");
    expect(a.length).toBeGreaterThan(0);
    for (let i = 0; i < 25; i++) expect(avatarCells("lm1")).toEqual(a);
  });

  it("gives two different ids different patterns", () => {
    expect(avatarCells("lm1")).not.toEqual(avatarCells("lm2"));
    expect(avatarCells("ag-0001")).not.toEqual(avatarCells("ag-0002"));
  });

  it("stays inside the grid and is never empty", () => {
    const ids = ["a", "b", "lm1", "lm2", "ag-0001", "ag-0002", "", "zzzzzzzz", "lm9999", "x"];
    for (const id of ids) {
      const cells = avatarCells(id);
      expect(cells.length, id).toBeGreaterThan(0);
      for (const c of cells) {
        expect(c.row, id).toBeGreaterThanOrEqual(0);
        expect(c.row, id).toBeLessThan(AVATAR_GRID);
        expect(c.col, id).toBeGreaterThanOrEqual(0);
        expect(c.col, id).toBeLessThan(AVATAR_GRID);
      }
      // no duplicate coordinates, or a dot would be painted twice
      const keys = cells.map((c) => `${c.row}-${c.col}`);
      expect(new Set(keys).size, id).toBe(keys.length);
    }
  });

  it("mirrors left to right, so the face is symmetric", () => {
    // every filled column exists mirrored about the centre column
    for (const id of ["lm1", "lm2", "ag-0001", "ag-0002"]) {
      for (const c of avatarCells(id)) {
        const mirrored = avatarCells(id).some((m) => m.row === c.row && m.col === AVATAR_GRID - 1 - c.col);
        expect(mirrored, `${id} row ${c.row} col ${c.col}`).toBe(true);
      }
    }
  });

  it("avatarHash is a stable 32-bit unsigned int", () => {
    expect(avatarHash("")).toBe(0x811c9dc5);
    expect(avatarHash("lm1")).toBe(avatarHash("lm1"));
    expect(avatarHash("lm1")).toBeLessThan(2 ** 32);
    expect(Number.isInteger(avatarHash("ag-0001"))).toBe(true);
  });
});

describe("avatarInitials & avatarFill", () => {
  it("takes up to two initials, uppercased", () => {
    expect(avatarInitials("Iris")).toBe("I");
    expect(avatarInitials("Ada Lovelace")).toBe("AL");
    expect(avatarInitials("  bram  ")).toBe("B");
    expect(avatarInitials("Jean-Luc van der Berg")).toBe("JL");
    expect(avatarInitials("")).toBe("?");
    expect(avatarInitials(undefined)).toBe("?");
  });

  it("builds a legible hsl fill from the hue", () => {
    expect(avatarFill(212)).toBe("hsl(212, 44%, 52%)");
    // and it is a colour the engine actually accepts, not a dropped value
    const probe = document.createElement("div");
    probe.style.background = avatarFill(27);
    expect(probe.style.background).toBe("rgb(187, 127, 79)");
  });
});

/** What the CSS engine makes of an authored colour string. */
function expectedRgb(css: string): string {
  const probe = document.createElement("div");
  probe.style.background = css;
  return probe.style.background;
}

describe("Avatar (jsdom)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  function render(node: ReactNode): void {
    act(() => {
      root.render(node);
    });
  }

  it("applies the hue as a real inline style at both dock sizes", () => {
    render(createElement(Avatar, { resident: resident(), size: 28 }));
    const el = host.querySelector<HTMLElement>('[data-testid="avatar"]')!;
    expect(el).not.toBeNull();
    expect(el.getAttribute("data-hue")).toBe("212");
    // the colour is a real parsed style, not just a data attribute: jsdom
    // serialises the authored hsl(212, 44%, 52%) down to its rgb() equivalent
    expect(el.getAttribute("style")).toContain("background:");
    expect(el.style.background).toBe("rgb(79, 129, 187)");
    expect(el.style.background).toBe(expectedRgb(avatarFill(212)));
    expect(el.style.width).toBe("28px");
    expect(el.style.height).toBe("28px");
    expect(el.style.borderRadius).toBe("50%");
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("Iris");
  });

  it("paints one dot per cell and the initials on top", () => {
    render(createElement(Avatar, { resident: resident({ name: "Ada Lovelace" }), size: 40 }));
    const el = host.querySelector<HTMLElement>('[data-testid="avatar"]')!;
    expect(el.style.width).toBe("40px");
    expect(host.querySelectorAll('[data-testid="avatar-dot"]')).toHaveLength(avatarCells("lm1").length);
    expect(host.querySelector('[data-testid="avatar-initials"]')?.textContent).toBe("AL");
  });

  it("renders a blank-gene resident off the id hash without crashing", () => {
    render(createElement(Avatar, { resident: { id: "lm7", name: "No Genes" } }));
    const el = host.querySelector<HTMLElement>('[data-testid="avatar"]')!;
    expect(el.getAttribute("data-hue")).toBe(String(avatarHash("lm7") % 360));
    expect(el.getAttribute("aria-label")).toBe("No Genes");
  });

  it("survives a missing resident — no throw, placeholder face", () => {
    render(createElement(Avatar, { resident: null }));
    const el = host.querySelector<HTMLElement>('[data-testid="avatar"]')!;
    expect(el).not.toBeNull();
    expect(el.getAttribute("aria-label")).toBe("resident");
    expect(host.querySelector('[data-testid="avatar-initials"]')?.textContent).toBe("?");
  });

  it("is pure: the same resident renders the same markup twice", () => {
    render(createElement(Avatar, { resident: resident(), size: 28 }));
    const first = host.innerHTML;
    render(createElement(Avatar, { resident: resident(), size: 28 }));
    expect(host.innerHTML).toBe(first);
  });
});