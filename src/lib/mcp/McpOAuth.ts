import { createHmac, timingSafeEqual } from "node:crypto";
import { McpTokens, type McpClientClaims, type McpGrantClaims } from "@/lib/mcp/McpTokens";

type Env = Record<string, string | undefined>;

/** OAuth error per RFC 6749 section 5.2 (token, register) or 4.1.2.1 (authorize redirect). */
export class McpOAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "McpOAuthError";
  }
}

/** A checked authorize request, ready for the consent page. */
export interface McpAuthorizeRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
}

export interface McpTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Re-checks that the person behind a code or refresh token may still use the app (McpViewer.forEmail). */
export type McpStillAllowed = (email: string) => Promise<boolean>;

/**
 * OAuth 2.1 for the Claude connector (MCP authorization, spec 2025-03-26 and later): discovery metadata, Dynamic Client
 * Registration, the authorize request check, and the token endpoint. Public clients with PKCE S256 only. Stateless: the
 * client, code and tokens are signed values (McpTokens), nothing is stored.
 *
 * Redirect URIs are limited to Claude's callbacks, loopback (Claude Code and desktop clients) and MCP_REDIRECT_URIS,
 * so a stranger can't register a client that sends codes to their own site.
 */
export class McpOAuth {
  static readonly SCOPE = "projects";
  static readonly MCP_PATH = "/api/mcp";
  static readonly AUTHORIZE_PATH = "/oauth/authorize";
  static readonly TOKEN_PATH = "/oauth/token";
  static readonly REGISTER_PATH = "/oauth/register";
  static readonly CLAUDE_CALLBACKS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] as const;
  static readonly MAX_REDIRECTS = 5;

  /** Off switch: MCP_CONNECTOR_DISABLED=true turns every connector endpoint into 404. */
  static enabled(env: Env = process.env): boolean {
    return env.MCP_CONNECTOR_DISABLED?.trim().toLowerCase() !== "true";
  }

  /** The public origin: AUTH_URL when set (stable issuer behind proxies), else the request's own origin. */
  static origin(requestUrl: string, env: Env = process.env): string {
    const configured = env.AUTH_URL?.trim();
    if (configured) {
      try {
        return new URL(configured).origin;
      } catch {
        // fall through to the request origin
      }
    }
    return new URL(requestUrl).origin;
  }

  static resource(origin: string): string {
    return `${origin}${McpOAuth.MCP_PATH}`;
  }

  /** RFC 9728 protected resource metadata for /api/mcp. */
  static resourceMetadata(origin: string) {
    return {
      resource: McpOAuth.resource(origin),
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [McpOAuth.SCOPE],
      resource_name: "Service Line Portfolio",
    };
  }

  /** RFC 8414 authorization server metadata. */
  static serverMetadata(origin: string) {
    return {
      issuer: origin,
      authorization_endpoint: `${origin}${McpOAuth.AUTHORIZE_PATH}`,
      token_endpoint: `${origin}${McpOAuth.TOKEN_PATH}`,
      registration_endpoint: `${origin}${McpOAuth.REGISTER_PATH}`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      scopes_supported: [McpOAuth.SCOPE],
    };
  }

  /** WWW-Authenticate for a 401 from /api/mcp, pointing clients at the resource metadata (RFC 9728 section 5.1). */
  static challenge(origin: string, error?: "invalid_token"): string {
    const parts = [`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${McpOAuth.MCP_PATH}"`, `scope="${McpOAuth.SCOPE}"`];
    if (error) parts.push(`error="${error}"`);
    return parts.join(", ");
  }

  /** Whether a redirect URI may receive codes: Claude's callbacks, loopback over http, or one listed in MCP_REDIRECT_URIS. */
  static redirectAllowed(uri: unknown, env: Env = process.env): uri is string {
    if (typeof uri !== "string" || uri.length > 2000) return false;
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.hash || u.username || u.password) return false;
    if ((McpOAuth.CLAUDE_CALLBACKS as readonly string[]).includes(uri)) return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return true;
    const extra = (env.MCP_REDIRECT_URIS ?? "").split(/[\s,]+/).filter(Boolean);
    return extra.includes(uri);
  }

  /** Deterministic client secret for a confidential registration (stateless: re-derived on use). */
  static clientSecret(clientId: string, key: Buffer): string {
    return createHmac("sha256", key).update(`client-secret.${clientId}`).digest("base64url");
  }

  /** RFC 7591 Dynamic Client Registration. Returns the 201 body. */
  static register(body: unknown, key: Buffer | null, env: Env = process.env, now: Date = new Date()) {
    if (!key) throw new McpOAuthError("temporarily_unavailable", "The connector is not configured.", 503);
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!uris.length) throw new McpOAuthError("invalid_redirect_uri", "redirect_uris is required.");
    if (uris.length > McpOAuth.MAX_REDIRECTS) throw new McpOAuthError("invalid_redirect_uri", "Too many redirect_uris.");
    for (const u of uris) if (!McpOAuth.redirectAllowed(u, env)) throw new McpOAuthError("invalid_redirect_uri", "That redirect URI is not allowed for this app.");
    const name = (typeof b.client_name === "string" && b.client_name.trim() ? b.client_name.trim() : "MCP client").slice(0, 80);
    const method = b.token_endpoint_auth_method === "client_secret_post" || b.token_endpoint_auth_method === "client_secret_basic" ? b.token_endpoint_auth_method : "none";
    const iat = McpTokens.nowS(now);
    const claims: McpClientClaims = { r: uris as string[], n: name, iat, j: McpTokens.jti() };
    const clientId = McpTokens.sign("client", claims, key);
    return {
      client_id: clientId,
      client_id_issued_at: iat,
      ...(method === "none" ? {} : { client_secret: McpOAuth.clientSecret(clientId, key), client_secret_expires_at: 0 }),
      client_name: name,
      redirect_uris: claims.r,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: method,
      scope: McpOAuth.SCOPE,
    };
  }

  /**
   * The authorize query, checked. A bad client_id or redirect_uri throws with `redirectable: false` semantics (the page
   * shows the error, never redirects to an unchecked URI). Other problems are returned as a redirect with the error.
   */
  static checkAuthorize(
    params: Record<string, string | undefined>,
    key: Buffer | null,
    origin: string,
    env: Env = process.env,
  ): { ok: true; request: McpAuthorizeRequest } | { ok: false; redirect: string } | { ok: false; message: string } {
    if (!key) return { ok: false, message: "The connector is not configured on this server." };
    const client = McpTokens.verify("client", params.client_id, key);
    if (!client) return { ok: false, message: "This connection request is not valid. Remove the connector in Claude and add it again." };
    const redirectUri = params.redirect_uri ?? (client.r.length === 1 ? client.r[0] : undefined);
    if (!redirectUri || !client.r.includes(redirectUri) || !McpOAuth.redirectAllowed(redirectUri, env)) {
      return { ok: false, message: "This connection request has a redirect address the app does not allow." };
    }
    const state = params.state ?? null;
    const fail = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (state) u.searchParams.set("state", state);
      u.searchParams.set("iss", origin);
      return { ok: false as const, redirect: u.toString() };
    };
    if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
    if (!params.code_challenge || !/^[A-Za-z0-9\-_]{43}$/.test(params.code_challenge)) return fail("invalid_request", "PKCE code_challenge (S256) is required.");
    if ((params.code_challenge_method ?? "") !== "S256") return fail("invalid_request", "code_challenge_method must be S256.");
    if (params.resource) {
      let ok = false;
      try {
        ok = new URL(params.resource).origin === origin;
      } catch {
        ok = false;
      }
      if (!ok) return fail("invalid_target", "Unknown resource.");
    }
    return { ok: true, request: { clientId: params.client_id!, clientName: client.n, redirectUri, codeChallenge: params.code_challenge, state } };
  }

  /** After the person approves: the redirect carrying a fresh code. */
  static approve(req: McpAuthorizeRequest, email: string, key: Buffer, origin: string, now: Date = new Date()): string {
    const code = McpTokens.sign(
      "code",
      { e: email, c: McpTokens.clientHash(req.clientId), r: req.redirectUri, cc: req.codeChallenge, exp: McpTokens.nowS(now) + McpTokens.CODE_TTL_S, jti: McpTokens.jti() },
      key,
    );
    const u = new URL(req.redirectUri);
    u.searchParams.set("code", code);
    if (req.state) u.searchParams.set("state", req.state);
    u.searchParams.set("iss", origin);
    return u.toString();
  }

  /** The person declined. */
  static deny(req: McpAuthorizeRequest, origin: string): string {
    const u = new URL(req.redirectUri);
    u.searchParams.set("error", "access_denied");
    u.searchParams.set("error_description", "The request was declined.");
    if (req.state) u.searchParams.set("state", req.state);
    u.searchParams.set("iss", origin);
    return u.toString();
  }

  /** Client authentication at the token endpoint: public clients send only client_id; confidential ones the derived secret. */
  private static authenticateClient(form: Record<string, string>, basic: { id: string; secret: string } | null, key: Buffer): string {
    const clientId = basic?.id ?? form.client_id;
    if (!clientId || !McpTokens.verify("client", clientId, key)) throw new McpOAuthError("invalid_client", "Unknown client.", 401);
    const secret = basic?.secret ?? form.client_secret;
    if (secret !== undefined && secret !== "") {
      const want = Buffer.from(McpOAuth.clientSecret(clientId, key));
      const got = Buffer.from(secret);
      if (want.length !== got.length || !timingSafeEqual(want, got)) throw new McpOAuthError("invalid_client", "Client authentication failed.", 401);
    }
    return clientId;
  }

  private static issue(email: string, clientHash: string, key: Buffer, now: Date): McpTokenResponse {
    const t = McpTokens.nowS(now);
    const grant = (ttl: number): McpGrantClaims => ({ e: email, c: clientHash, exp: t + ttl, jti: McpTokens.jti() });
    return {
      access_token: McpTokens.sign("access", grant(McpTokens.ACCESS_TTL_S), key),
      token_type: "Bearer",
      expires_in: McpTokens.ACCESS_TTL_S,
      refresh_token: McpTokens.sign("refresh", grant(McpTokens.REFRESH_TTL_S), key),
      scope: McpOAuth.SCOPE,
    };
  }

  /** Token endpoint: authorization_code (with PKCE) and refresh_token grants. */
  static async token(
    form: Record<string, string>,
    basic: { id: string; secret: string } | null,
    key: Buffer | null,
    stillAllowed: McpStillAllowed,
    now: Date = new Date(),
  ): Promise<McpTokenResponse> {
    if (!key) throw new McpOAuthError("temporarily_unavailable", "The connector is not configured.", 503);
    const clientId = McpOAuth.authenticateClient(form, basic, key);
    const clientHash = McpTokens.clientHash(clientId);
    if (form.grant_type === "authorization_code") {
      const code = McpTokens.verify("code", form.code, key, now);
      if (!code || code.c !== clientHash) throw new McpOAuthError("invalid_grant", "The code is invalid or expired.");
      if (form.redirect_uri && form.redirect_uri !== code.r) throw new McpOAuthError("invalid_grant", "redirect_uri does not match.");
      if (!McpTokens.pkceMatches(form.code_verifier, code.cc)) throw new McpOAuthError("invalid_grant", "PKCE verification failed.");
      if (!(await stillAllowed(code.e))) throw new McpOAuthError("invalid_grant", "This account can no longer use the app.");
      return McpOAuth.issue(code.e, clientHash, key, now);
    }
    if (form.grant_type === "refresh_token") {
      const refresh = McpTokens.verify("refresh", form.refresh_token, key, now);
      if (!refresh || refresh.c !== clientHash) throw new McpOAuthError("invalid_grant", "The refresh token is invalid or expired.");
      if (!(await stillAllowed(refresh.e))) throw new McpOAuthError("invalid_grant", "This account can no longer use the app.");
      return McpOAuth.issue(refresh.e, clientHash, key, now);
    }
    throw new McpOAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
  }

  /** HTTP Basic client credentials, or null. */
  static basicAuth(header: string | null): { id: string; secret: string } | null {
    if (!header?.toLowerCase().startsWith("basic ")) return null;
    try {
      const raw = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const i = raw.indexOf(":");
      if (i < 0) return null;
      return { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
    } catch {
      return null;
    }
  }

  /** The bearer access token's person, or null (bad, expired or another kind of token). */
  static bearer(header: string | null, key: Buffer | null, now: Date = new Date()): McpGrantClaims | null {
    if (!header?.startsWith("Bearer ")) return null;
    return McpTokens.verify("access", header.slice(7).trim(), key, now);
  }
}
