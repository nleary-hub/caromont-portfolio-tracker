import { createHmac, timingSafeEqual } from "node:crypto";

export interface SignedLinkPayload {
  /** Snapshot id */
  s: string;
  /** Expiry, Unix seconds */
  e: number;
}

export type VerifyResult =
  | { ok: true; snapshotId: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "no_secret" };

/**
 * Expiring HMAC-SHA256 links for the delivery fallback: /api/share/<token>/pdf and /handoff serve
 * a snapshot's files without app sign-in until the token expires (7 days). Tokens are
 * base64url(payload).base64url(hmac); any change to either part fails verification.
 */
export class SignedLink {
  static readonly TTL_DAYS = 7;
  static readonly FILES = ["pdf", "handoff"] as const;

  private static b64(buf: Buffer | string): string {
    return Buffer.from(buf).toString("base64url");
  }

  private static mac(secret: string, body: string): Buffer {
    return createHmac("sha256", secret).update(`report-share.v1.${body}`).digest();
  }

  static expiryFor(now: Date): Date {
    return new Date(now.getTime() + SignedLink.TTL_DAYS * 86_400_000);
  }

  static sign(snapshotId: string, expiresAt: Date, secret: string): string {
    const body = SignedLink.b64(JSON.stringify({ s: snapshotId, e: Math.floor(expiresAt.getTime() / 1000) } satisfies SignedLinkPayload));
    return `${body}.${SignedLink.b64(SignedLink.mac(secret, body))}`;
  }

  static verify(token: string, secret: string | null, now: Date = new Date()): VerifyResult {
    if (!secret) return { ok: false, reason: "no_secret" };
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
    const [body, sig] = parts;
    const expected = SignedLink.mac(secret, body);
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad_signature" };
    let payload: SignedLinkPayload;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SignedLinkPayload;
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (typeof payload.s !== "string" || typeof payload.e !== "number") return { ok: false, reason: "malformed" };
    if (now.getTime() >= payload.e * 1000) return { ok: false, reason: "expired" };
    return { ok: true, snapshotId: payload.s, expiresAt: new Date(payload.e * 1000) };
  }

  static urls(baseUrl: string | null, token: string): { pdfUrl: string; handoffUrl: string } {
    const root = `${baseUrl ?? ""}/api/share/${token}`;
    return { pdfUrl: `${root}/pdf`, handoffUrl: `${root}/handoff` };
  }
}
