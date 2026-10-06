import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    // no sourcemaps in production: the 1.3MB .map was shipped in dist and
    // served to everyone for zero runtime benefit
    sourcemap: false,
  },
});
