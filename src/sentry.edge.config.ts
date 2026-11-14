// Sentry on the edge runtime (loaded by src/instrumentation.ts). Settings and scrubbing live in SentryScrub.
import * as Sentry from "@sentry/nextjs";
import { SentryScrub } from "@/lib/errors/SentryScrub";

// Production warnings and errors (console.warn / console.error) also go to Sentry Logs, scrubbed by SentryScrub.log.
Sentry.init(SentryScrub.options({ logs: Sentry.consoleLoggingIntegration({ levels: [...SentryScrub.LOG_LEVELS] }) }));
