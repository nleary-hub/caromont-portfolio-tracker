import { defineConfig } from "@playwright/test";

// FIXTURE_PORT / PREVIEW_FIXTURE_PORT: run beside another job's fixture servers (defaults 4173 and 4174).
const port = Number(process.env.FIXTURE_PORT || 4173);
const previewPort = Number(process.env.PREVIEW_FIXTURE_PORT || 4174);

export default defineConfig({
  testDir: "tests/browser", testMatch: "*.spec.ts", fullyParallel: false,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", screenshot: "only-on-failure" },
  webServer: [
    { command: "node scripts/browser-fixture.mjs", url: `http://127.0.0.1:${port}`, reuseExistingServer: false, env: { FIXTURE_PORT: String(port) } },
    // VERCEL_ENV=preview for freeze-preview-guard.spec.ts only (it sets baseURL to this port).
    { command: "node scripts/browser-fixture.mjs", url: `http://127.0.0.1:${previewPort}`, reuseExistingServer: false, env: { FIXTURE_PORT: String(previewPort), VERCEL_ENV: "preview" } },
  ],
});
