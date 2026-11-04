import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const REPORT_FONTS = ["./src/lib/report/fonts/**/*"];

const nextConfig: NextConfig = {
  // Pure-JS PDF renderer; load it from node_modules at runtime instead of bundling it.
  serverExternalPackages: ["@react-pdf/renderer"],
  // The PDF renderer reads the embedded Inter fonts from disk; trace them into every function that renders.
  outputFileTracingIncludes: {
    "/api/cron/freeze": REPORT_FONTS,
    "/api/reports/preview": REPORT_FONTS,
    "/reports": REPORT_FONTS,
  },
  // Security mitigation: serve images as-is so the /_next/image optimizer (outside auth in src/proxy.ts) does nothing.
  images: { unoptimized: true },
};

// Sentry build step. Source maps upload only when SENTRY_AUTH_TOKEN is set (a build secret in Vercel); without it,
// source map handling is off and the build is unchanged apart from the SDK.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN || undefined;

export default withSentryConfig(nextConfig, {
  org: "nick-qo",
  project: "caromont-portfolio-tracker",
  authToken: sentryAuthToken,
  sourcemaps: { disable: !sentryAuthToken },
  release: { create: Boolean(sentryAuthToken) },
  widenClientFileUpload: true,
  telemetry: false,
  silent: !process.env.CI,
});
