import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { TZ: "UTC" },
    // The PGlite migration suites (0016 to 0019) each boot Postgres in WASM and replay the production fixture; run
    // in parallel they can pass 5 s on a loaded machine.
    testTimeout: 30000,
  },
});
