import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

type ServerModule = typeof import("../src/server.js");

let app: ServerModule["app"];
let mcpGatewayUrl: ServerModule["mcpGatewayUrl"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The Streamable HTTP transport only mounts when MCP_HTTP=1 is set at module
 * load, so this file opts in *before* the dynamic import — the route exists
 * here and nowhere else in the suite.
 */
describe("MCP Streamable HTTP mount", () => {
  beforeAll(async () => {
    process.env.MCP_HTTP = "1";
    const mod = await import("../src/server.js");
    app = mod.app;
    mcpGatewayUrl = mod.mcpGatewayUrl;

    // the mount is a floating dynamic import — poll until the route answers
    for (let i = 0; i < 80; i++) {
      if ((await request(app).get("/mcp")).status === 405) return;
      await sleep(25);
    }
    throw new Error("/mcp never mounted — MCP_HTTP=1 route is broken");
  }, 30000);

  afterAll(() => {
    delete process.env.MCP_HTTP;
  });

  it("answers 405 with Allow: POST instead of Express' 404 page", async () => {
    const res = await request(app).get("/mcp");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("POST");
    expect(res.body.error).toMatch(/method not allowed/i);
    // registering app.post only used to fall through to Express' own 404 HTML,
    // so the handler's 405 contract was unreachable through the mount
    expect(res.text).not.toMatch(/<!DOCTYPE html>/i);
  });

  it("serves tools/list over the mounted route", async () => {
    const res = await request(app)
      .post("/mcp")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as Array<{ name: string }>;
    // the mounted handler serves the SAME catalog as stdio: 12 tools, chat included
    expect(tools).toHaveLength(12);
    expect(tools.map((t) => t.name)).toContain("join_town");
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["chat_send", "chat_history"]));
  });

  it("targets this server's own port when SLOPAGENTBOOK_URL is unset", () => {
    const prevUrl = process.env.SLOPAGENTBOOK_URL;
    const prevPort = process.env.PORT;
    try {
      delete process.env.SLOPAGENTBOOK_URL;
      process.env.PORT = "3999";
      expect(mcpGatewayUrl()).toBe("http://localhost:3999");

      // an explicit URL still wins, and keeps the client's slash-free shape
      process.env.SLOPAGENTBOOK_URL = "http://other-town:7000/";
      expect(mcpGatewayUrl()).toBe("http://other-town:7000");

      // neither set -> the library default the client falls back to
      delete process.env.SLOPAGENTBOOK_URL;
      delete process.env.PORT;
      expect(mcpGatewayUrl()).toBe("http://localhost:3000");
    } finally {
      if (prevUrl === undefined) delete process.env.SLOPAGENTBOOK_URL;
      else process.env.SLOPAGENTBOOK_URL = prevUrl;
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }
  });
});
