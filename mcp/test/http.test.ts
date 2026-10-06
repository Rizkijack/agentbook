import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMcpHttpHandler, type HttpReqLike, type HttpResLike } from "../src/http.js";
import { McpDispatcher } from "../src/protocol.js";
import { SlopAgentbookClient } from "../src/client.js";
import { TOOLS } from "../src/tools.js";
import { RESOURCES } from "../src/resources.js";
import { stubFetch, cleanEnv, JOIN_RESULT } from "./fixtures.js";

function fakeRes() {
  let statusCode = 0;
  let headers: Record<string, string> = {};
  let body: unknown = undefined;
  const res = {
    get statusCode() {
      return statusCode;
    },
    status(v: number) {
      statusCode = v;
      return res;
    },
    set(field: string, value: string) {
      headers[field] = value;
      return res;
    },
    get headers() {
      return headers;
    },
    json(b: unknown) {
      body = b;
      return res;
    },
    end() {
      return res;
    },
    get body() {
      return body;
    },
  };
  return res as unknown as HttpResLike;
}

function reqOf(method: string, body?: unknown): HttpReqLike {
  return { method, body };
}

function posted(payload: unknown) {
  return reqOf("POST", typeof payload === "string" ? payload : JSON.stringify(payload));
}

describe("MCP Streamable HTTP transport (stateless)", () => {
  it("initialize + tools/list over POST returns serverInfo and the same 12 tools as stdio", async () => {
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));

    const initRes = fakeRes();
    await handler(posted({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } }), initRes);
    expect(initRes.statusCode).toBe(200);
    const initBody = initRes.body as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(initBody.result.serverInfo.name).toBe("slopagentbook-mcp");

    const listRes = fakeRes();
    await handler(posted({ jsonrpc: "2.0", id: 2, method: "tools/list" }), listRes);
    const listBody = listRes.body as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));

    const resRes = fakeRes();
    await handler(posted({ jsonrpc: "2.0", id: 3, method: "resources/list" }), resRes);
    const resBody = resRes.body as { result: { resources: Array<{ uri: string }> } };
    expect(resBody.result.resources.map((r) => r.uri)).toEqual(RESOURCES.map((r) => r.uri));
  });

  it("is stateless: two requests in a row both answer without a session handshake", async () => {
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));
    for (let i = 0; i < 2; i++) {
      const res = fakeRes();
      await handler(posted({ jsonrpc: "2.0", id: i, method: "tools/list" }), res);
      expect(res.statusCode).toBe(200);
    }
  });

  it("GET /mcp is rejected with 405 + Allow header", async () => {
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));
    const res = fakeRes();
    await handler(reqOf("GET"), res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("a notification answers 202 with no body", async () => {
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));
    const res = fakeRes();
    await handler(posted({ jsonrpc: "2.0", method: "notifications/initialized" }), res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toBeUndefined();
  });

  it("a batch of mixed request+notification returns only the request replies", async () => {
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));
    const res = fakeRes();
    await handler(
      posted([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]),
      res
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as Array<{ id: number }>;
    expect(body).toHaveLength(2);
    expect(body.map((b) => b.id)).toEqual([1, 2]);
  });

  it("invalid JSON answers the JSON-RPC parse error, and unknown tools stay a protocol error", async () => {
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));
    const res = fakeRes();
    await handler(posted("{not json"), res);
    expect(res.statusCode).toBe(200);
    expect((res.body as { error: { code: number } }).error.code).toBe(-32700);

    const toolRes = fakeRes();
    await handler(
      posted({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nope", arguments: {} } }),
      toolRes
    );
    // unknown tools are a tool-level error (isError), not a JSON-RPC protocol error
    const toolBody = toolRes.body as { result?: { isError?: boolean } };
    expect(toolBody.result?.isError).toBe(true);
  });

  it("a failing tool does not crash the transport — an isError result comes back", async () => {
    // stub the GLOBAL fetch: SlopAgentbookClient calls it directly, so overriding
    // an instance property would be a no-op mock
    stubFetch(() => {
      throw new Error("boom");
    });
    const handler = createMcpHttpHandler(() => new SlopAgentbookClient("http://gw.test"));
    const res = fakeRes();
    await handler(posted({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "world_status", arguments: {} } }), res);
    expect(res.statusCode).toBe(200);
    const body = res.body as { error?: { code: number }; result?: { isError?: boolean } };
    if (body.error) expect(body.error.code).toBe(-32603);
    else expect(body.result?.isError).toBe(true);
  });
});

describe("protocol: stdio and http share the same dispatcher", () => {
  it("a direct McpDispatcher handle answers initialize the same way the transports do", async () => {
    const d = new McpDispatcher(new SlopAgentbookClient("http://gw.test"));
    const out = await d.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
    expect(out?.result).toMatchObject({ protocolVersion: "2024-11-05", serverInfo: { name: "slopagentbook-mcp" } });
  });
});

describe("MCP HTTP token isolation (security regression)", () => {
  beforeEach(cleanEnv);
  afterEach(() => vi.unstubAllGlobals());

  type ToolReply = { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } };

  /** factory that records every client the handler builds — one per request */
  function recordingHandler() {
    const created: SlopAgentbookClient[] = [];
    const handler = createMcpHttpHandler(() => {
      const c = new SlopAgentbookClient("http://gw.test");
      created.push(c);
      return c;
    });
    return { handler, created };
  }

  it("a later caller without credentials never inherits the previous caller's join token", async () => {
    const { handler, created } = recordingHandler();
    const calls = stubFetch((call) =>
      call.url.endsWith("/api/agent/join") ? JOIN_RESULT : { ok: true, order: {}, post: null },
    );

    // caller A joins — the token lands on A's request-scoped client
    const joinRes = fakeRes();
    await handler(
      posted({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "join_town", arguments: { name: "Caller A" } } }),
      joinRes,
    );
    const joinBody = joinRes.body as ToolReply;
    expect(joinBody.error).toBeUndefined();
    expect(JSON.parse(joinBody.result!.content[0]!.text).token).toBe(JOIN_RESULT.token);
    expect(created).toHaveLength(1);
    expect(created[0]!.token).toBe(JOIN_RESULT.token);

    // caller B, no Authorization header — must NOT ride on A's token
    const actRes = fakeRes();
    await handler(
      posted({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "act", arguments: { act: "work" } } }),
      actRes,
    );
    const actBody = actRes.body as ToolReply;
    expect(actBody.result?.isError).toBe(true);
    expect(actBody.result!.content[0]!.text).toMatch(/join_town/); // "…call join_town first…"
    expect(created).toHaveLength(2); // fresh client per request
    expect(created[1]).not.toBe(created[0]);
    expect(created[1]!.token).toBeUndefined(); // A's token is gone; env was cleaned
    expect(calls).toHaveLength(1); // B's act never reached the gateway at all
  });

  it("Authorization: Bearer supplies the token for exactly that request", async () => {
    const { handler, created } = recordingHandler();
    const calls = stubFetch(() => ({ ok: true, order: {}, post: null }));

    const actRes = fakeRes();
    await handler(
      {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "act", arguments: { act: "work", place: "square" } } }),
        headers: { authorization: `Bearer ${JOIN_RESULT.token}` },
      },
      actRes,
    );

    const body = actRes.body as ToolReply;
    expect(body.result?.isError).toBeUndefined();
    expect(created).toHaveLength(1);
    expect(created[0]!.token).toBe(JOIN_RESULT.token);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${JOIN_RESULT.token}`);
  });

  it("a batch shares one client: join_town then act inside the same request keep the token", async () => {
    const { handler, created } = recordingHandler();
    const calls = stubFetch((call) =>
      call.url.endsWith("/api/agent/join") ? JOIN_RESULT : { ok: true, order: {}, post: null },
    );

    const res = fakeRes();
    await handler(
      posted([
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "join_town", arguments: { name: "Caller A" } } },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "act", arguments: { act: "work", place: "square" } } },
      ]),
      res,
    );

    const replies = res.body as (ToolReply & { id: number })[];
    expect(Array.isArray(replies)).toBe(true);
    expect(replies).toHaveLength(2);
    expect(replies[1]!.result?.isError).toBeUndefined(); // act rode the join's token
    expect(created).toHaveLength(1); // one client for the whole batch
    const actCall = calls.find((c) => c.url.endsWith("/api/agent/act"));
    expect(actCall?.headers.authorization).toBe(`Bearer ${JOIN_RESULT.token}`);
  });
});
