import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { SentryScrub } from "@/lib/errors/SentryScrub";

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
    const out = SentryScrub.event(event);
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
});
