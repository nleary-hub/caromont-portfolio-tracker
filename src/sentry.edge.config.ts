// Sentry on the edge runtime (loaded by src/instrumentation.ts). Settings and scrubbing live in SentryScrub.
import * as Sentry from "@sentry/nextjs";
import { SentryScrub } from "@/lib/errors/SentryScrub";

Sentry.init(SentryScrub.options());
