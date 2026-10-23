import { defineConfig } from "@playwright/test";

// Real-server checks of Admin > AI settings (tests/e2e): next dev with the local dev login and an in-memory Postgres,
// run as a preview deployment. Fictional emails and throwaway secrets only (scripts/e2e-ai-admin-server.mjs).
const port = process.env.E2E_PORT || "4183";

// All e2e files share one PGlite database on port 5439, so they must run one at a time (workers: 1).
export default defineConfig({
  testDir: "tests/e2e", testMatch: "*.spec.ts", fullyParallel: false, workers: 1, timeout: 180000,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", screenshot: "only-on-failure" },
  webServer: { command: "node scripts/e2e-ai-admin-server.mjs", url: `http://127.0.0.1:${port}/signin`, reuseExistingServer: false, timeout: 240000 },
});
