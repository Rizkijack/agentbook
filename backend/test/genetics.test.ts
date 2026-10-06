import { describe, it, expect } from "vitest";
import { Hc, rf, encodeGenes } from "@hermesbook/shared";

describe("backend genetics via shared", () => {
  it("rf deterministic", () => {
    const p = Hc("1.0.0.1.3.155.64.56.0");
    const c1 = rf(p, "MarrowJunior");
    const c2 = rf(p, "MarrowJunior");
    expect(encodeGenes(c1)).toBe(encodeGenes(c2));
  });
});
