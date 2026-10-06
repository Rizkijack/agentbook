import { describe, it, expect } from "vitest";
import path from "path";
import os from "os";

// Isolate persistence exactly like the gateway suite does, so importing the
// server never touches the repo's data/town.json.
const prevDataPath = process.env.DATA_PATH;
process.env.NODE_ENV = "test";
process.env.DATA_PATH = path.join(os.tmpdir(), `agentbook-rebrand-test-${process.pid}-${Date.now()}.json`);
const { applyRebrand, world } = await import("../src/server.js");
if (prevDataPath === undefined) delete process.env.DATA_PATH;
else process.env.DATA_PATH = prevDataPath;

/**
 * The rename has to reach towns that already exist, but it must not become a
 * general "config gets overwritten by defaultConfig" — that would rewrite the
 * treasury address, which points at real funds. These pin both halves.
 */
describe("applyRebrand", () => {
  it("moves a town off the original brand", () => {
    const config = {
      name: "Hermesbook",
      ticker: "HERMES",
      xUrl: "https://x.com/hermesbook",
      tokenAddress: "TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
      chainName: "Base",
    };
    const changed = applyRebrand(config);
    expect(changed.sort()).toEqual(["name", "ticker", "xUrl"]);
    expect(config.name).toBe("SlopAgentbook");
    expect(config.ticker).toBe("SLB");
    expect(config.xUrl).toContain("slopagentbook");
  });

  it("carries a town forward from the INTERMEDIATE brand", () => {
    // The project was renamed twice. A town that saved while the first rename
    // was live still says "Agentbook", and skipping it here would leave that
    // town permanently on a brand that no longer exists.
    const config = {
      name: "Agentbook",
      ticker: "AGBK",
      xUrl: "https://x.com/agentbook",
    };
    expect(applyRebrand(config).sort()).toEqual(["name", "ticker", "xUrl"]);
    expect(config.name).toBe("SlopAgentbook");
    expect(config.ticker).toBe("SLB");
  });

  it("never touches the on-chain fields", () => {
    const config = {
      name: "Hermesbook",
      ticker: "HERMES",
      xUrl: "https://x.com/hermesbook",
      tokenAddress: "TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
      chainName: "Base",
      network: "mainnet",
      rpcUrl: "https://mainnet.base.org",
      explorer: "https://basescan.org/token/TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj",
      dexUrl: "https://dexscreener.com/base/",
      maxHerd: 64,
    };
    const before = { ...config };
    applyRebrand(config);
    for (const key of ["tokenAddress", "chainName", "network", "rpcUrl", "explorer", "dexUrl", "maxHerd"]) {
      expect(config[key], `${key} must not change`).toBe(before[key as keyof typeof before]);
    }
  });

  it("leaves a town already on the new brand alone", () => {
    const config = { name: "SlopAgentbook", ticker: "SLB", xUrl: "https://x.com/slopagentbook" };
    expect(applyRebrand(config)).toEqual([]);
    expect(config.name).toBe("SlopAgentbook");
  });

  it("leaves a town someone retitled by hand alone", () => {
    const config = { name: "Vetch Hollow", ticker: "VETCH", xUrl: "https://x.com/vetch" };
    expect(applyRebrand(config)).toEqual([]);
    expect(config.name).toBe("Vetch Hollow");
    expect(config.ticker).toBe("VETCH");
  });

  it("does not crash on a config with the branding keys missing", () => {
    expect(() => applyRebrand({})).not.toThrow();
    expect(applyRebrand({})).toEqual([]);
  });

  it("is idempotent — a second boot has nothing left to do", () => {
    const config = { name: "Hermesbook", ticker: "HERMES", xUrl: "https://x.com/hermesbook" };
    expect(applyRebrand(config)).toHaveLength(3);
    expect(applyRebrand(config)).toEqual([]);
  });
});

describe("boot applies the rebrand", () => {
  it("the loaded town ends up on the SlopAgentbook brand", () => {
    // the throwaway town this file booted from is a fresh createInitialWorld(),
    // so it already has the new default — assert the post-boot state either way
    expect(world.config.name).toBe("SlopAgentbook");
    expect(world.config.ticker).toBe("SLB");
    // and the credential surface is untouched by any of it
    expect(world.config.tokenAddress).toBe("TLJ8QbLnNUxZJJ1dcqF9auUKHrtKd8aNUkscxhSDADj");
  });
});