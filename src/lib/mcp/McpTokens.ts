import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

/** The four signed values the Claude connector's OAuth uses. Each kind is signed separately, so one can't pass as another. */
export type McpTokenKind = "client" | "code" | "access" | "refresh";

/** A registered client (Dynamic Client Registration): its redirect URIs and display name, signed into the client_id. */
export interface McpClientClaims {
  /** Redirect URIs allowed for this client. */
  r: string[];
  /** Client name as it registered (shown on the consent page). */
  n: string;
  /** Registered at, Unix seconds. */
  iat: number;
  /** Random, so two identical registrations get different client_ids. */
  j: string;
  /** Token endpoint auth method it registered with: "none" (public, PKCE only) or a client secret method. */
  m?: "none" | "client_secret_post" | "client_secret_basic";
}

/** A one-time authorization code (2 minutes): who approved, for which client, redirect and PKCE challenge. */
export interface McpCodeClaims {
  e: string;
  /** sha256 of the client_id (keeps the code short). */
  c: string;
  r: string;
  /** PKCE S256 code_challenge. */
  cc: string;
  /** Scopes the person approved (McpOAuth.SCOPES). */
  s: string[];
  exp: number;
  jti: string;
}

/** Access (1 hour) and refresh (30 days) tokens: the person and the client. Every use re-checks the person's access. */
export interface McpGrantClaims {
  e: string;
  c: string;
  /** Approved scopes. Absent on tokens issued before scopes existed: those carry "projects" only. */
  s?: string[];
  exp: number;
  jti: string;
}

type ClaimsOf<K extends McpTokenKind> = K extends "client" ? McpClientClaims : K extends "code" ? McpCodeClaims : McpGrantClaims;

/**
 * Stateless signed tokens for the Claude connector (no new tables, so no migration and no write to production on a
 * preview). Format: `pt1.<kind>.<base64url(json)>.<base64url(hmac)>`. The key is derived from MCP_OAUTH_SECRET, or from
 * AUTH_SECRET when that is not set, with its own HKDF label, so it never equals the session key.
 *
 * Revocation: turning a person off (Admin > People), taking them off the access list or deleting their account stops
 * every token on its next use (McpViewer re-checks each request). Setting or changing MCP_OAUTH_SECRET signs everyone
 * out of the connector at once.
 */
export class McpTokens {
  static readonly PREFIX = "pt1";
  static readonly CODE_TTL_S = 120;
  static readonly ACCESS_TTL_S = 60 * 60;
  static readonly REFRESH_TTL_S = 30 * 24 * 60 * 60;

  /** The signing key, or null when neither secret is set (the connector then refuses every request). */
  static key(env: Env = process.env): Buffer | null {
    const base = env.MCP_OAUTH_SECRET?.trim() || env.AUTH_SECRET?.trim();
    if (!base) return null;
    return Buffer.from(hkdfSync("sha256", base, "portfolio-tracker", "mcp-oauth.v1", 32));
  }

  static nowS(now: Date = new Date()): number {
    return Math.floor(now.getTime() / 1000);
  }

  static jti(): string {
    return randomBytes(12).toString("base64url");
  }

  /** sha256(client_id), base64url. Codes and tokens carry this instead of the long client_id. */
  static clientHash(clientId: string): string {
    return createHash("sha256").update(clientId).digest("base64url");
  }

  private static mac(key: Buffer, head: string, body: string): Buffer {
    return createHmac("sha256", key).update(`${head}.${body}`).digest();
  }

  static sign<K extends McpTokenKind>(kind: K, claims: ClaimsOf<K>, key: Buffer): string {
    const head = `${McpTokens.PREFIX}.${kind}`;
    const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${head}.${body}.${McpTokens.mac(key, head, body).toString("base64url")}`;
  }

  /** The claims when the token is this kind, correctly signed and (for expiring kinds) not expired; else null. */
  static verify<K extends McpTokenKind>(kind: K, token: unknown, key: Buffer | null, now: Date = new Date()): ClaimsOf<K> | null {
    if (!key || typeof token !== "string" || token.length > 4096) return null;
    const parts = token.split(".");
    if (parts.length !== 4 || parts[0] !== McpTokens.PREFIX || parts[1] !== kind || !parts[2] || !parts[3]) return null;
    const head = `${parts[0]}.${parts[1]}`;
    const expected = McpTokens.mac(key, head, parts[2]);
    const given = Buffer.from(parts[3], "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let claims: Record<string, unknown>;
    try {
      claims = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!claims || typeof claims !== "object") return null;
    if (kind !== "client") {
      if (typeof claims.exp !== "number" || McpTokens.nowS(now) >= claims.exp) return null;
      if (typeof claims.e !== "string" || typeof claims.c !== "string") return null;
    } else if (!Array.isArray(claims.r) || typeof claims.n !== "string") {
      return null;
    }
    return claims as unknown as ClaimsOf<K>;
  }

  /** PKCE S256: base64url(sha256(verifier)) must equal the challenge. Verifier per RFC 7636 (43 to 128 unreserved chars). */
  static pkceMatches(verifier: unknown, challenge: string): boolean {
    if (typeof verifier !== "string" || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
    const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
    const wanted = Buffer.from(challenge);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  }
}
