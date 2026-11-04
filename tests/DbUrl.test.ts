import { parse } from "pg-connection-string";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DbUrl } from "@/lib/db/DbUrl";

// Neon-shaped URLs on an example host; no credentials.
const base = "postgresql://app_user@ep-quiet-lab-123456-pooler.us-east-1.aws.example.test/neondb";

describe("DbUrl.strictSsl", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["prefer", "require", "verify-ca", "REQUIRE"])("pins sslmode=%s to verify-full", (mode) => {
    expect(DbUrl.strictSsl(`${base}?sslmode=${mode}`)).toBe(`${base}?sslmode=verify-full`);
  });

  it("keeps every other parameter and its encoding as it was", () => {
    const url = `${base}?channel_binding=require&sslmode=require&options=-c%20search_path%3Dapp`;
    expect(DbUrl.strictSsl(url)).toBe(`${base}?channel_binding=require&sslmode=verify-full&options=-c%20search_path%3Dapp`);
  });

  it.each([
    ["no sslmode", base],
    ["verify-full", `${base}?sslmode=verify-full`],
    ["disable", `${base}?sslmode=disable`],
    ["no-verify", `${base}?sslmode=no-verify`],
    ["libpq opt-in", `${base}?uselibpqcompat=true&sslmode=require`],
    ["a lookalike parameter", `${base}?xsslmode=require`],
  ])("leaves %s alone", (_label, url) => {
    expect(DbUrl.strictSsl(url)).toBe(url);
  });

  it("gives pg the same TLS settings as before, without the warning", () => {
    // pg warns once per process, so parse the pinned URL first: it must stay silent; the old one must still warn.
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const after = parse(DbUrl.strictSsl(`${base}?sslmode=require`));
    expect(warn).not.toHaveBeenCalled();
    const before = parse(`${base}?sslmode=require`);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("SECURITY WARNING");
    expect(after.ssl).toEqual(before.ssl);
    expect(after.host).toBe(before.host);
  });
});
