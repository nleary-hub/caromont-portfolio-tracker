import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { SentryScrub } from "@/lib/errors/SentryScrub";

type StreamedSpanJSON = Parameters<typeof SentryScrub.span>[0];

describe("SentryScrub", () => {
  it("turns off every data category Sentry v11 collects by default", () => {
    const d = SentryScrub.DATA_COLLECTION;
    expect(d.userInfo).toBe(false);
    expect(d.cookies).toBe(false);
    expect(d.httpHeaders).toBe(false);
    expect(d.httpBodies).toEqual([]);
    expect(d.urlQueryParams).toBe(false);
    expect(d.genAI).toEqual({ inputs: false, outputs: false });
    expect(d.mcp).toEqual({ inputs: false, outputs: false });
    expect(d.databaseQueryData).toBe(false);
    expect(d.stackFrameVariables).toBe(false);
  });

  it("keeps Sentry off without a DSN, with a low trace rate and no logs or metrics", () => {
    const prev = process.env.NEXT_PUBLIC_SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    const o = SentryScrub.options();
    expect(o.enabled).toBe(false);
    expect(o.dsn).toBeUndefined();
    expect(o.tracesSampleRate).toBeLessThanOrEqual(0.1);
    expect(o.beforeSendLog?.({} as never)).toBeNull();
    expect(o.beforeSendMetric?.({} as never)).toBeNull();
    expect("replaysSessionSampleRate" in o).toBe(false);
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://k@o1.ingest.us.sentry.io/2";
    expect(SentryScrub.options().enabled).toBe(true);
    if (prev === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = prev;
  });

  it("strips user, request data, extras and frame variables, and scrubs messages", () => {
    const event = {
      type: undefined,
      user: { email: "pat.lee@example.org", ip_address: "10.0.0.1" },
      extra: { body: "secret note" },
      request: {
        method: "POST",
        url: "https://app.example.org/projects/clx123456789?name=Pat#x",
        cookies: { session: "abc" },
        headers: { cookie: "abc" },
        data: { note: "MRN 12345678" },
        query_string: "name=Pat",
      },
      message: 'Failed for "Pat Lee" pat.lee@example.org',
      exception: {
        values: [{ type: "Error", value: 'Project "Valve Clinic" MRN 12345678 failed', stacktrace: { frames: [{ filename: "a.js", vars: { name: "Pat" } }] } }],
      },
      breadcrumbs: [
        { category: "console", message: "patient Pat" },
        { category: "fetch", data: { url: "/api/x?email=pat@example.org", method: "GET", status_code: 500, body: "x" } },
      ],
    } as unknown as ErrorEvent;
    const out = SentryScrub.event(event)!;
    expect(out.user).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.request).toEqual({ method: "POST", url: "https://app.example.org/projects/:id" });
    expect(out.message).not.toContain("Pat");
    expect(out.message).not.toContain("@");
    const ex = out.exception!.values![0];
    expect(ex.value).toBe('Project "[value]" MRN [number] failed');
    expect(ex.stacktrace!.frames![0].vars).toBeUndefined();
    expect(out.breadcrumbs).toHaveLength(1);
    expect(out.breadcrumbs![0].data).toEqual({ url: "/api/x", method: "GET", status_code: 500 });
  });

  it("drops console and input breadcrumbs", () => {
    expect(SentryScrub.breadcrumb({ category: "console", message: "x" })).toBeNull();
    expect(SentryScrub.breadcrumb({ category: "ui.input", message: "x" })).toBeNull();
    expect(SentryScrub.breadcrumb({ category: "navigation", data: { from: "/a?x=1", to: "/projects/abc123456" } })?.data).toEqual({ from: "/a", to: "/projects/:id" });
  });

  it("hides signed report-link tokens and long path segments in URLs", () => {
    expect(SentryScrub.url("https://app.example.org/api/share/eyJzbmFwIjoiYWJjIn0.c2lnbmF0dXJl/pdf?x=1")).toBe("https://app.example.org/api/share/:token/:file");
    expect(SentryScrub.url("/api/share/abcdefgh.ijkl")).toBe("/api/share/:token");
    expect(SentryScrub.url("/oauth/authorize")).toBe("/oauth/authorize");
    expect(SentryScrub.url("/x/abcdefghijklmnopqrstuvwxyz")).toBe("/x/:token");
  });

  it("scrubs URLs and paths in sampled spans", () => {
    const span = {
      trace_id: "t",
      span_id: "s",
      name: "GET /api/share/eyJzbmFwIjoiYWJjIn0.c2lnbmF0dXJl/handoff",
      start_timestamp: 0,
      status: "ok",
      is_segment: true,
      attributes: {
        "url.full": "https://app.example.org/api/share/eyJzbmFwIjoiYWJjIn0.c2lnbmF0dXJl/pdf?email=pat@example.org",
        "http.target": "/projects/clx123456789?name=Pat",
        "http.request.method": "GET",
        "http.response.status_code": 200,
      },
    } as unknown as StreamedSpanJSON;
    const out = SentryScrub.span(span);
    expect(out.name).toBe("GET /api/share/:token/:file");
    expect(out.attributes["url.full"]).toBe("https://app.example.org/api/share/:token/:file");
    expect(out.attributes["http.target"]).toBe("/projects/:id");
    expect(out.attributes["http.request.method"]).toBe("GET");
    expect(out.attributes["http.response.status_code"]).toBe(200);
  });

  describe("the MCP newer-version probe (Sentry CAROMONT-PORTFOLIO-TRACKER-1)", () => {
    const SUPPORTED = "2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07";
    const mcp = (value: string, mechanism = "auto.ai.mcp_server") =>
      ({ type: undefined, exception: { values: [{ type: "Error", value, mechanism: { type: mechanism, handled: false } }] } }) as unknown as ErrorEvent;
    const rejected = (version: string) => `Bad Request: Unsupported protocol version: ${version} (supported versions: ${SUPPORTED})`;

    it("drops the 400 a dual-era client gets when it tries the 2026-07-28 protocol first", () => {
      expect(SentryScrub.isMcpNewerVersionProbe(mcp(rejected("2026-07-28")))).toBe(true);
      expect(SentryScrub.event(mcp(rejected("2026-07-28")))).toBeNull();
      expect(SentryScrub.options().beforeSend?.(mcp(rejected("2026-07-28")), {})).toBeNull();
    });

    it("still reports an older, unknown or malformed version", () => {
      for (const v of ["2024-01-01", "2025-11-25", "1.0", "latest", "2026-7-28", "<script>"]) {
        expect(SentryScrub.isMcpNewerVersionProbe(mcp(rejected(v))), v).toBe(false);
        expect(SentryScrub.event(mcp(rejected(v))), v).not.toBeNull();
      }
    });

    it("still reports the same text from anywhere but the MCP transport, and every other MCP error", () => {
      expect(SentryScrub.event(mcp(rejected("2026-07-28"), "generic"))).not.toBeNull();
      expect(SentryScrub.event(mcp("Not Acceptable: Client must accept text/event-stream"))).not.toBeNull();
      expect(SentryScrub.event(mcp("Bad Request: Unsupported protocol version: 2026-07-28 (supported versions: )"))).not.toBeNull();
      const two = mcp(rejected("2026-07-28"));
      two.exception!.values!.push({ type: "Error", value: "Database down" });
      expect(SentryScrub.event(two)).not.toBeNull();
    });
  });

  it("registers the span scrubber", () => {
    expect(typeof SentryScrub.options().beforeSendSpan).toBe("function");
  });
});
