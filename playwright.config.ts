import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/browser", testMatch: "*.spec.ts", fullyParallel: false,
  use: { baseURL: "http://127.0.0.1:4173", viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", screenshot: "only-on-failure" },
  webServer: [
    { command: "node scripts/browser-fixture.mjs", url: "http://127.0.0.1:4173", reuseExistingServer: false },
    // VERCEL_ENV=preview for freeze-preview-guard.spec.ts only (it sets baseURL to this port).
    { command: "node scripts/browser-fixture.mjs", url: "http://127.0.0.1:4174", reuseExistingServer: false, env: { FIXTURE_PORT: "4174", VERCEL_ENV: "preview" } },
  ],
});
