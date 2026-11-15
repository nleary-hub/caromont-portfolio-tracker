import { execFileSync } from "node:child_process";
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

  it("drops Node's vm ExperimentalWarning and sends other Node warnings as warn", async () => {
    sent.length = 0;
    const trace = "\n(Use `node --trace-warnings ...` to show where the warning was created)";
    const keep = process.stderr.write;
    process.stderr.write = (() => true) as never;
    try {
      // Exactly what Node's warning handler prints, through the console.error the integration wrapped (see below).
      console.error(`(node:7) ExperimentalWarning: vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time${trace}`);
      console.error(`(node:7) MaxListenersExceededWarning: Possible EventEmitter memory leak detected.${trace}`);
    } finally {
      process.stderr.write = keep;
    }
    await Sentry.flush(2000);
    const all = sent.join("\n");
    expect(all).not.toContain("is an experimental feature");
    expect(all).toContain("Possible EventEmitter memory leak detected.");
    expect(all.match(/"level":"(warn|error)"/g)).toEqual(['"level":"warn"']);
  });

  it("Node still prints its process warnings through console.error, in the form the filter expects", () => {
    // A plain Node process (the test runner silences warnings in its own): if Node ever stops using console.error, or
    // changes the wording, this fails and the filter needs another look.
    const script = [
      "const seen = [];",
      "console.error = (...a) => seen.push(a.join(' '));",
      "process.emitWarning('vm.USE_MAIN_CONTEXT_DEFAULT_LOADER is an experimental feature and might change at any time', 'ExperimentalWarning');",
      "setImmediate(() => process.stdout.write(JSON.stringify(seen)));",
    ].join("\n");
    const seen = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" })) as string[];
    expect(seen).toHaveLength(1);
    expect(SentryScrub.NODE_VM_EXPERIMENTAL_WARNING.test(seen[0].trim())).toBe(true);
  });
});
