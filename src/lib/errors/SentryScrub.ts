import type * as Sentry from "@sentry/nextjs";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { ClientErrorScrub } from "@/lib/errors/ClientErrorScrub";

type Options = NonNullable<Parameters<typeof Sentry.init>[0]>;
type StreamedSpanJSON = Parameters<NonNullable<Options["beforeSendSpan"]>>[0];

/**
 * Sentry settings shared by the browser, server and edge setups (instrumentation-client.ts, sentry.server.config.ts,
 * sentry.edge.config.ts). Sentry SDK v11 collects everything by default (user, cookies, headers, request and response
 * bodies, AI prompts, database values), so every category is turned off here, and each error is scrubbed again with
 * the same rules as the app's own client error reports before it leaves: message, stack and route path only.
 */
export class SentryScrub {
  static readonly TRACES_SAMPLE_RATE = 0.05;

  /** Nothing about people, requests or data: only what helps find the bug. */
  static readonly DATA_COLLECTION: NonNullable<Options["dataCollection"]> = {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
  };

  /** The DSN, or undefined (Sentry then stays off and sends nothing). */
  static dsn(): string | undefined {
    const v = process.env.NEXT_PUBLIC_SENTRY_DSN;
    return v && v.trim() ? v.trim() : undefined;
  }

  /** Options every runtime passes to Sentry.init. */
  static options(): Options {
    const dsn = SentryScrub.dsn();
    return {
      dsn,
      enabled: Boolean(dsn),
      environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV,
      tracesSampleRate: SentryScrub.TRACES_SAMPLE_RATE,
      dataCollection: SentryScrub.DATA_COLLECTION,
      maxBreadcrumbs: 30,
      beforeSend: (event) => SentryScrub.event(event),
      beforeBreadcrumb: (crumb) => SentryScrub.breadcrumb(crumb),
      beforeSendSpan: (span) => SentryScrub.span(span),
      // Errors only: no logs or metrics leave the app.
      beforeSendLog: () => null,
      beforeSendMetric: () => null,
    };
  }

  /**
   * The Claude connector's own version probe, which is expected and not a bug. MCP 2026-07-28 clients that also speak
   * the older handshake protocol ("dual-era") first send a request with a newer MCP-Protocol-Version header; a server on
   * 2025-11-25 or earlier answers 400 and the client falls back to initialize (spec: basic/versioning, Backward
   * Compatibility). The MCP SDK still reports that 400 through transport.onerror, which Sentry captures. Only a
   * well-formed version newer than every version the SDK lists is dropped; an older, unknown or malformed version is
   * still reported, as is every other MCP error.
   */
  static isMcpNewerVersionProbe(event: ErrorEvent): boolean {
    const values = event.exception?.values ?? [];
    if (values.length !== 1) return false;
    const ex = values[0];
    if (ex.mechanism?.type !== "auto.ai.mcp_server" || typeof ex.value !== "string") return false;
    const m = /^Bad Request: Unsupported protocol version: (\S+) \(supported versions: ([^)]*)\)$/.exec(ex.value);
    if (!m) return false;
    const date = /^\d{4}-\d{2}-\d{2}$/;
    const requested = m[1];
    const supported = m[2].split(",").map((v) => v.trim());
    if (!date.test(requested) || !supported.length || !supported.every((v) => date.test(v))) return false;
    // YYYY-MM-DD strings sort as dates.
    return supported.every((v) => requested > v);
  }

  /** An error event with anything that could be user data removed or replaced, or null for expected noise. */
  static event(event: ErrorEvent): ErrorEvent | null {
    if (SentryScrub.isMcpNewerVersionProbe(event)) return null;
    delete event.user;
    delete event.extra;
    if (event.request) {
      event.request = { method: event.request.method, url: event.request.url ? SentryScrub.url(event.request.url) : undefined };
    }
    if (event.transaction) event.transaction = ClientErrorScrub.route(event.transaction);
    if (event.message) event.message = ClientErrorScrub.text(event.message, ClientErrorScrub.MESSAGE_MAX);
    if (event.logentry) {
      event.logentry = { message: ClientErrorScrub.text(event.logentry.message ?? "", ClientErrorScrub.MESSAGE_MAX) };
    }
    for (const ex of event.exception?.values ?? []) {
      if (ex.value) ex.value = ClientErrorScrub.text(ex.value, ClientErrorScrub.MESSAGE_MAX);
      for (const frame of ex.stacktrace?.frames ?? []) delete frame.vars;
    }
    if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map((b) => SentryScrub.breadcrumb(b)).filter((b): b is Breadcrumb => b !== null);
    return event;
  }

  /** A breadcrumb with its message scrubbed and only safe fields kept. Console and input breadcrumbs are dropped. */
  static breadcrumb(crumb: Breadcrumb): Breadcrumb | null {
    if (crumb.category === "console" || crumb.category === "ui.input") return null;
    const out: Breadcrumb = { type: crumb.type, category: crumb.category, level: crumb.level, timestamp: crumb.timestamp };
    if (crumb.message) out.message = ClientErrorScrub.text(crumb.message, ClientErrorScrub.MESSAGE_MAX);
    const d = crumb.data;
    if (d) {
      const data: Record<string, unknown> = {};
      for (const k of ["url", "from", "to"] as const) if (typeof d[k] === "string") data[k] = SentryScrub.url(d[k]);
      if (typeof d.method === "string") data.method = d.method;
      if (typeof d.status_code === "number") data.status_code = d.status_code;
      out.data = data;
    }
    return out;
  }

  /** A sampled trace span: its name and every text attribute have URLs and paths scrubbed like event URLs. */
  static span(span: StreamedSpanJSON): StreamedSpanJSON {
    span.name = SentryScrub.inline(span.name);
    for (const [k, v] of Object.entries(span.attributes ?? {})) {
      if (typeof v === "string") span.attributes[k] = SentryScrub.inline(v);
    }
    return span;
  }

  /** Text with every URL or path in it (a word starting with "/" or "http") replaced by its scrubbed form. */
  static inline(raw: string): string {
    return raw.replace(/(?:https?:\/\/|\/)[^\s"'<>]*/g, (m) => SentryScrub.url(m));
  }

  /**
   * Origin (if any) plus the path with ids replaced; no query string or hash. Signed report links
   * (/api/share/<token>/<file>) and any other long path segment are replaced too, because they work without sign-in.
   */
  static url(raw: string): string {
    const origin = /^https?:\/\/[^/?#]+/.exec(raw)?.[0] ?? "";
    const segs = ClientErrorScrub.route(raw).split("/");
    for (let i = 0; i < segs.length; i++) {
      if (segs[i - 2] === "api" && segs[i - 1] === "share") {
        segs[i] = ":token";
        if (i + 1 < segs.length) segs[i + 1] = ":file";
        break;
      }
    }
    return origin + segs.map((seg) => (seg.length >= 20 ? ":token" : seg)).join("/");
  }
}
