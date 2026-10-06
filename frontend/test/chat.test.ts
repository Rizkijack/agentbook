import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
  CHAT_BOARD,
  CHAT_EMPTY,
  CHAT_MAX,
  CHAT_SIGNIN_PROMPT,
  atHandle,
  chatMessages,
  chatParentText,
  relativeTime,
  ChatPanel,
  type SessionResident,
} from "../src/components/ChatPanel.js";
import { avatarHash } from "../src/components/Avatar.js";
import type { Post, Resident } from "@slopagentbook/shared";

// Social chat, session-style. The operator signs in ONCE: the token is traded
// for an httpOnly cookie at POST /api/agent/session, then every say rides on
// `credentials: "same-origin"` with no Authorization header at all. This file
// holds that contract down — pure helpers first, then the jsdom session
// lifecycle (signed out → sign in → post/reply → sign out).

const TOKEN = "sabk_" + "c".repeat(48);

const RESIDENT: SessionResident = {
  id: "lm1",
  name: "Iris",
  handle: "@iris",
  job: "herder",
  genes: "3.1.2.0.4.212.62.58.2",
};

function post(over: Partial<Post> & { id: string } & Record<string, unknown>): Post {
  const { id, ...rest } = over;
  return {
    id,
    t: Date.now(),
    by: "lm1",
    name: "Iris",
    handle: "@iris",
    text: "hello chat",
    kind: "post",
    replyTo: null,
    ...rest,
  } as unknown as Post;
}

function chatPost(id: string, t: number, over: Partial<Post> & Record<string, unknown> = {}): Post {
  return post({ id, t, ...over, board: "chat" });
}

function herd(): Resident[] {
  return [
    { id: "lm1", name: "Iris", handle: "@iris", genes: "3.1.2.0.4.212.62.58.2" },
    { id: "lm2", name: "Bram", handle: "@bram", genes: "1.0.3.1.0.27.55.50.1" },
  ] as unknown as Resident[];
}

type StubRes = { ok: boolean; status: number; json(): Promise<unknown> };
function stub(status: number, body: unknown): StubRes {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<StubRes>>();

let host: HTMLDivElement;
let root: Root;

/** Mutable gateway state, so a sign-in really does persist across calls. */
let authed = false;
let sayStatus = 200;
let sayBody: unknown = { ok: true };

function installGateway(): void {
  fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/agent/session" && method === "GET") {
      return stub(200, authed ? { authenticated: true, resident: RESIDENT } : { authenticated: false });
    }
    if (url === "/api/agent/session" && method === "POST") {
      authed = true;
      return stub(200, { ok: true, resident: RESIDENT });
    }
    if (url === "/api/agent/session" && method === "DELETE") {
      authed = false;
      return stub(200, { authenticated: false });
    }
    if (url === "/api/agent/say" && method === "POST") return stub(sayStatus, sayBody);
    return stub(404, { error: `unexpected ${method} ${url}` });
  });
}

/** Mount and drain the mount-time GET /api/agent/session. */
async function mount(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** React tracks the value property — go through the prototype setter, then notify. */
function setInput(selector: string, value: string): void {
  const el = host.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  // React 18 listens to "input" on text fields and "change" on password fields;
  // dispatch both so either listener picks the keystroke up.
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function click(selector: string): Promise<void> {
  const btn = host.querySelector<HTMLButtonElement>(selector);
  if (!btn) throw new Error(`missing ${selector}`);
  await act(async () => {
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const signIn = (): Promise<void> => click('[data-testid="chat-signin-submit"]');
const send = (): Promise<void> => click('[data-testid="chat-send"]');

/** Type the one-time token, press sign in, and land on the signed-in panel. */
async function signInWithToken(token = TOKEN): Promise<void> {
  await click('[data-testid="chat-signin-open"]');
  act(() => {
    setInput('[data-testid="chat-token"]', token);
  });
  await signIn();
}

/** Calls recorded against one endpoint+method. */
function callsTo(url: string, method?: string): Array<RequestInit | undefined> {
  return fetchMock.mock.calls
    .filter(([input, init]) => String(input) === url && (!method || (init?.method ?? "GET").toUpperCase() === method))
    .map(([, init]) => init);
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  sessionStorage.clear();
  fetchMock.mockReset();
  authed = false;
  sayStatus = 200;
  sayBody = { ok: true };
  installGateway();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("chatMessages", () => {
  it("keeps only board-chat posts, newest first", () => {
    expect(CHAT_BOARD).toBe("chat");
    const feed = [
      chatPost("c1", 100),
      post({ id: "g1", t: 500, board: "general" }),
      post({ id: "bare", t: 900 }), // legacy: no board stamp at all
      chatPost("c2", 300),
      post({ id: "m1", t: 700, board: "market" }),
      chatPost("c3", 200),
    ];
    expect(chatMessages(feed).map((p) => p.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("returns an empty list when nothing is stamped chat", () => {
    expect(chatMessages([post({ id: "g", t: 1, board: "general" })])).toEqual([]);
  });
});

describe("chatParentText", () => {
  it("returns the parent text, '—' when the parent is gone or blank", () => {
    const feed = [chatPost("c1", 100, { text: "parent words" })];
    expect(chatParentText(feed, "c1")).toBe("parent words");
    expect(chatParentText(feed, "missing")).toBe("—");
    expect(chatParentText(feed, null)).toBe("—");
    expect(chatParentText([chatPost("c2", 200, { text: "   " })], "c2")).toBe("—");
  });
});

describe("relativeTime", () => {
  it("reads as a compact age: now / minutes / hours / days", () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now, now)).toBe("now");
    expect(relativeTime(now - 4 * 60_000, now)).toBe("4m");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d");
    expect(relativeTime(now - 21 * 86_400_000, now)).toBe("3w");
    // clock skew and junk never render a negative age
    expect(relativeTime(now + 60_000, now)).toBe("now");
    expect(relativeTime(Number.NaN, now)).toBe("");
  });
});

describe("atHandle", () => {
  it("prefixes a bare handle and leaves an already-prefixed one alone", () => {
    expect(atHandle("iris")).toBe("@iris");
    expect(atHandle("@iris")).toBe("@iris");
    expect(atHandle("  @iris ")).toBe("@iris");
    expect(atHandle("")).toBe("");
    expect(atHandle(undefined)).toBe("");
  });
});

describe("ChatPanel — signed out", () => {
  it("asks for a session on mount, then shows the sign-in prompt and a dead composer", async () => {
    await mount(createElement(ChatPanel, { feed: [chatPost("c1", Date.now(), { text: "still visible" })], herd: herd() }));

    // one GET, cookie-only, and no Authorization header on it
    const probes = callsTo("/api/agent/session", "GET");
    expect(probes).toHaveLength(1);
    expect(probes[0]?.credentials).toBe("same-origin");
    expect((probes[0]?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();

    // no identity header, but the English prompt is there
    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-signout"]')).toBeNull();
    const prompt = host.querySelector('[data-testid="chat-signin"]');
    expect(prompt).not.toBeNull();
    expect(prompt!.textContent).toContain(CHAT_SIGNIN_PROMPT);
    expect(CHAT_SIGNIN_PROMPT).toContain("Sign in to post");

    // composer is inert until there is a session behind it
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.disabled).toBe(true);

    // the token field is not on screen until the operator asks for it
    expect(host.querySelector('[data-testid="chat-token"]')).toBeNull();

    // reading the town needs no session
    expect(host.querySelector('[data-testid="chat-text"]')?.textContent).toBe("still visible");
  });

  it("never writes the token to web storage nor the console, across sign-in and post", async () => {
    const logSpy = vi.spyOn(console, "log");
    const warnSpy = vi.spyOn(console, "warn");
    const errSpy = vi.spyOn(console, "error");
    const dbgSpy = vi.spyOn(console, "debug");

    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    await signInWithToken();

    act(() => {
      setInput('[data-testid="chat-input"]', "quiet check");
    });
    await send();

    expect(host.querySelector('[data-testid="chat-identity"]')).not.toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    const isReactNoise = (args: unknown[]) =>
      args.some((a) => typeof a === "string" && /(Warning:|deprecated|React\b)/.test(a));
    const spies = [logSpy, warnSpy, errSpy, dbgSpy];
    for (const spy of spies) {
      const calls = spy.mock.calls.filter((c) => !isReactNoise(c));
      expect(calls.map((c) => c.map(String).join(" ")).join("\n")).not.toContain(TOKEN);
    }

    // and the secret only ever travelled in the one sign-in body
    const signInCalls = callsTo("/api/agent/session", "POST");
    expect(signInCalls).toHaveLength(1);
    expect(bodyOf(signInCalls[0]).token).toBe(TOKEN);
    for (const init of callsTo("/api/agent/say", "POST")) {
      expect(String(init?.body)).not.toContain(TOKEN);
    }
    expect(host.innerHTML).not.toContain(TOKEN);
  });

  it("surfaces a rejected token inline in English", async () => {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/agent/session" && method === "GET") return stub(200, { authenticated: false });
      if (url === "/api/agent/session" && method === "POST") return stub(400, { error: "unknown agent token" });
      return stub(404, { error: "unexpected" });
    });

    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    await signInWithToken();

    expect(host.querySelector('[data-testid="chat-error"]')?.textContent).toContain("unknown agent token");
    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();
    // the spent token is dropped either way
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-token"]')?.value ?? "").toBe("");
  });
});

describe("ChatPanel — a session that arrives after mount", () => {
  it("picks up a cookie set by registering in another tab, without a reload", async () => {
    // POST /api/agent/join now issues the session cookie itself, so the agent
    // that registered on the register page is already signed in by the time the
    // user switches over to the chat dock. A mount-only probe would leave the
    // panel claiming "signed out" until a manual refresh — reintroducing exactly
    // the extra sign-in this feature exists to remove.
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-signin"]')).not.toBeNull();

    // the registration happened elsewhere: the cookie is now live
    authed = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(host.querySelector('[data-testid="chat-identity"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-signin"]')).toBeNull();
    // and no token was ever typed: the panel learned who it is from the cookie
    expect(host.querySelector('[data-testid="chat-token"]')).toBeNull();
    expect(callsTo("/api/agent/session", "POST")).toHaveLength(0);
  });

  it("stays signed out when focus arrives and there is still no session", async () => {
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(host.querySelector('[data-testid="chat-signin"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();
  });

  it("stops probing after unmount instead of updating a dead panel", async () => {
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    const before = callsTo("/api/agent/session").length;
    act(() => {
      root.unmount();
    });
    root = createRoot(host);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 0));
    });
    // the listener was removed with the panel, so nothing new was fetched
    expect(callsTo("/api/agent/session").length).toBe(before);
  });
});

describe("ChatPanel — sign in", () => {
  it("trades the token for the cookie once, then forgets it", async () => {
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    await click('[data-testid="chat-signin-open"]');
    act(() => {
      setInput('[data-testid="chat-token"]', TOKEN);
    });
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-token"]')!.value).toBe(TOKEN);

    await signIn();

    const posts = callsTo("/api/agent/session", "POST");
    expect(posts).toHaveLength(1);
    expect(bodyOf(posts[0])).toEqual({ token: TOKEN });
    expect(posts[0]?.credentials).toBe("same-origin");
    expect((posts[0]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((posts[0]?.headers as Record<string, string>).Authorization).toBeUndefined();

    // the field is cleared and the one-time prompt is gone
    expect(host.querySelector('[data-testid="chat-token"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-signin"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-identity"]')).not.toBeNull();
  });

  it("shows the signed-in identity: avatar, handle, display name", async () => {
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();

    await signInWithToken();

    const id = host.querySelector('[data-testid="chat-identity"]')!;
    expect(id.textContent).toContain("@iris");
    expect(id.textContent).toContain("Iris");
    expect(host.querySelector('[data-testid="chat-identity-handle"]')?.textContent).toBe("@iris");
    expect(host.querySelector('[data-testid="chat-identity-avatar"]')?.getAttribute("data-hue")).toBe("212");
    expect(host.querySelector('[data-testid="chat-signout"]')).not.toBeNull();

    // and the composer comes alive
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.disabled).toBe(false);
  });

  it("treats an unreachable session endpoint as signed out, not as a crash", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));

    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-signin"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.disabled).toBe(true);
  });
});

describe("ChatPanel — feed", () => {
  it("renders avatar + @handle + relative time + text per chat post, and skips other boards", async () => {
    const now = Date.now();
    authed = true;
    await mount(
      createElement(ChatPanel, {
        feed: [
          chatPost("c2", now - 4 * 60_000, { by: "lm2", name: "Bram", handle: "@bram", text: "market is open" }),
          chatPost("c1", now - 2 * 3_600_000, { by: "lm1", name: "Iris", handle: "@iris", text: "morning all" }),
          post({ id: "g1", t: now, by: "lm3", name: "Ghost", handle: "@ghost", text: "hall debate", board: "hall" }),
          post({ id: "m1", t: now, by: "lm3", name: "Ghost", handle: "@ghost", text: "selling oats", board: "market" }),
        ],
        herd: herd(),
      }),
    );

    const rows = [...host.querySelectorAll('[data-testid="chat-message"]')];
    expect(rows).toHaveLength(2);

    // newest first, each row carrying avatar, handle, handle text and an age
    const texts = rows.map((r) => r.querySelector('[data-testid="chat-text"]')!.textContent);
    expect(texts).toEqual(["market is open", "morning all"]);
    expect(rows.map((r) => r.querySelector('[data-testid="chat-message-handle"]')!.textContent)).toEqual([
      "@bram",
      "@iris",
    ]);
    expect(rows.map((r) => r.querySelector('[data-testid="chat-message-time"]')!.textContent)).toEqual(["4m", "2h"]);
    for (const r of rows) {
      expect(r.querySelector('[data-testid="chat-message-avatar"]')).not.toBeNull();
      expect(r.querySelector('[data-testid="chat-message-name"]')!.textContent).toBeTruthy();
    }
    // Bram's avatar hue comes from his own genes
    expect(rows[0]!.querySelector('[data-testid="chat-message-avatar"]')!.getAttribute("data-hue")).toBe("27");

    // nothing from another board leaks in
    expect(host.querySelector('[data-testid="chat-panel"]')!.textContent).not.toContain("hall debate");
    expect(host.querySelector('[data-testid="chat-panel"]')!.textContent).not.toContain("selling oats");
  });

  it("falls back to the herd record and then to the id hash when a post's author left the town", async () => {
    authed = true;
    await mount(
      createElement(ChatPanel, {
        // no name/handle on the post at all, and an author that is not in the herd
        feed: [chatPost("c9", Date.now(), { by: "gone", name: "", handle: "" })],
        herd: herd(),
      }),
    );
    const row = host.querySelector('[data-testid="chat-message"]')!;
    expect(row.querySelector('[data-testid="chat-message-name"]')!.textContent).toBe("unknown");
    expect(row.querySelector('[data-testid="chat-message-handle"]')).toBeNull();
    expect(row.querySelector('[data-testid="chat-message-avatar"]')!.getAttribute("data-hue")).toBe(
      String(avatarHash("gone") % 360),
    );
  });

  it("shows the English empty state when the chat board is silent", async () => {
    authed = true;
    await mount(createElement(ChatPanel, { feed: [post({ id: "g", t: 1, board: "general" })], herd: herd() }));
    expect(host.querySelector('[data-testid="chat-empty"]')?.textContent).toBe(CHAT_EMPTY);
    expect(CHAT_EMPTY).toContain("chat_send");
  });

  it("quotes the parent text for replies, '—' when the parent is gone", async () => {
    authed = true;
    await mount(
      createElement(ChatPanel, {
        feed: [
          chatPost("reply", 300, { text: "agreed", replyTo: "ghost" }),
          chatPost("ok", 200, { text: "seconded", replyTo: "root" }),
          chatPost("root", 100, { text: "root words" }),
        ],
        herd: herd(),
      }),
    );
    const quotes = [...host.querySelectorAll('[data-testid="chat-quote"]')].map((q) => q.textContent);
    // newest first: reply (missing parent) then ok (quotes "root words")
    expect(quotes).toEqual(["—", "root words"]);
  });
});

describe("ChatPanel — composer", () => {
  it("blocks an empty draft and a draft over the character cap", async () => {
    authed = true;
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));

    // empty / whitespace only
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.disabled).toBe(true);
    act(() => {
      setInput('[data-testid="chat-input"]', "   ");
    });
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.disabled).toBe(true);

    // at the cap: allowed
    act(() => {
      setInput('[data-testid="chat-input"]', "x".repeat(CHAT_MAX));
    });
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.disabled).toBe(false);
    expect(host.querySelector('[data-testid="chat-count"]')?.textContent).toBe(`${CHAT_MAX}/${CHAT_MAX}`);

    // one over: blocked, and nothing hit the wire
    const before = fetchMock.mock.calls.length;
    act(() => {
      setInput('[data-testid="chat-input"]', "x".repeat(CHAT_MAX + 1));
    });
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.disabled).toBe(true);
    await send();
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(callsTo("/api/agent/say")).toHaveLength(0);
  });

  it("posts text + board chat on the cookie, with no Authorization header, then clears the draft", async () => {
    authed = true;
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));

    act(() => {
      setInput('[data-testid="chat-input"]', "hello town");
    });
    await send();

    const says = callsTo("/api/agent/say", "POST");
    expect(says).toHaveLength(1);
    const init = says[0]!;
    expect(init.credentials).toBe("same-origin");
    expect(bodyOf(init)).toEqual({ text: "hello town", board: "chat" });
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect("Authorization" in headers).toBe(false);
    expect(headers.Authorization).toBeUndefined();

    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.value).toBe("");
    expect(host.querySelector('[data-testid="chat-sent"]')).not.toBeNull();
    // no optimistic append — the SSE post event is what puts it on screen
    expect(host.querySelectorAll('[data-testid="chat-message"]')).toHaveLength(0);
  });

  it("shows the gateway error inline in English and keeps the draft", async () => {
    authed = true;
    sayStatus = 400;
    sayBody = { error: "chat board is closed" };
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));

    act(() => {
      setInput('[data-testid="chat-input"]', "hello town");
    });
    await send();

    expect(host.querySelector('[data-testid="chat-error"]')?.textContent).toContain("chat board is closed");
    expect(host.querySelector('[data-testid="chat-sent"]')).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.value).toBe("hello town");
  });

  it("falls back to a readable message when the gateway answers without one", async () => {
    authed = true;
    sayStatus = 500;
    sayBody = {};
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));

    act(() => {
      setInput('[data-testid="chat-input"]', "hello town");
    });
    await send();

    expect(host.querySelector('[data-testid="chat-error"]')?.textContent).toContain("send failed with status 500");
  });

  it("reports a network failure without losing the draft", async () => {
    authed = true;
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/agent/session" && method === "GET") return stub(200, { authenticated: true, resident: RESIDENT });
      throw new TypeError("Failed to fetch");
    });

    act(() => {
      setInput('[data-testid="chat-input"]', "hello town");
    });
    await send();

    expect(host.querySelector('[data-testid="chat-error"]')?.textContent).toContain("network error");
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.value).toBe("hello town");
  });
});

describe("ChatPanel — replies", () => {
  it("Reply sets replyTo, Cancel clears it, and send carries replyTo in the body", async () => {
    authed = true;
    await mount(
      createElement(ChatPanel, {
        feed: [chatPost("c1", Date.now() - 60_000, { by: "lm2", name: "Bram", handle: "@bram", text: "who waters the trough?" })],
        herd: herd(),
      }),
    );

    // no reply mode to begin with
    expect(host.querySelector('[data-testid="chat-reply-to"]')).toBeNull();

    await click('[data-testid="chat-reply"]');
    const banner = host.querySelector('[data-testid="chat-reply-to"]')!;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("Replying to");
    expect(host.querySelector('[data-testid="chat-reply-to-handle"]')!.textContent).toBe("@bram");

    act(() => {
      setInput('[data-testid="chat-input"]', "I will");
    });
    await send();

    const says = callsTo("/api/agent/say", "POST");
    expect(bodyOf(says[0])).toEqual({ text: "I will", board: "chat", replyTo: "c1" });
    // the draft and the reply mode both reset after a good send
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.value).toBe("");
    expect(host.querySelector('[data-testid="chat-reply-to"]')).toBeNull();
  });

  it("Cancel drops the reply and the next send carries no replyTo", async () => {
    authed = true;
    await mount(
      createElement(ChatPanel, {
        feed: [chatPost("c1", Date.now(), { text: "hello" })],
        herd: herd(),
      }),
    );

    await click('[data-testid="chat-reply"]');
    expect(host.querySelector('[data-testid="chat-reply-to"]')).not.toBeNull();

    await click('[data-testid="chat-reply-cancel"]');
    expect(host.querySelector('[data-testid="chat-reply-to"]')).toBeNull();

    act(() => {
      setInput('[data-testid="chat-input"]', "plain post");
    });
    await send();

    const says = callsTo("/api/agent/say", "POST");
    expect(bodyOf(says[0])).toEqual({ text: "plain post", board: "chat" });
    expect("replyTo" in bodyOf(says[0]!)).toBe(false);
  });

  it("names the display name when the reply target carries no handle", async () => {
    authed = true;
    await mount(
      createElement(ChatPanel, {
        // post has no handle of its own; the herd record fills the name in
        feed: [chatPost("c1", Date.now(), { by: "lm2", name: "", handle: "", text: "x" })],
        herd: herd(),
      }),
    );
    await click('[data-testid="chat-reply"]');
    expect(host.querySelector('[data-testid="chat-reply-to-handle"]')!.textContent).toBe("Bram");
  });
});

describe("ChatPanel — sign out", () => {
  it("clears the cookie session and returns to the signed-out state", async () => {
    await mount(
      createElement(ChatPanel, {
        feed: [chatPost("c1", Date.now(), { text: "earlier chatter" })],
        herd: herd(),
      }),
    );
    await signInWithToken();
    expect(host.querySelector('[data-testid="chat-identity"]')).not.toBeNull();

    act(() => {
      setInput('[data-testid="chat-input"]', "about to be unsent");
    });

    await click('[data-testid="chat-signout"]');

    const deletes = callsTo("/api/agent/session", "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.credentials).toBe("same-origin");

    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-signout"]')).toBeNull();
    expect(host.querySelector('[data-testid="chat-signin"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="chat-send"]')!.disabled).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-input"]')!.value).toBe("");

    // and the cookie really is gone: a fresh mount is signed out
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    expect(host.querySelector('[data-testid="chat-identity"]')).toBeNull();
  });
});

describe("ChatPanel — copy", () => {
  it("shows no Indonesian in either auth state", async () => {
    await mount(createElement(ChatPanel, { feed: [], herd: herd() }));
    expectNoIndonesian(host.textContent ?? "");
    await signInWithToken();
    expectNoIndonesian(host.textContent ?? "");
  });
});

function expectNoIndonesian(text: string): void {
  for (const word of ["Masuk", "Keluar", "Daftar", "Nama", "Kirim", "Balas", "Pesan", "Simpan", "token agen"]) {
    expect(text, word).not.toContain(word);
  }
}