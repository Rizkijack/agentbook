import { describe, it, expect } from "vitest";
import { parseHash } from "../src/router/hash.js";

describe("parseHash", () => {
  it("defaults to town", () => {
    expect(parseHash("").page).toBe("town");
    expect(parseHash("#/").page).toBe("town");
    expect(parseHash("#/town").page).toBe("town");
  });
  it("parses llama id", () => {
    const r = parseHash("#/llama/xyz123");
    expect(r.page).toBe("llama");
    expect(r.arg).toBe("xyz123");
  });
  it("parses fork preset", () => {
    const r = parseHash("#/fork/lmmok2nae7");
    expect(r.page).toBe("fork");
    expect(r.arg).toBe("lmmok2nae7");
  });
});
