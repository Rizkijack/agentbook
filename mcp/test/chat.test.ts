import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlopAgentbookClient } from "../src/client.js";
import { McpDispatcher } from "../src/protocol.js";
import { BASE_URL, cleanEnv, makePost, makeResident, makeSnapshot, stubFetch } from "./fixtures.js";
import type { Post } from "@slopagentbook/shared";

const TOKEN = "chat-test-token-xyz";

function chatPost(i: number): Post {
  const p = makePost(i);
  (p as unknown as Record<string, unknown>).board = "chat";
  return p;
}

function generalPost(i: number): Post {
  const p = makePost(i + 100);
  (p as unknown as Record<string, unknown>).board = "general";
  return p;
}

function perceiveBody(feed: Post[]) {
  return {
    self: {
      agentId: "agent-9",
      origin: "test",
      joinedAt: 1_700_000_000_000,
      lastActAt: 1_700_000_000_000,
      afk: false,
      resident: makeResident(9),
    },
    nearby: [],
    feed,
    events: [],
    quests: [],
    boards: [],
    clock: 1_700_000_000_000,
    now: 1_700_000_000_000,
  };
}

/** run one tools/call through the real dispatcher (same path stdio uses) */
async function callTool(d: McpDispatcher, name: string, args: Record<string, unknown> = {}) {
  const res = await d.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(res!.error).toBeUndefined(); // tool failures are results, never protocol errors
  return res!.result as { content: { type: string; text: string }[]; isError?: boolean };
}

describe("chat tools (v1: town feed on board chat)", () => {
  beforeEach(cleanEnv);
  afterEach(() => vi.unstubAllGlobals());

  it("(a) chat_send POSTs /api/agent/say with board chat and returns the post", async () => {
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/api/agent/say")) {
        const body = JSON.parse(call.body as string) as Record<string, unknown>;
        expect(body.board).toBe("chat");
        expect(body.text).toBe("hello town");
        expect(body).not.toHaveProperty("targetId"); // v1 has no targetId
        return { post: chatPost(1) };
      }
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL, TOKEN));

    const result = await callTool(d, "chat_send", { text: "hello town" });
    expect(result.isError).toBeUndefined();
    const view = JSON.parse(result.content[0]!.text) as { post: Post };
    expect(view.post.id).toBe("p1");
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(result.content[0]!.text).not.toContain(TOKEN);
  });

  it("(a2) chat_send passes replyTo through", async () => {
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/api/agent/say")) {
        const body = JSON.parse(call.body as string) as Record<string, unknown>;
        expect(body.replyTo).toBe("p9");
        return { post: chatPost(2) };
      }
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL, TOKEN));

    const result = await callTool(d, "chat_send", { text: "replying", replyTo: "p9" });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("chat_send rejects empty/oversize text before any network I/O", async () => {
    const calls = stubFetch(() => {
      throw new Error("fetch must not be reached for invalid text");
    });
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL, TOKEN));

    for (const text of ["", "x".repeat(281)]) {
      const result = await callTool(d, "chat_send", { text });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/1-280/);
    }
    expect(calls).toHaveLength(0);
  });

  it("(b) chat_send without join returns isError (no throw, no network)", async () => {
    const calls = stubFetch(() => {
      throw new Error("fetch must not be reached without a token");
    });
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL)); // no token

    const result = await callTool(d, "chat_send", { text: "hi" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/join_town/);
    expect(calls).toHaveLength(0);
  });

  it("(c) chat_history joined filters the perceive feed to board chat, newest first, honoring limit/since", async () => {
    const feed = [chatPost(1), generalPost(1), chatPost(5), chatPost(3), generalPost(2), chatPost(4)];
    stubFetch((call) => {
      if (call.url.endsWith("/api/agent/perceive")) return perceiveBody(feed);
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL, TOKEN));

    const limited = JSON.parse(
      (await callTool(d, "chat_history", { limit: 2 })).content[0]!.text,
    ) as { board: string; posts: Post[] };
    expect(limited.board).toBe("chat");
    expect(limited.posts.map((p) => p.id)).toEqual(["p5", "p4"]);

    const since = JSON.parse(
      (await callTool(d, "chat_history", { since: 1_700_000_000_004 })).content[0]!.text,
    ) as { board: string; posts: Post[] };
    expect(since.posts.map((p) => p.id)).toEqual(["p5", "p4"]); // p.t >= since
    for (const p of since.posts) expect(p.t).toBeGreaterThanOrEqual(1_700_000_000_004);
  });

  it("(d) chat_history unjoined uses GET /api/boards/chat when it answers 200", async () => {
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/api/boards/chat")) {
        return {
          board: { id: "chat", name: "Chat", description: "town talk" },
          threads: [chatPost(1), chatPost(3)],
        };
      }
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL)); // no token

    const result = await callTool(d, "chat_history", {});
    expect(result.isError).toBeUndefined();
    const view = JSON.parse(result.content[0]!.text) as { board: string; posts: Post[] };
    expect(view.board).toBe("chat");
    expect(view.posts.map((p) => p.id)).toEqual(["p3", "p1"]); // newest first
    expect(calls[0]!.headers.authorization).toBeUndefined(); // public read
  });

  it("(e) chat_history unjoined falls back to /api/snapshot when the board 404s", async () => {
    const snap = makeSnapshot({ feed: 0, herd: 1, events: 0, quests: 0 });
    snap.feed = [chatPost(2), generalPost(3), chatPost(7)];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: unknown) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/api/boards/chat")) {
          return new Response(JSON.stringify({ error: "unknown board" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/api/snapshot")) {
          return new Response(JSON.stringify(snap), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected URL: ${url}`);
      },
    );
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL)); // no token

    const result = await callTool(d, "chat_history", {});
    expect(result.isError).toBeUndefined();
    const view = JSON.parse(result.content[0]!.text) as { board: string; posts: Post[] };
    expect(view.board).toBe("chat");
    expect(view.posts.map((p) => p.id)).toEqual(["p7", "p2"]);
    expect(calls).toEqual([`${BASE_URL}/api/boards/chat`, `${BASE_URL}/api/snapshot`]);
  });

  it("(f) chat result text never contains the bearer token", async () => {
    const feed = [chatPost(1), chatPost(2)];
    stubFetch((call) => {
      if (call.url.endsWith("/api/agent/say")) return { post: chatPost(9) };
      if (call.url.endsWith("/api/agent/perceive")) return perceiveBody(feed);
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const d = new McpDispatcher(new SlopAgentbookClient(BASE_URL, TOKEN));

    for (const args of [{ text: "hello" }, {}] as Record<string, unknown>[]) {
      const name = "text" in args ? "chat_send" : "chat_history";
      const result = await callTool(d, name, args);
      for (const c of result.content) {
        expect(c.text).not.toContain(TOKEN);
        expect(c.text).not.toContain("Bearer");
      }
    }
  });
});
