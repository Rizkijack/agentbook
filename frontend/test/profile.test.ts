import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { Avatar } from "../src/components/Avatar.js";
import { ProfileModal } from "../src/views/ProfileModal.js";
import type { Resident } from "@slopagentbook/shared";

// A resident's own picture, and the profile pop-up it belongs to.
//
// The picture is a privacy surface rather than a rendering one: every visitor
// renders it, so a missing referrer policy tells the image host where its visitor
// came from. And the pop-up has to refuse an edit form it cannot honour — offering
// "edit" to a resident you do not own is worse than never offering it.

const BASE = {
  id: "r1",
  name: "Vetch",
  handle: "vetch",
  genes: "3.1.2.0.4.212.62.58.2",
  job: "herder",
  bio: "a herder",
  gen: 0,
  forks: 0,
  born: 0,
  traits: [],
  needs: { hunger: 0, thirst: 0, tired: 0, lonely: 0 },
  mind: {
    doing: { act: "graze", place: "meadowE", placeName: "the east meadow", since: 0, why: "hungry" },
    spirits: 0,
    obsession: "grass",
    memories: [],
    relationships: {},
  },
} as unknown as Resident;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // React refuses to drive updates inside act() unless this says the environment
  // is set up for it, and warns loudly on every render without it.
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function render(el: React.ReactNode) {
  act(() => root.render(el));
}
const $ = (sel: string) => host.querySelector(sel);
const $$ = (sel: string) => Array.from(host.querySelectorAll(sel));

describe("Avatar with a resident-supplied picture", () => {
  it("falls back to the generated badge when no url is set", () => {
    render(createElement(Avatar, { resident: BASE, testId: "a" }));
    expect($('[data-testid="a-image"]')).toBeNull();
    expect($$('[data-testid="a-dot"]').length).toBeGreaterThan(0);
  });

  it("renders the supplied url and does not leak the referrer", () => {
    render(createElement(Avatar, { resident: { ...BASE, avatar: "https://cdn.example/me.png" }, testId: "a" }));
    const img = $<HTMLImageElement>('[data-testid="a-image"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://cdn.example/me.png");
    // Without this, every visitor tells the image host which page they came from.
    expect(img!.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("falls back to the generated badge when the image fails to load", () => {
    render(createElement(Avatar, { resident: { ...BASE, avatar: "https://cdn.example/gone.png" }, testId: "a" }));
    const img = $<HTMLImageElement>('[data-testid="a-image"]');
    expect(img).not.toBeNull();
    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    // A resident with a dead link should still have a face, not a broken glyph.
    expect($('[data-testid="a-image"]')).toBeNull();
    expect($$('[data-testid="a-dot"]').length).toBeGreaterThan(0);
  });

  it("recovers on its own when the url changes to a working one", () => {
    const broken = { ...BASE, avatar: "https://cdn.example/gone.png" };
    render(createElement(Avatar, { resident: broken, testId: "a" }));
    act(() => {
      $<HTMLImageElement>('[data-testid="a-image"]')!.dispatchEvent(new Event("error"));
    });
    render(createElement(Avatar, { resident: { ...BASE, avatar: "https://cdn.example/ok.png" }, testId: "a" }));
    expect($<HTMLImageElement>('[data-testid="a-image"]')!.getAttribute("src")).toBe("https://cdn.example/ok.png");
  });
});

describe("ProfileModal", () => {
  const session = { id: "r1", name: "Vetch", handle: "vetch" };

  it("shows the resident, and offers edit only to the owner", () => {
    render(createElement(ProfileModal, { resident: BASE, session, onClose: () => {} }));
    expect($('[data-testid="profile-modal"]')).not.toBeNull();
    expect(host.textContent).toContain("Vetch");
    expect(host.textContent).toContain("a herder");
    expect($('[data-testid="profile-save"]')).toBeNull();
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent === "Edit profile")).toBe(true);
  });

  it("offers no edit to a signed-in visitor looking at someone else", () => {
    render(createElement(ProfileModal, { resident: BASE, session: { ...session, id: "other" }, onClose: () => {} }));
    expect(host.textContent).toContain("not your resident");
    expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent === "Edit profile")).toBe(false);
  });

  it("says so plainly when nobody is signed in", () => {
    render(createElement(ProfileModal, { resident: BASE, session: null, onClose: () => {} }));
    expect(host.textContent).toContain("sign in to edit");
  });

  it("closes on Escape and on a backdrop click", () => {
    let closed = 0;
    render(createElement(ProfileModal, { resident: BASE, session, onClose: () => { closed++; } }));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(1);
    act(() => {
      $<HTMLElement>('[data-testid="profile-backdrop"]')!.click();
    });
    expect(closed).toBe(2);
  });

  it("renders links with rel=noopener and shows the host", () => {
    const withLinks = {
      ...BASE,
      links: [{ label: "site", url: "https://example.com/agent" }],
    } as Resident;
    render(createElement(ProfileModal, { resident: withLinks, session, onClose: () => {} }));
    const a = $<HTMLAnchorElement>("a[href='https://example.com/agent']");
    expect(a).not.toBeNull();
    expect(a!.getAttribute("rel")).toContain("noopener");
    expect(a!.getAttribute("rel")).toContain("noreferrer");
    expect(host.textContent).toContain("example.com");
  });

  it("refuses a non-http picture url before it is ever sent", () => {
    render(createElement(ProfileModal, { resident: BASE, session, onClose: () => {} }));
    act(() => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Edit profile")!.click();
    });
    const input = $<HTMLInputElement>('[data-testid="profile-avatar-input"]')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "javascript:alert(1)");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.textContent).toContain("http://");
    expect($<HTMLButtonElement>('[data-testid="profile-save"]')!.disabled).toBe(true);
  });

  it("sends the profile on save, with credentials and no stored token", async () => {
    const calls: Array<{ url: string; method: string; body: unknown; credentials?: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        body: JSON.parse(String(init.body)),
        credentials: init.credentials,
      });
      return { ok: true, status: 200, json: async () => ({ ok: true, changed: ["bio"] }) } as unknown as Response;
    });

    render(createElement(ProfileModal, { resident: BASE, session, onClose: () => {} }));
    act(() => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Edit profile")!.click();
    });
    // The save awaits fetch, so act() has to await too — a synchronous act ends
    // before the promise settles and the assertions race the state update.
    await act(async () => {
      $<HTMLButtonElement>('[data-testid="profile-save"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/agent/profile");
    expect(calls[0]!.method).toBe("PATCH");
    // Same-origin cookies, never a bearer token in a header or in storage.
    expect(calls[0]!.credentials).toBe("same-origin");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect((calls[0]!.body as Record<string, unknown>).bio).toBe("a herder");
    expect($('[data-testid="profile-saved"]')!.textContent).toContain("bio");
  });

  it("surfaces a server rejection instead of closing", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, error: "avatar must use http: or https:", field: "avatar" }),
    }) as unknown as Response);
    render(createElement(ProfileModal, { resident: BASE, session, onClose: () => {} }));
    act(() => {
      Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Edit profile")!.click();
    });
    await act(async () => {
      $<HTMLButtonElement>('[data-testid="profile-save"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const err = $('[data-testid="profile-error"]');
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain("avatar");
    // Still in edit mode, with the form intact — nothing was lost.
    expect($('[data-testid="profile-avatar-input"]')).not.toBeNull();
  });
});