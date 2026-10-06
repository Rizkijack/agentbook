import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HermesbookClient } from "../src/client.js";
import { METHOD_NOT_FOUND, McpDispatcher, PROTOCOL_VERSION } from "../src/protocol.js";
import { cleanEnv } from "./fixtures.js";

const EXPECTED_TOOLS = [
  "join_town",
  "world_status",
  "world_snapshot",
  "feed_recent",
  "who_is",
  "act",
  "say",
  "quests_list",
  "quest_claim",
  "events_since",
];

const EXPECTED_RESOURCES = [
  "hermesbook://world",
  "hermesbook://feed",
  "hermesbook://quests",
  "hermesbook://boards",
];

function dispatcher(): McpDispatcher {
  // no token on purpose: list/initialize never need auth
  return new McpDispatcher(new HermesbookClient("http://gw.test"));
}

describe("McpDispatcher — protocol surface", () => {
  beforeEach(cleanEnv);
  afterEach(() => vi.unstubAllGlobals());

  it("initialize negotiates protocolVersion and serverInfo", async () => {
    const res = await dispatcher().handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(res).not.toBeNull();
    expect(res!.error).toBeUndefined();
    expect(res!.result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      serverInfo: { name: "hermesbook-mcp", version: "0.1.0" },
      capabilities: { tools: { listChanged: false } },
    });
  });

  it("tools/list returns exactly the 10 contracted tools", async () => {
    const res = await dispatcher().handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(res!.error).toBeUndefined();
    const tools = (res!.result as { tools: { name: string; description: string; inputSchema: { type: string } }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("resources/list returns exactly the 4 contracted resources", async () => {
    const res = await dispatcher().handle({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} });
    expect(res!.error).toBeUndefined();
    const resources = (res!.result as { resources: { uri: string; mimeType: string }[] }).resources;
    expect(resources.map((r) => r.uri)).toEqual(EXPECTED_RESOURCES);
    for (const r of resources) expect(r.mimeType).toBe("application/json");
  });

  it("notifications/initialized produces no response but flips the initialized flag", async () => {
    const d = dispatcher();
    expect(d.isInitialized).toBe(false);
    const res = await d.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res).toBeNull();
    expect(d.isInitialized).toBe(true);
  });

  it("unknown method returns METHOD_NOT_FOUND, never throws", async () => {
    const res = await dispatcher().handle({ jsonrpc: "2.0", id: 9, method: "does/not/exist", params: {} });
    expect(res!.error).toMatchObject({ code: METHOD_NOT_FOUND });
    expect(res!.id).toBe(9);
  });
});
