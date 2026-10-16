import { describe, expect, it, vi } from "vitest";
import { ClientErrorRateLimit, ClientErrorScrub } from "@/lib/errors/ClientErrorScrub";
import { POST } from "@/app/api/client-errors/route";

describe("ClientErrorScrub", () => {
  it("keeps the message shape but drops quoted values, emails, numbers and tokens", () => {
    const r = ClientErrorScrub.report({
      kind: "error",
      message: `TypeError: Cannot read "Fictional Patient Name" of jane.doe@example.org (MRN 4455667) token abcdefghijklmnopqrstuvwxyz0123`,
      stack: "TypeError: x\n    at save (https://app.example/_next/static/chunks/page.js?v=secret:1:2)",
      route: "/projects/abc123def456?q=private#x",
    });
    expect(r.message).toBe(`TypeError: Cannot read "[value]" of [email] (MRN [number]) token [token]`);
    expect(r.message).not.toContain("Fictional");
    expect(r.stack).toContain("https://app.example/_next/static/chunks/page.js:1:2");
    expect(r.stack).not.toContain("secret");
    expect(r.route).toBe("/projects/:id");
  });

  it("keeps only kind, message, stack and route, with length caps", () => {
    const r = ClientErrorScrub.report({ kind: "nope", message: "m".repeat(5000), stack: "s".repeat(9000), route: "x", values: { note: "secret" }, email: "a@b.co" });
    expect(Object.keys(r).sort()).toEqual(["kind", "message", "route", "stack"]);
    expect(r.kind).toBe("error");
    expect(r.message.length).toBeLessThanOrEqual(ClientErrorScrub.MESSAGE_MAX);
    expect(r.stack.length).toBeLessThanOrEqual(ClientErrorScrub.STACK_MAX);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("fromThrown handles Errors and non-errors", () => {
    expect(ClientErrorScrub.fromThrown("rejection", new RangeError("bad 'x'"), "/").message).toBe("RangeError: bad '[value]'");
    expect(ClientErrorScrub.fromThrown("error", { note: "secret" }, "/").message).toBe("Non-error value thrown");
  });

  it("rate limit allows MAX per window per key", () => {
    const l = new ClientErrorRateLimit(2, 1000);
    expect([l.allow("a", 0), l.allow("a", 1), l.allow("a", 2), l.allow("b", 2), l.allow("a", 1001)]).toEqual([true, true, false, true, true]);
  });

  it("the route logs only the scrubbed report", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await POST(new Request("http://x/api/client-errors", { method: "POST", body: JSON.stringify({ kind: "error", message: 'Bad "Fictional value"', stack: "", route: "/?q=1", note: "secret" }) }));
    expect(res.status).toBe(204);
    const line = String(log.mock.calls.at(-1)?.[1]);
    expect(line).toContain("[value]");
    expect(line).not.toContain("Fictional");
    expect(line).not.toContain("secret");
    log.mockRestore();
    expect((await POST(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400);
  });
});
