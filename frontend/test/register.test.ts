import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { RegisterView } from "../src/views/RegisterView.js";
import {
  MCP_STDIO_PATH,
  MCP_TOOLS,
  openCodeConfig,
  claudeDesktopConfig,
  hermesConfig,
} from "../src/views/mcpInfo.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 09 §1 — register.test.ts: the `#/register` page. Four sections, English-only
// labels, the exact POST /api/agent/join payload, gateway error surfaces
// (400/429/network), client-side validation short-circuiting the network call,
// and the token discipline the component promises: memory only — never
// localStorage/sessionStorage, never console.

const RUN = Date.now().toString().slice(-7);
const OWNER_HANDLE = `@ada${RUN}`;
const TOKEN = "sabk_" + "a".repeat(48);

type StubRes = { ok: boolean; status: number; json(): Promise<unknown> };

function stub(status: number, body: unknown): StubRes {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn<(input: unknown, init?: RequestInit) => Promise<StubRes>>();

let host: HTMLDivElement;
let root: Root;

/** React tracks the value property — go through the prototype setter, then notify. */
function setInput(selector: string, value: string): void {
  const el = host.querySelector(selector);
  if (!el) throw new Error(`missing ${selector}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillValid(): void {
  act(() => {
    setInput("#reg-name", "Iris Reg");
    setInput("#reg-owner-name", "Ada Lovelace");
    setInput("#reg-owner-handle", OWNER_HANDLE);
    // job keeps its "herder" default, origin keeps "web:register"
  });
}

/** Click and drain the microtasks the async submit() needs — inside act the whole time. */
async function submit(): Promise<void> {
  const btn = host.querySelector<HTMLButtonElement>('[data-submit="register"]');
  if (!btn) throw new Error("submit button missing");
  await act(async () => {
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function alertText(): string {
  return host.querySelector('[role="alert"]')?.textContent ?? "";
}

beforeEach(() => {
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  sessionStorage.clear();
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  act(() => {
    root.render(createElement(RegisterView, {}));
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  host.remove();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("RegisterView layout & labels", () => {
  it("renders all four sections with English labels and no Indonesian ones", () => {
    const sections = [...host.querySelectorAll("[data-section]")].map((s) => s.getAttribute("data-section"));
    expect(sections).toEqual(["mcp", "agent", "job", "account"]);

    const text = host.textContent ?? "";
    const english = [
      "Connect an AI client (MCP)",
      "Agent identity",
      "Town job",
      "Owner & agent account",
      "Agent name (required, 1-32)",
      "Owner name (required)",
      "Owner handle (required)",
      "Job (default herder)",
      "Register agent",
    ];
    for (const label of english) expect(text, label).toContain(label);

    for (const id of ["Pekerjaan", "Nama pemilik", "Daftar", "Akun pemilik"]) {
      expect(text, id).not.toContain(id);
    }
  });
});

describe("RegisterView submit", () => {
  it("posts the exact join payload once and shows the one-time token card", async () => {
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "ag123",
        token: TOKEN,
        resident: { id: "lm1", name: "Iris Reg", handle: "@irisreg", job: "herder" },
        owner: { name: "Ada Lovelace", handle: OWNER_HANDLE },
      }),
    );

    fillValid();
    await submit();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/agent/join");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["handle", "job", "name", "origin", "owner"]);
    expect(body.name).toBe("Iris Reg");
    expect(body.job).toBe("herder");
    expect(body.origin).toBe("web:register");
    expect(body.owner).toEqual({ name: "Ada Lovelace", handle: OWNER_HANDLE });
    expect(body.handle).toBe("@irisreg"); // auto-derived from the name until edited

    const card = host.querySelector('[data-section="result"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("SHOWN ONCE");
    expect(host.querySelector('[data-role="token"]')?.textContent).toBe(TOKEN);
  });

  it("shows the owner the server echoed back — what actually got persisted, not the draft", async () => {
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "ag2",
        token: TOKEN,
        resident: { id: "lm2", name: "Iris Reg", handle: "@irisreg", job: "herder" },
        owner: { name: "Grace Hopper", handle: `@grace${RUN}` },
      }),
    );

    fillValid(); // form draft says "Ada Lovelace" — the server answer must win
    await submit();

    const card = host.querySelector('[data-section="result"]');
    expect(card).not.toBeNull();
    const text = card!.textContent ?? "";
    expect(text).toContain("Grace Hopper");
    expect(text).toContain(`@grace${RUN}`);
    expect(text).not.toContain("Ada Lovelace");
  });

  it("surfaces the gateway message when join answers 400", async () => {
    fetchMock.mockResolvedValue(stub(400, { error: "name already taken" }));

    fillValid();
    await submit();

    expect(alertText()).toContain("name already taken");
    expect(host.querySelector('[data-section="result"]')).toBeNull();
  });

  it("surfaces the join rate limit when join answers 429", async () => {
    fetchMock.mockResolvedValue(stub(429, { error: "rate limited, try again later" }));

    fillValid();
    await submit();

    expect(alertText()).toContain("join rate limit");
  });

  it("shows a network error when fetch rejects", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    fillValid();
    await submit();

    expect(alertText()).toContain("network error");
  });

  it("keeps the token out of web storage and the console across a successful submit", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    fetchMock.mockResolvedValue(
      stub(200, {
        agentId: "ag1",
        token: TOKEN,
        resident: { id: "lm1", name: "Iris Reg" },
        owner: { name: "Ada Lovelace", handle: OWNER_HANDLE },
      }),
    );

    fillValid();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    const btn = host.querySelector<HTMLButtonElement>('[data-submit="register"]')!;
    await act(async () => {
      btn.click();
      // during: the request is in flight, nothing may be persisted yet
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // after: the token card is up, storage still untouched
    expect(host.querySelector('[data-section="result"]')).not.toBeNull();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    // the component must not log; React framework noise is ignored
    const isReactNoise = (args: unknown[]) =>
      args.some((a) => typeof a === "string" && /(Warning:|deprecated|React\b)/.test(a));
    expect(logSpy.mock.calls.filter((c) => !isReactNoise(c))).toEqual([]);
    expect(errSpy.mock.calls.filter((c) => !isReactNoise(c))).toEqual([]);
  });

  it("does not call fetch when the owner fields are empty", async () => {
    act(() => {
      setInput("#reg-name", "Iris Reg");
      // owner name/handle intentionally left blank
    });
    await submit();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(alertText()).toContain("Owner name is required.");
  });
});

// review gap #5 — the MCP config helpers behind the section-1 copy buttons.
// These blocks get pasted into OTHER machines' configs, so each must be valid
// JSON, pin the given origin, carry the token when set, and never bake this dev
// box's absolute path into a copy-ready block.
type Json = Record<string, unknown>;

function dig(json: unknown, ...path: string[]): unknown {
  let cur: unknown = json;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

interface McpCase {
  label: string;
  build: (origin: string, token: string) => string;
  envPath: string[];
}

const MCP_CASES: McpCase[] = [
  { label: "openCodeConfig", build: openCodeConfig, envPath: ["mcp", "slopagentbook", "environment"] },
  { label: "claudeDesktopConfig", build: claudeDesktopConfig, envPath: ["mcpServers", "slopagentbook", "env"] },
  { label: "hermesConfig", build: hermesConfig, envPath: ["mcp", "slopagentbook", "env"] },
];

/** 07-AGENT-INTEGRATION.md §7.3 — the twelve tools the MCP server exposes. */
const EXPECTED_MCP_TOOLS = [
  "join_town", "world_status", "world_snapshot", "feed_recent", "who_is",
  "act", "say", "quests_list", "quest_claim", "events_since",
  "chat_send", "chat_history",
];

describe("MCP config helpers (mcpInfo)", () => {
  const ORIGIN = "https://hermes.example:8787";

  for (const c of MCP_CASES) {
    describe(c.label, () => {
      it("returns valid JSON with SLOPAGENTBOOK_URL pinned to the given origin", () => {
        const out = c.build(ORIGIN, TOKEN);
        const json = JSON.parse(out) as Json; // throws if the helper emits non-JSON
        expect(typeof json).toBe("object");
        const env = (dig(json, ...c.envPath) ?? {}) as Record<string, string>;
        expect(env.SLOPAGENTBOOK_URL).toBe(ORIGIN);
        expect(out).toContain("SLOPAGENTBOOK_URL");
      });

      it("embeds SLOPAGENTBOOK_TOKEN when a token is set, empty string when not", () => {
        const withToken = (dig(JSON.parse(c.build(ORIGIN, TOKEN)) as Json, ...c.envPath) ?? {}) as Record<string, string>;
        expect(withToken.SLOPAGENTBOOK_TOKEN).toBe(TOKEN);

        const without = (dig(JSON.parse(c.build(ORIGIN, "")) as Json, ...c.envPath) ?? {}) as Record<string, string>;
        expect(without.SLOPAGENTBOOK_TOKEN).toBe("");
      });

      it("keeps the stdio path a <repo> placeholder — no machine path baked in", () => {
        const out = c.build(ORIGIN, TOKEN);
        expect(MCP_STDIO_PATH).toBe("<repo>/mcp/dist/stdio.js");
        expect(out).toContain(MCP_STDIO_PATH);
        expect(out).toContain("<repo>");
        // regression: this dev box's absolute path must never reach a copy block
        expect(out).not.toContain("G:/PROJECT");
        expect(out).not.toContain("G:\\PROJECT");
      });
    });
  }

  it("MCP_TOOLS lists exactly the twelve §7.3 tools with unique names", () => {
    const names = MCP_TOOLS.map((t) => t.tool);
    expect(names).toHaveLength(EXPECTED_MCP_TOOLS.length);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual([...EXPECTED_MCP_TOOLS].sort());
    for (const t of MCP_TOOLS) {
      expect(t.fn.length).toBeGreaterThan(0);
      expect(["no", "optional", "required"]).toContain(t.token);
    }
  });
});

// bonus gap #1 — App.tsx must actually wire `#/register`. App boots EventSource
// + the snapshot store (too heavy to mount hermetically here), so this asserts
// the wiring at source level: import, render branch, nav link, allow-list entry.
describe("App wires the #/register route", () => {
  // import.meta.url is not a file:// URL under this jsdom setup (fileURLToPath
  // throws), and vitest runs with frontend/ as cwd — resolve from there instead
  const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

  it("imports RegisterView and renders it on the register page", () => {
    // route-level code splitting: views load lazily, so assert the lazy wiring
    expect(appSource).toMatch(/lazy\(\(\) => import\("\.\/views\/RegisterView\.js"\)/);
    expect(appSource).toMatch(/\{page === "register" && <RegisterView \/>\}/);
  });

  it("links the register nav item and keeps register in the unknown-page allow-list", () => {
    expect(appSource).toMatch(/<Link to="register"/);
    const allow = appSource.match(/!\[([^\]]*)\]\.includes\(page\)/);
    expect(allow, "unknown-page allow-list not found in App.tsx").not.toBeNull();
    expect(JSON.parse(`[${allow![1]}]`)).toContain("register");
  });
});
