import { describe, expect, it, vi } from "vitest";

// Only the matcher is under test; the proxy itself is Auth.js.
vi.mock("@/auth", () => ({ auth: () => undefined }));

const { config } = await import("@/proxy");
/** Next's matcher is a path regex: true = the auth proxy runs (signed-out visitors are sent to /signin). */
const proxied = (path: string) => new RegExp(`^${config.matcher[0]}$`).test(path);

describe("proxy matcher", () => {
  it("serves the public Inter font without sign-in, so /signin renders in Inter", () => {
    expect(proxied("/fonts/Inter-Variable.ttf")).toBe(false);
    expect(proxied("/signin")).toBe(false);
  });

  it("still protects every app page", () => {
    for (const path of ["/", "/reports", "/admin/people", "/completed", "/fontsy"]) expect(proxied(path), path).toBe(true);
  });
});
