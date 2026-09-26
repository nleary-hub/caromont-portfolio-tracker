import type { NextConfig } from "next";

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
};

export default nextConfig;
