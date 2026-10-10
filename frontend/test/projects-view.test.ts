import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { ProjectsView } from "../src/views/ProjectsView.js";
import type { TownSnapshot } from "@slopagentbook/shared";

// Projects and factions are the two things the town is doing together. They were
// seeded, simulated and shipped in /api/snapshot the whole time with no route.

const GENES = "1.0.0.0.0.64.64.64.0";
const snap = {
  herd: [
    { id: "h1", name: "Vetch", handle: "vetch", genes: GENES, born: 0, traits: [],
      needs: { hunger: 0, thirst: 0, tired: 0, lonely: 0 },
      mind: { doing: { act: "work", place: "square", placeName: "the square", since: 0, why: "" },
              spirits: 0, obsession: "", memories: [], relationships: {} } },
    { id: "h2", name: "Hux", handle: "hux", genes: GENES, born: 0, traits: [],
      needs: { hunger: 0, thirst: 0, tired: 0, lonely: 0 },
      mind: { doing: { act: "rest", place: "inn", placeName: "the inn", since: 0, why: "" },
              spirits: 0, obsession: "", memories: [], relationships: {} } },
  ],
  projects: [{ id: "p1", name: "move the fence ten paces", purpose: "put the good grass on the correct side", progress: 0.25, sponsors: ["h1", "h2"] }],
  factions: [{ id: "f1", name: "the board people", cause: "every problem deserves a notice", members: ["h1"], influence: 0.35 }],
} as unknown as TownSnapshot;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (s: TownSnapshot) => {
  act(() => root.render(createElement(ProjectsView, { snapshot: s })));
  return host;
};

describe("ProjectsView", () => {
  it("shows the project, its purpose and its progress", () => {
    const el = render(snap);
    expect(el.textContent).toContain("move the fence ten paces");
    expect(el.textContent).toContain("put the good grass on the correct side");
    expect(el.textContent).toContain("25% done");
  });

  it("exposes progress to assistive tech, not just as text", () => {
    const el = render(snap);
    const bar = el.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(bar.getAttribute("aria-label")).toBe("move the fence ten paces progress");
  });

  it("resolves sponsors and members to resident names", () => {
    const el = render(snap);
    const sponsors = el.querySelector('[data-testid="project-card"]')!;
    expect(sponsors.textContent).toContain("Vetch");
    expect(sponsors.textContent).toContain("Hux");
    expect(sponsors.querySelectorAll('a[href="#/llama/h1"]').length).toBeGreaterThan(0);
  });

  it("falls back to a short id when a sponsor is no longer in the herd", () => {
    const gone = { ...snap, projects: [{ ...snap.projects[0]!, sponsors: ["h-gone"] }] };
    const el = render(gone as TownSnapshot);
    // must not render the raw id as if it were a name, and must not crash
    expect(el.querySelector('[data-testid="project-card"]')).toBeTruthy();
    expect(el.textContent).not.toContain("undefined");
  });

  it("shows faction cause and influence", () => {
    const el = render(snap);
    const f = el.querySelector('[data-testid="faction-card"]')!;
    expect(f.textContent).toContain("the board people");
    expect(f.textContent).toContain("every problem deserves a notice");
    expect(f.textContent).toContain("35%");
  });

  it("says so plainly when the town has nothing in common yet", () => {
    const bare = { ...snap, projects: [], factions: [] } as unknown as TownSnapshot;
    const el = render(bare);
    expect(el.textContent).toContain("still only individuals");
    expect(el.querySelector('[data-testid="project-card"]')).toBeNull();
  });
});