import type * as Sentry from "@sentry/nextjs";
import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";
import { ClientErrorRateLimit, ClientErrorScrub } from "@/lib/errors/ClientErrorScrub";

type Options = NonNullable<Parameters<typeof Sentry.init>[0]>;
type StreamedSpanJSON = Parameters<NonNullable<Options["beforeSendSpan"]>>[0];
type Integration = NonNullable<Extract<Options["integrations"], unknown[]>>[number];
type Log = Parameters<NonNullable<Options["beforeSendLog"]>>[0];

/**
 * Sentry settings shared by the browser, server and edge setups (instrumentation-client.ts, sentry.server.config.ts,
 * sentry.edge.config.ts). Sentry SDK v11 collects everything by default (user, cookies, headers, request and response
 * bodies, AI prompts, database values), so every category is turned off here, and each error is scrubbed again with
 * the same rules as the app's own client error reports before it leaves: message, stack and route path only. Server and
 * edge also send warning and error logs from production (console.warn, console.error, Sentry.logger.warn/error), scrubbed
 * the same way, because Vercel's runtime logs reach back only one hour.
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

  /** Only these log levels are kept (Vercel's runtime logs reach back one hour; Sentry keeps them longer). */
  static readonly LOG_LEVELS = ["warn", "error"] as const;
  /** Sentry's severity number for warn (OpenTelemetry's WARN). */
  static readonly WARN_SEVERITY = 13;
  /** Most logs one server instance sends per minute, so a loop can't use up the monthly log allowance. */
  static readonly LOGS_PER_MINUTE = 60;
  /** Most attributes kept per log besides the SDK's own, and the longest text kept in one attribute. */
  static readonly LOG_ATTRIBUTES_MAX = 20;
  static readonly LOG_VALUE_MAX = ClientErrorScrub.MESSAGE_MAX;
  /** A log message can hold an error's stack, so it gets the stack's length. */
  static readonly LOG_MESSAGE_MAX = ClientErrorScrub.STACK_MAX;
  /** Attributes the SDK adds that say nothing about people or data; kept as they are. */
  static readonly LOG_SDK_KEYS: ReadonlySet<string> = new Set([
    "sentry.environment",
    "sentry.release",
    "sentry.sdk.name",
    "sentry.sdk.version",
    "sentry.origin",
    "sentry.trace.parent_span_id",
  ]);
  /** A key whose value is replaced outright: credentials, contact details and anything naming a person or patient. */
  static readonly SENSITIVE_KEY = /pass|secret|token|key|auth|cookie|session|e-?mail|phone|mrn|ssn|dob|birth|name|note|body|prompt/i;
  private static logLimit = new ClientErrorRateLimit(SentryScrub.LOGS_PER_MINUTE, 60_000);
  /**
   * One of Node's own process warnings ("(node:7) DeprecationWarning: ..."). Node prints these through console.error,
   * so the console integration would file them as errors; they are sent as warnings instead.
   */
  static readonly NODE_WARNING = /^\(node:\d+\) (?:\[[A-Z]+\d+\] )?[A-Za-z]*Warning: /;
  /**
   * The one Node warning that is dropped: on Vercel's Node 24 servers, Node reports several times a day that a vm
   * constant (such as vm.USE_MAIN_CONTEXT_DEFAULT_LOADER) is experimental. Nothing in the app or its packages uses those
   * constants, so it comes from outside the app's code and there is nothing to fix. Only that exact warning, with
   * nothing else in the message, matches; every other warning is still sent.
   */
  static readonly NODE_VM_EXPERIMENTAL_WARNING =
    /^\(node:\d+\) ExperimentalWarning: vm\.[A-Z][A-Z0-9_]* is an experimental feature and might change at any time(?:\n\(Use `[^`\n]+ --trace-warnings \.\.\.` to show where the warning was created\))?$/;

  /**
   * Options every runtime passes to Sentry.init. Pass `logs` (the console logging integration) from the server and
   * edge setups to send warning and error logs; they leave only from production, scrubbed by SentryScrub.log. The
   * browser passes nothing and sends no logs. Metrics never leave the app.
   */
  static options(opts: { logs?: Integration } = {}): Options {
    const dsn = SentryScrub.dsn();
    const environment = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV;
    const logs = opts.logs && environment === "production" ? opts.logs : undefined;
    return {
      dsn,
      enabled: Boolean(dsn),
      environment,
      tracesSampleRate: SentryScrub.TRACES_SAMPLE_RATE,
      dataCollection: SentryScrub.DATA_COLLECTION,
      maxBreadcrumbs: 30,
      ...(logs ? { integrations: [logs] } : {}),
      beforeSend: (event) => SentryScrub.event(event),
      beforeBreadcrumb: (crumb) => SentryScrub.breadcrumb(crumb),
      beforeSendSpan: (span) => SentryScrub.span(span),
      beforeSendLog: logs ? (log) => SentryScrub.log(log) : () => null,
      beforeSendMetric: () => null,
    };
  }

  /** Starts a fresh per-minute log allowance (tests). */
  static resetLogLimit(): void {
    SentryScrub.logLimit = new ClientErrorRateLimit(SentryScrub.LOGS_PER_MINUTE, 60_000);
  }

  /**
   * A warning or error log scrubbed with the same rules as error events, or null to drop it: any other level, over the
   * per-minute allowance, empty, or Node's harmless vm ExperimentalWarning. Node's own process warnings go as warn, not
   * error. User attributes and SDK internals are dropped; every other attribute is scrubbed.
   */
  static log(log: Log, now = Date.now()): Log | null {
    if (!(SentryScrub.LOG_LEVELS as readonly string[]).includes(log.level)) return null;
    const raw = String(log.message ?? "");
    if (SentryScrub.NODE_VM_EXPERIMENTAL_WARNING.test(raw.trim())) return null;
    const nodeWarning = SentryScrub.NODE_WARNING.test(raw.trimStart());
    const message = SentryScrub.logText(raw, SentryScrub.LOG_MESSAGE_MAX);
    if (!message.trim()) return null;
    if (!SentryScrub.logLimit.allow("logs", now)) return null;
    const attributes: Record<string, unknown> = {};
    let kept = 0;
    for (const [k, v] of Object.entries(log.attributes ?? {})) {
      if (SentryScrub.LOG_SDK_KEYS.has(k)) {
        attributes[k] = v;
        continue;
      }
      if (k.startsWith("user.") || (k.startsWith("sentry.") && !k.startsWith("sentry.message."))) continue;
      if (kept >= SentryScrub.LOG_ATTRIBUTES_MAX) continue;
      const value = !k.startsWith("sentry.message.") && SentryScrub.SENSITIVE_KEY.test(k) ? "[filtered]" : SentryScrub.logValue(v, 0);
      if (value === undefined) continue;
      attributes[k] = value;
      kept += 1;
    }
    if (nodeWarning) return { level: "warn", message, attributes, severityNumber: SentryScrub.WARN_SEVERITY };
    return { level: log.level, message, attributes, severityNumber: log.severityNumber };
  }

  /**
   * Log text: a JSON object (ReportLog's one-line logs) keeps its keys with each value scrubbed. So does a JSON object
   * after a short label, the shape console.error("AI tools: ...", { code, status, message }) arrives in through the
   * console integration; before, the text scrubber turned every quoted key and value in it into "[value]". The label
   * is scrubbed as text, and sensitive keys (session, token, email, name and the like) are still filtered. Other text is
   * scrubbed whole.
   */
  static logText(raw: string, max: number): string {
    const t = raw.trim();
    const whole = SentryScrub.jsonObject(t);
    if (whole) return JSON.stringify(SentryScrub.logValue(whole, 0)).slice(0, max);
    const labelled = /^([^{}\n]{1,200}?)\s+(\{[\s\S]*\})$/.exec(t);
    const obj = labelled ? SentryScrub.jsonObject(labelled[2]) : null;
    if (labelled && obj) return `${ClientErrorScrub.text(labelled[1], ClientErrorScrub.MESSAGE_MAX)} ${JSON.stringify(SentryScrub.logValue(obj, 0))}`.slice(0, max);
    return ClientErrorScrub.text(raw, max);
  }

  /** The text parsed as a JSON object, or null when it is not one. */
  private static jsonObject(t: string): Record<string, unknown> | null {
    if (!(t.startsWith("{") && t.endsWith("}"))) return null;
    try {
      const parsed: unknown = JSON.parse(t);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      // Not JSON after all: scrub it as text.
      return null;
    }
  }

  /** One log value scrubbed: text like a message, numbers only when they can't be an identifier, objects key by key. */
  static logValue(v: unknown, depth: number): unknown {
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") return ClientErrorScrub.text(v, SentryScrub.LOG_VALUE_MAX);
    if (typeof v === "number" || typeof v === "bigint") {
      const s = String(v);
      return ClientErrorScrub.text(s, SentryScrub.LOG_VALUE_MAX) === s ? v : "[number]";
    }
    if (typeof v === "object") {
      if (depth >= 3) return "[object]";
      if (Array.isArray(v)) return v.slice(0, SentryScrub.LOG_ATTRIBUTES_MAX).map((x) => SentryScrub.logValue(x, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, SentryScrub.LOG_ATTRIBUTES_MAX)) {
        out[k] = SentryScrub.SENSITIVE_KEY.test(k) ? "[filtered]" : SentryScrub.logValue(x, depth + 1);
      }
      return out;
    }
    return undefined;
  }

  /**
   * The Claude connector's own version probe, which is expected and not a bug. MCP 2026-07-28 clients that also speak
   * the older handshake protocol ("dual-era") first send a request with a newer MCP-Protocol-Version header; a server on
   * 2025-11-25 or earlier answers 400 and the client falls back to initialize (spec: basic/versioning, Backward
   * Compatibility). The MCP SDK still reports that 400 through transport.onerror, which Sentry captures. Only a
   * well-formed version newer than every version the SDK lists is dropped; an older, unknown or malformed version is
   * still reported, as is every other MCP error. Since /api/mcp now answers the probe itself (McpHttp.newerVersionProbe)
   * the SDK no longer sees it; this filter stays as a backstop.
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
