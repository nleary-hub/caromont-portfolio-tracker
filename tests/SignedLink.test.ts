import { describe, expect, it } from "vitest";
import { SignedLink } from "@/lib/report/SignedLink";

const SECRET = "s".repeat(40);
const now = new Date("2026-09-29T21:00:00Z");

describe("SignedLink", () => {
  const exp = SignedLink.expiryFor(now);
  const token = SignedLink.sign("11111111-2222-3333-4444-555555555555", exp, SECRET);

  it("expires after 7 days", () => {
    expect(exp.getTime() - now.getTime()).toBe(7 * 86_400_000);
    expect(SignedLink.verify(token, SECRET, now)).toMatchObject({ ok: true, snapshotId: "11111111-2222-3333-4444-555555555555" });
    expect(SignedLink.verify(token, SECRET, new Date(exp.getTime() - 1000)).ok).toBe(true);
    expect(SignedLink.verify(token, SECRET, exp)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a tampered payload (e.g. another snapshot id or a later expiry)", () => {
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ s: "99999999-2222-3333-4444-555555555555", e: 4102444800 })).toString("base64url");
    expect(SignedLink.verify(`${forged}.${sig}`, SECRET, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered signature, a wrong secret, malformed tokens and a missing secret", () => {
    const [body, sig] = token.split(".");
    const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    expect(SignedLink.verify(`${body}.${flipped}`, SECRET, now).ok).toBe(false);
    expect(SignedLink.verify(token, "t".repeat(40), now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(SignedLink.verify("garbage", SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    expect(SignedLink.verify(`${body}.`, SECRET, now)).toEqual({ ok: false, reason: "malformed" });
    expect(SignedLink.verify(token, null, now)).toEqual({ ok: false, reason: "no_secret" });
  });

  it("builds absolute URLs from the base URL", () => {
    expect(SignedLink.urls("https://tracker.example.org", "abc.def")).toEqual({
      pdfUrl: "https://tracker.example.org/api/share/abc.def/pdf",
      handoffUrl: "https://tracker.example.org/api/share/abc.def/handoff",
    });
  });
});
