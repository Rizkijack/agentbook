import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    setupFiles: ["test/setup-storage.ts"],
    environment: "jsdom",
    globals: true,
  },
});
