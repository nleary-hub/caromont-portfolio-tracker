import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { SentryScrub } from "@/lib/errors/SentryScrub";

// End to end through a real Sentry client: console.warn and console.error leave as scrubbed logs; info does not.
describe("Sentry warning and error logs (server setup)", () => {
  const sent: string[] = [];
  const prev = { dsn: process.env.NEXT_PUBLIC_SENTRY_DSN, env: process.env.VERCEL_ENV };

  beforeAll(() => {
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://k@o1.ingest.us.sentry.io/2";
    process.env.VERCEL_ENV = "production";
    SentryScrub.resetLogLimit();
    Sentry.init({
      ...SentryScrub.options({ logs: Sentry.consoleLoggingIntegration({ levels: [...SentryScrub.LOG_LEVELS] }) }),
      tracesSampleRate: 0,
      transport: (o: Parameters<typeof Sentry.createTransport>[0]) =>
        Sentry.createTransport(o, async (req) => {
          sent.push(typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body));
          return { statusCode: 200 };
        }),
    });
  });

  afterAll(async () => {
    await Sentry.close();
    for (const [k, v] of [["NEXT_PUBLIC_SENTRY_DSN", prev.dsn], ["VERCEL_ENV", prev.env]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sends warn and error, scrubbed, and nothing at info", async () => {
    // Call the console the integration wrapped (a spy would replace it); keep the test output quiet instead.
    const keep = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = (() => true) as never;
    process.stderr.write = (() => true) as never;
    try {
      console.info("Dashboard heartbeat changed by pat.lee@example.org");
      console.warn('Draft save failed for "Pat Lee" MRN 12345678');
      console.error("Admin action failed:", { email: "pat.lee@example.org", step: "save" });
    } finally {
      process.stdout.write = keep.out;
      process.stderr.write = keep.err;
    }
    await Sentry.flush(2000);
    const all = sent.join("\n");
    expect(all).toContain('Draft save failed for \\"[value]\\" MRN [number]');
    expect(all).toContain("Admin action failed:");
    expect(all).not.toContain("pat.lee");
    expect(all).not.toContain("Pat Lee");
    expect(all).not.toContain("12345678");
    expect(all).toContain("[filtered]");
    expect(all).not.toContain("heartbeat");
    // Only the two log lines left, at their own levels.
    expect(all.match(/"level":"(warn|error)"/g)).toEqual(['"level":"warn"', '"level":"error"']);
    expect(all).not.toMatch(/"level":"info"/);
  });
});
