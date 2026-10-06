import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: true,
    // Hermetic persistence: pin DATA_PATH to a throwaway town (see test/setup.ts)
    // unless the caller already pointed it somewhere. Without this the suite
    // reads the live data/town.json and its assertions depend on whatever the
    // saved herd happens to contain (e.g. a full 64/64 pasture).
    setupFiles: ["test/setup.ts"],
  },
});
