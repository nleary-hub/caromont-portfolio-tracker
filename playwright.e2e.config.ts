import { defineConfig } from "@playwright/test";

// Real-server checks of Admin > AI settings (tests/e2e): next dev with the local dev login and an in-memory Postgres,
// run as a preview deployment. Fictional emails and throwaway secrets only (scripts/e2e-ai-admin-server.mjs).
export default defineConfig({
  testDir: "tests/e2e", testMatch: "*.spec.ts", fullyParallel: false, timeout: 180000,
  use: { baseURL: "http://127.0.0.1:4174", viewport: { width: 1440, height: 1000 }, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", screenshot: "only-on-failure" },
  webServer: { command: "node scripts/e2e-ai-admin-server.mjs", url: "http://127.0.0.1:4174/signin", reuseExistingServer: false, timeout: 240000 },
});
