// Sentry in the browser. Settings and scrubbing live in SentryScrub (no personal data, no replay, no logs).
// Off unless NEXT_PUBLIC_SENTRY_DSN is set.
import * as Sentry from "@sentry/nextjs";
import { SentryScrub } from "@/lib/errors/SentryScrub";

Sentry.init(SentryScrub.options());

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
