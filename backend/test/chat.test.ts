import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import path from "path";
import os from "os";

// Isolate persistence: temp DATA_PATH so chat tests never touch data/town.json.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-chat-test-${process.pid}-${Date.now()}.json`);
const { app, world, DATA_PATH } = await import("../src/server.js");
const { createGatewayRouter } = await import("../src/gateway.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

const broadcasts: Array<Record<string, unknown>> = [];
const spyApp = express();
spyApp.use(express.json({ limit: "64kb" }));
spyApp.use(
  createGatewayRouter({
    world,
    broadcast: (m) => {
      broadcasts.push(m as Record<string, unknown>);
    },
    DATA_PATH,
  })
);

const joinName = "ChatAgent" + Date.now().toString().slice(-6);
let token = "";

describe("Chat board (town feed, board id 'chat')", () => {
  it("GET /api/boards includes chat", async () => {
    const res = await request(app).get("/api/boards");
    expect(res.status).toBe(200);
    const chat = res.body.find((b: { id: string }) => b.id === "chat");
    expect(chat).toBeTruthy();
    expect(chat.name).toBe("Chat");
  });

  it("GET /api/boards/chat returns 200 with threads", async () => {
    const res = await request(app).get("/api/boards/chat");
    expect(res.status).toBe(200);
    expect(res.body.board.id).toBe("chat");
    expect(Array.isArray(res.body.threads)).toBe(true);
  });

  it("joined agent POST /api/agent/say {board:'chat'} posts + broadcasts {type:'post'}", async () => {
    const join = await request(app)
      .post("/api/agent/join")
      .send({ name: joinName, bio: "chat tester", job: "scribe", traits: ["chatty"], origin: "vitest-chat" });
    expect(join.status).toBe(200);
    token = join.body.token;

    broadcasts.length = 0;
    const res = await request(spyApp)
      .post("/api/agent/say")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "hello from the chat board", board: "chat" });
    expect(res.status).toBe(200);
    expect(res.body.post.board).toBe("chat");
    expect((world.feed[0] as unknown as Record<string, unknown>).board).toBe("chat");
    expect(
      broadcasts.some(
        (b) => b.type === "post" && (b.post as Record<string, unknown>)?.board === "chat"
      )
    ).toBe(true);
  });

  it("unknown board still 400", async () => {
    const res = await request(spyApp)
      .post("/api/agent/say")
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "nope", board: "kabinet" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/board/);
  });

  it("GET /api/snapshot still redacts agents/tokenHash", async () => {
    const res = await request(app).get("/api/snapshot");
    expect(res.status).toBe(200);
    expect(res.body.agents).toBeUndefined();
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("sabk_");
  });
});
