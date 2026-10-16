/**
 * Client error reports keep only what helps find the bug: the error message, the stack and the route path.
 * Anything that could be user data (field values, names, emails, numbers, query strings, quoted text, tokens)
 * is replaced before the report leaves the browser, and again on the server.
 */
export interface ClientErrorReport {
  /** "error" (window.onerror), "rejection" (unhandledrejection) or "boundary" (error.tsx / global-error). */
  kind: "error" | "rejection" | "boundary";
  message: string;
  stack: string;
  /** Path only: no query string, no hash, ids replaced. */
  route: string;
}

export class ClientErrorScrub {
  static readonly MESSAGE_MAX = 300;
  static readonly STACK_MAX = 2000;
  static readonly ROUTE_MAX = 200;
  static readonly KINDS = ["error", "rejection", "boundary"] as const;

  /** Text of a message or a stack line with user data replaced. */
  static text(raw: unknown, max: number): string {
    let s = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
    s = s
      // URLs: keep origin and path, drop the query and hash.
      .replace(/(https?:\/\/[^\s?#'")]+)[?#][^\s'")]*?(?=:\d+:\d+|[\s'")]|$)/g, "$1")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
      // Quoted text is almost always a value (a field, a name, a note).
      .replace(/"(?:[^"\\\n]|\\.){0,500}"/g, '"[value]"')
      .replace(/'(?:[^'\\\n]|\\.){0,500}'/g, "'[value]'")
      .replace(/`[^`\n]{0,500}`/g, "`[value]`")
      // Long tokens (ids, secrets, base64) and numbers of 4+ digits (MRNs, phones, dates).
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[token]")
      .replace(/\d[\d\-/.: ]{2,}\d/g, (m) => (/\d{4,}|\d+[-/.: ]\d+[-/.: ]\d+/.test(m) ? "[number]" : m));
    return s.length > max ? s.slice(0, max) : s;
  }

  /** Route path only, with id-like segments replaced. */
  static route(raw: unknown): string {
    const s = typeof raw === "string" ? raw : "";
    let path = s.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0] || "/";
    if (!path.startsWith("/")) path = "/" + path;
    path = path
      .split("/")
      .map((seg) => (/\d/.test(seg) && seg.length >= 6 ? ":id" : seg.includes("@") ? ":email" : seg))
      .join("/");
    return path.slice(0, ClientErrorScrub.ROUTE_MAX);
  }

  /** A whole report, from any untrusted input. Unknown keys are dropped. */
  static report(input: unknown): ClientErrorReport {
    const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const kind = (ClientErrorScrub.KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as ClientErrorReport["kind"]) : "error";
    return {
      kind,
      message: ClientErrorScrub.text(o.message, ClientErrorScrub.MESSAGE_MAX),
      stack: ClientErrorScrub.text(o.stack, ClientErrorScrub.STACK_MAX),
      route: ClientErrorScrub.route(o.route),
    };
  }

  /** The report for a thrown value (Error or anything else). */
  static fromThrown(kind: ClientErrorReport["kind"], err: unknown, route: string): ClientErrorReport {
    const e = err instanceof Error ? err : null;
    return ClientErrorScrub.report({ kind, message: e ? `${e.name}: ${e.message}` : typeof err === "string" ? err : "Non-error value thrown", stack: e?.stack ?? "", route });
  }
}

/** Fixed-window limit per key (per server instance): enough to stop a loop from flooding the logs. */
export class ClientErrorRateLimit {
  static readonly MAX = 20;
  static readonly WINDOW_MS = 60_000;
  private readonly hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max = ClientErrorRateLimit.MAX,
    private readonly windowMs = ClientErrorRateLimit.WINDOW_MS,
  ) {}

  /** True when this report may be logged. */
  allow(key: string, now = Date.now()): boolean {
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (now - v.start >= this.windowMs) this.hits.delete(k);
    const cur = this.hits.get(key);
    if (!cur || now - cur.start >= this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.max;
  }
}
