import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { SentryScrub } from "@/lib/errors/SentryScrub";

type StreamedSpanJSON = Parameters<typeof SentryScrub.span>[0];
type Log = Parameters<typeof SentryScrub.log>[0];

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

  describe("warning and error logs", () => {
    const fake = { name: "ConsoleLogs" } as never;
    const keep = { dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, env: process.env.VERCEL_ENV, pub: process.env.NEXT_PUBLIC_VERCEL_ENV };
    const setEnv = (env: string | undefined) => {
      delete process.env.NEXT_PUBLIC_VERCEL_ENV;
      if (env === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = env;
    };
    beforeEach(() => SentryScrub.resetLogLimit());
    afterEach(() => {
      for (const [k, v] of [["NEXT_PUBLIC_SENTRY_DSN", keep.dsn], ["VERCEL_ENV", keep.env], ["NEXT_PUBLIC_VERCEL_ENV", keep.pub]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it("sends logs only from production, and only when the runtime asks for them", () => {
      const log = { level: "error", message: "boom" } as Log;
      setEnv("production");
      const prod = SentryScrub.options({ logs: fake });
      expect(prod.integrations).toEqual([fake]);
      expect(prod.beforeSendLog?.(log)).toMatchObject({ level: "error", message: "boom" });
      expect(SentryScrub.options().beforeSendLog?.(log)).toBeNull();
      expect("integrations" in SentryScrub.options()).toBe(false);
      for (const env of ["preview", "development", undefined]) {
        setEnv(env);
        const o = SentryScrub.options({ logs: fake });
        expect("integrations" in o, String(env)).toBe(false);
        expect(o.beforeSendLog?.(log), String(env)).toBeNull();
      }
    });

    it("keeps warn and error only", () => {
      for (const level of ["trace", "debug", "info", "fatal"] as const) expect(SentryScrub.log({ level, message: "x" } as Log), level).toBeNull();
      expect(SentryScrub.log({ level: "warn", message: "x" } as Log)?.level).toBe("warn");
      expect(SentryScrub.log({ level: "error", message: "x" } as Log)?.level).toBe("error");
      expect(SentryScrub.log({ level: "error", message: "  " } as Log)).toBeNull();
    });

    describe("a label followed by an object (console.error(label, { ... }) through the console integration)", () => {
      // The Nov 17, 2026 voice failure, as the integration formats it (example session id).
      const voice = `AI tools: voice connect failed ${JSON.stringify({ code: "connect_failed", sessionId: "a1b2c3d4-0000-4000-8000-000000000001", model: "gpt-live-1", status: 400, type: "invalid_request_error", errorCode: "invalid_value", message: "Instructions must not exceed 16384 tokens.", source: "server", api: "live" })}`;

      it("keeps the keys and safe values readable, where every key and value used to read [value]", () => {
        const out = SentryScrub.log({ level: "error", message: voice } as Log)!;
        expect(out.message.startsWith("AI tools: voice connect failed {")).toBe(true);
        const body = JSON.parse(out.message.slice(out.message.indexOf("{")));
        expect(body).toMatchObject({ code: "connect_failed", model: "gpt-live-1", status: 400, type: "invalid_request_error", errorCode: "invalid_value", source: "server", api: "live" });
        expect(body.message).toBe("Instructions must not exceed [number] tokens.");
        expect(out.message).not.toContain("[value]");
      });

      it("still filters sensitive keys and scrubs values like any other log", () => {
        const out = SentryScrub.log({ level: "error", message: voice } as Log)!;
        expect(out.message).toContain('"sessionId":"[filtered]"');
        expect(out.message).not.toContain("a1b2c3d4");
        const risky = SentryScrub.log({ level: "error", message: `Save failed ${JSON.stringify({ email: "pat@example.com", userName: "Pat Example", detail: "sent to pat@example.com", key: "sk-proj-EXAMPLEKEY-abcdefghijklmnop-WXYZ" })}` } as Log)!;
        expect(risky.message).not.toContain("pat@example.com");
        expect(risky.message).not.toContain("Pat Example");
        expect(risky.message).not.toContain("sk-proj");
        expect(risky.message).toContain('"detail":"sent to [email]"');
      });

      it("scrubs text that only looks like a label and an object as text, as before", () => {
        const out = SentryScrub.log({ level: "error", message: 'Bad input {"name": "Pat Example"' } as Log)!;
        expect(out.message).not.toContain("Pat Example");
        expect(SentryScrub.log({ level: "error", message: 'Two "quoted" words {not json}' } as Log)!.message).toBe('Two "[value]" words {not json}');
      });
    });

    describe("Node's own process warnings, which Node prints through console.error", () => {
      const trace = "\n(Use `node --trace-warnings ...` to show where the warning was created)";
      const vmWarning = (pid: number, name = "USE_MAIN_CONTEXT_DEFAULT_LOADER") =>
        `(node:${pid}) ExperimentalWarning: vm.${name} is an experimental feature and might change at any time`;

      it("drops the harmless vm ExperimentalWarning, with or without the trace hint", () => {
        for (const message of [vmWarning(7) + trace, vmWarning(8) + trace, vmWarning(7), vmWarning(12, "DONT_CONTEXTIFY") + trace, `${vmWarning(7)}${trace}\n`]) {
          expect(SentryScrub.log({ level: "error", message } as Log), message).toBeNull();
          expect(SentryScrub.log({ level: "warn", message } as Log), message).toBeNull();
        }
        // The hint names whatever started Node, not always "node".
        expect(SentryScrub.log({ level: "error", message: vmWarning(7) + trace.replace("node --", "node24 --") } as Log)).toBeNull();
      });

      it("keeps every other Node warning, sent as warn rather than error", () => {
        for (const message of [
          "(node:7) ExperimentalWarning: The Fetch API is an experimental feature. This feature could change at any time" + trace,
          "(node:7) ExperimentalWarning: vm.SourceTextModule is an experimental feature and might change at any time" + trace,
          "(node:7) [DEP0040] DeprecationWarning: The `punycode` module is deprecated." + trace,
          "(node:7) MaxListenersExceededWarning: Possible EventEmitter memory leak detected." + trace,
          "(node:7) Warning: Closing file descriptor 21 on garbage collection",
        ]) {
          const out = SentryScrub.log({ level: "error", message } as Log);
          expect(out, message).not.toBeNull();
          expect(out!.level, message).toBe("warn");
          expect(out!.severityNumber, message).toBe(13);
        }
      });

      it("does not drop a vm warning that carries anything else, and leaves app errors at error", () => {
        const extra = SentryScrub.log({ level: "error", message: `${vmWarning(7)}${trace}\nError: save failed` } as Log);
        expect(extra?.level).toBe("warn");
        const quoted = SentryScrub.log({ level: "error", message: `Import failed: ${vmWarning(7)}` } as Log);
        expect(quoted).toMatchObject({ level: "error" });
        expect(SentryScrub.log({ level: "error", message: "ExperimentalWarning: vm.X is an experimental feature and might change at any time" } as Log)?.level).toBe("error");
        expect(SentryScrub.log({ level: "error", message: "Save failed" } as Log)).toMatchObject({ level: "error", severityNumber: undefined });
      });
    });

    it("scrubs the message and attributes like error events, and drops user and SDK internals", () => {
      const out = SentryScrub.log({
        level: "error",
        message: 'Save failed for "Pat Lee" pat.lee@example.org MRN 12345678 at https://app.example.org/x?name=Pat',
        attributes: {
          "sentry.environment": "production",
          "sentry.release": "abc123",
          "sentry.origin": "auto.log.console",
          "sentry.replay_id": "r1",
          "user.email": "pat.lee@example.org",
          "user.id": "u1",
          "sentry.message.template": "Save failed for {}",
          "sentry.message.parameter.0": "pat.lee@example.org",
          patientName: "Pat Lee",
          apiKey: "sk-live-abc",
          step: "save",
          count: 3,
          visits: 12345678,
          ok: false,
          nested: { email: "pat@example.org", reason: 'quoted "Valve Clinic"', deep: { deeper: { deepest: { x: 1 } } } },
        },
      } as Log)!;
      expect(out.message).toBe('Save failed for "[value]" [email] MRN [number] at https://app.example.org/x');
      const a = out.attributes!;
      expect(a["sentry.environment"]).toBe("production");
      expect(a["sentry.release"]).toBe("abc123");
      expect(a["sentry.origin"]).toBe("auto.log.console");
      expect(a["sentry.replay_id"]).toBeUndefined();
      expect(a["user.email"]).toBeUndefined();
      expect(a["user.id"]).toBeUndefined();
      expect(a["sentry.message.template"]).toBe("Save failed for {}");
      expect(a["sentry.message.parameter.0"]).toBe("[email]");
      expect(a.patientName).toBe("[filtered]");
      expect(a.apiKey).toBe("[filtered]");
      expect(a.step).toBe("save");
      expect(a.count).toBe(3);
      expect(a.visits).toBe("[number]");
      expect(a.ok).toBe(false);
      expect(a.nested).toEqual({ email: "[filtered]", reason: 'quoted "[value]"', deep: { deeper: { deepest: "[object]" } } });
      expect(JSON.stringify(out)).not.toMatch(/Pat|pat\.lee|12345678|sk-live/);
    });

    it("keeps the keys of ReportLog's JSON lines and scrubs their values", () => {
      const line = JSON.stringify({ scope: "report", level: "error", event: "drive.check.failed", folderId: "1AbCdEfGhIjKlMnOpQrStUvWxYz", cookie: "present", error: 'File "Q3 Pat Lee.pdf" not found' });
      expect(JSON.parse(SentryScrub.log({ level: "error", message: line } as Log)!.message as string)).toEqual({
        scope: "report",
        level: "error",
        event: "drive.check.failed",
        folderId: "[token]",
        cookie: "[filtered]",
        error: 'File "[value]" not found',
      });
      expect(SentryScrub.logText("{not json", 300)).toBe("{not json");
    });

    it("caps long messages and the number of attributes", () => {
      const attributes = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`a${i}`, i]));
      const out = SentryScrub.log({ level: "warn", message: "word ".repeat(2_000), attributes } as Log)!;
      expect(String(out.message).length).toBe(SentryScrub.LOG_MESSAGE_MAX);
      expect(Object.keys(out.attributes!)).toHaveLength(SentryScrub.LOG_ATTRIBUTES_MAX);
    });

    it("sends at most LOGS_PER_MINUTE logs a minute from one instance", () => {
      const log = () => ({ level: "error", message: "loop" }) as Log;
      const t = 1_000_000;
      for (let i = 0; i < SentryScrub.LOGS_PER_MINUTE; i++) expect(SentryScrub.log(log(), t)).not.toBeNull();
      expect(SentryScrub.log(log(), t + 1)).toBeNull();
      expect(SentryScrub.log(log(), t + 60_000)).not.toBeNull();
    });
  });

  it("registers the span scrubber", () => {
    expect(typeof SentryScrub.options().beforeSendSpan).toBe("function");
  });
});
