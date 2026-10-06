import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlopAgentbookClient } from "../src/client.js";
import { McpDispatcher } from "../src/protocol.js";
import { BASE_URL, JOIN_RESULT, cleanEnv, makePost, makeSnapshot, stubFetch } from "./fixtures.js";
import { getTool } from "../src/tools.js";
import type { RecordedCall } from "./fixtures.js";

/** run one tools/call through the real dispatcher (same path stdio uses) */
async function callTool(d: McpDispatcher, name: string, args: Record<string, unknown> = {}) {
  const res = await d.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  expect(res!.error).toBeUndefined(); // tool failures are results, never protocol errors
  return res!.result as { content: { type: string; text: string }[]; isError?: boolean };
}

function parsed(result: { content: { type: string; text: string }[] }): Record<string, any> {
  return JSON.parse(result.content[0].text) as Record<string, any>;
}

function fresh(client = new SlopAgentbookClient(BASE_URL)): { d: McpDispatcher; client: SlopAgentbookClient } {
  return { d: new McpDispatcher(client), client };
}

describe("McpDispatcher — tool behavior (fetch stubbed)", () => {
  beforeEach(cleanEnv);
  afterEach(() => vi.unstubAllGlobals());

  it("world_snapshot trims a 400-post snapshot to ≤20 posts and drops heavy fields", async () => {
    const snapshot = makeSnapshot({ feed: 400, herd: 30, events: 120, quests: 10 });
    const raw = JSON.stringify(snapshot);
    expect(JSON.parse(raw).feed).toHaveLength(400); // sanity: the mock really is huge

    stubFetch((call) => {
      expect(call.url).toBe(`${BASE_URL}/api/snapshot`);
      return snapshot;
    });
    const { d } = fresh();

    const result = await callTool(d, "world_snapshot");
    expect(result.isError).toBeUndefined();

    const trimmedText = result.content[0].text;
    const view = parsed(result);
    expect(view.feed.length).toBeGreaterThan(0);
    expect(view.feed.length).toBeLessThanOrEqual(20);
    expect(view.herd.length).toBeLessThanOrEqual(20);
    expect(view.events.length).toBeLessThanOrEqual(10);
    // heavy / irrelevant fields never reach the model
    expect(view).not.toHaveProperty("editions");
    expect(view).not.toHaveProperty("projects");
    expect(view).not.toHaveProperty("agents");
    // size assertion: trimmed output is a small fraction of the raw snapshot
    expect(trimmedText.length).toBeLessThan(raw.length / 4);
    expect(view.note).toContain("Trimmed");
  });

  it("auth tools called without token return a formatted MCP error mentioning join_town (no crash)", async () => {
    const calls = stubFetch(() => {
      throw new Error("fetch must not be reached without a token");
    });
    const { d } = fresh();

    for (const name of ["act", "say", "quest_claim"] as const) {
      const result = await callTool(d, name, name === "say" ? { text: "hi" } : name === "act" ? { act: "work" } : { questId: "q1" });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toMatch(/join_town/); // "…call join_town first…"
      expect(result.content[0].text).toMatch(/SLOPAGENTBOOK_TOKEN/);
    }
    expect(calls).toHaveLength(0); // rejected before any network I/O — process survived
  });

  it("join_town POSTs /api/agent/join, caches the token and sends it as Bearer afterwards", async () => {
    const calls: RecordedCall[] = stubFetch((call) => {
      if (call.url.endsWith("/api/agent/join")) return JOIN_RESULT;
      if (call.url.endsWith("/api/agent/act")) return { order: null, post: null };
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const { d, client } = fresh();

    const join = await callTool(d, "join_town", { name: "Moe", job: "herder" });
    expect(join.isError).toBeUndefined();

    // endpoint contract
    expect(calls[0].url).toBe(`${BASE_URL}/api/agent/join`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.authorization).toBeUndefined(); // join itself is unauthenticated
    expect(JSON.parse(calls[0].body!).name).toBe("Moe");

    // token cached on the client
    expect(client.token).toBe(JOIN_RESULT.token);
    expect(client.agentId).toBe(JOIN_RESULT.agentId);

    // next authenticated call carries the cached token
    await callTool(d, "act", { act: "work" });
    expect(calls[1].url).toBe(`${BASE_URL}/api/agent/act`);
    expect(calls[1].method).toBe("POST");
    expect(calls[1].headers.authorization).toBe(`Bearer ${JOIN_RESULT.token}`);
  });

  it("events_since returns {events, posts, cursor} from the gateway", async () => {
    const calls = stubFetch((call) => {
      if (call.url.includes("/api/agent/events")) {
        return {
          events: [{ t: 1_700_000_000_001, kind: "act", text: "someone worked" }],
          posts: [makePost(1), makePost(2)],
          cursor: 1_700_000_000_999,
        };
      }
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const client = new SlopAgentbookClient(BASE_URL, "preloaded-token");
    const { d } = fresh(client);

    const result = await callTool(d, "events_since", { since: 1_700_000_000_000 });
    const view = parsed(result);
    expect(view.events).toHaveLength(1);
    expect(view.posts).toHaveLength(2);
    expect(view.cursor).toBe(1_700_000_000_999);
    expect(view.hint).toContain("cursor");
    // authenticated poll used the bearer token and passed `since`
    expect(calls[0].url).toBe(`${BASE_URL}/api/agent/events?since=1700000000000`);
    expect(calls[0].headers.authorization).toBe("Bearer preloaded-token");
  });

  it("unknown tool returns a formatted error listing the available tools", async () => {
    const { d } = fresh();
    const res = await d.handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } });
    const result = res!.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool");
    expect(result.content[0].text).toContain("join_town");
  });

  it("resources/read slopagentbook://boards returns JSON contents without auth", async () => {
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/api/boards")) return [{ id: "general", name: "General", description: "town talk" }];
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const { d } = fresh();

    const res = await d.handle({ jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "slopagentbook://boards" } });
    expect(res!.error).toBeUndefined();
    const contents = (res!.result as { contents: { uri: string; mimeType: string; text: string }[] }).contents;
    expect(contents[0].uri).toBe("slopagentbook://boards");
    expect(contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(contents[0].text)).toEqual([{ id: "general", name: "General", description: "town talk" }]);
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  it("world_status aggregates status + public quest list", async () => {
    const calls = stubFetch((call) => {
      if (call.url.endsWith("/api/status")) return { brain: "sim", herd: 12, feed: 34, llm: { calls: 1, failures: 0 } };
      if (call.url.endsWith("/api/quests")) return [];
      throw new Error(`unexpected URL: ${call.url}`);
    });
    const { d } = fresh();

    const view = parsed(await callTool(d, "world_status"));
    expect(view).toMatchObject({ brain: "sim", herd: 12, feed: 34, questsAvailable: 0 });
    expect(typeof view.clock).toBe("number");
    expect(calls).toHaveLength(2);
  });
});

describe("tool catalog contract", () => {
  it("quest_claim promises a COMPLETED quest, because that is all the gateway settles", () => {
    // claimQuest (backend/src/quests.ts) rejects anything but status
    // "completed" with a 400. Describing the tool as claiming an *available*
    // quest guarantees every agent fails its first call.
    const tool = getTool("quest_claim");
    expect(tool).toBeDefined();
    expect(tool!.description).toMatch(/completed quest/i);
    expect(tool!.description).not.toMatch(/available quest/i);
    expect(tool!.description).toMatch(/join_town/); // auth is still a prerequisite
  });

  it("every tool carries an input schema and a description", () => {
    for (const name of [
      "join_town", "world_status", "world_snapshot", "feed_recent", "who_is",
      "act", "say", "quests_list", "quest_claim", "events_since",
      "chat_send", "chat_history",
    ]) {
      const tool = getTool(name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(10);
      expect(tool!.inputSchema.type).toBe("object");
    }
    expect(getTool("nope")).toBeUndefined();
  });
});
