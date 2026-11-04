// Next.js instrumentation hook: starts Sentry for the server runtime in use and reports errors from
// Server Components, route handlers, Server Actions and the proxy.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
}

export const onRequestError = Sentry.captureRequestError;
