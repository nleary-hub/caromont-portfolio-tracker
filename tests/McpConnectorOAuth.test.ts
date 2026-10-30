import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpOAuth, McpOAuthError } from "@/lib/mcp/McpOAuth";
import { McpTokens } from "@/lib/mcp/McpTokens";

// Claude connector OAuth (stateless signed tokens, DCR, PKCE). Example data only.
const ENV = { AUTH_SECRET: "test-secret-for-connector" };
const KEY = McpTokens.key(ENV)!;
const ORIGIN = "https://tracker.example.org";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const verifier = () => randomBytes(32).toString("base64url");
const challenge = (v: string) => createHash("sha256").update(v).digest("base64url");
const allowed = async () => true;

const register = (uris: string[] = [CLAUDE], extra: Record<string, unknown> = {}) => McpOAuth.register({ redirect_uris: uris, client_name: "Claude", ...extra }, KEY, ENV);

function authorize(clientId: string, v: string, overrides: Record<string, string | undefined> = {}) {
  return McpOAuth.checkAuthorize(
    { response_type: "code", client_id: clientId, redirect_uri: CLAUDE, code_challenge: challenge(v), code_challenge_method: "S256", state: "s1", ...overrides },
    KEY,
    ORIGIN,
    ENV,
  );
}

async function fullFlow(email = "jordan.pike@example.org") {
  const client = register();
  const v = verifier();
  const a = authorize(client.client_id, v);
  if (!a.ok) throw new Error("authorize failed");
  const redirect = new URL(McpOAuth.approve(a.request, email, KEY, ORIGIN));
  const code = redirect.searchParams.get("code")!;
  return { client, v, code, redirect };
}

describe("McpTokens", () => {
  it("derives a key only when a secret is set, and MCP_OAUTH_SECRET overrides AUTH_SECRET", () => {
    expect(McpTokens.key({})).toBeNull();
    expect(McpTokens.key({ AUTH_SECRET: "a" })!.equals(McpTokens.key({ AUTH_SECRET: "a", MCP_OAUTH_SECRET: "b" })!)).toBe(false);
  });

  it("rejects a tampered token, another kind, another key and an expired one", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const t = McpTokens.sign("access", { e: "a@example.org", c: "x", exp: McpTokens.nowS(now) + 60, jti: "j" }, KEY);
    expect(McpTokens.verify("access", t, KEY, now)?.e).toBe("a@example.org");
    const parts = t.split(".");
    const forged = Buffer.from(JSON.stringify({ e: "admin@example.org", c: "x", exp: 9e9, jti: "j" })).toString("base64url");
    expect(McpTokens.verify("access", [parts[0], parts[1], forged, parts[3]].join("."), KEY, now)).toBeNull();
    expect(McpTokens.verify("refresh", t.replace(".access.", ".refresh."), KEY, now)).toBeNull();
    expect(McpTokens.verify("access", t, McpTokens.key({ AUTH_SECRET: "other" }), now)).toBeNull();
    expect(McpTokens.verify("access", t, KEY, new Date(now.getTime() + 61_000))).toBeNull();
  });
});

describe("McpOAuth redirect policy and registration", () => {
  it("allows Claude's two callbacks and loopback, and nothing else unless listed", () => {
    expect(McpOAuth.redirectAllowed("https://claude.ai/api/mcp/auth_callback", ENV)).toBe(true);
    expect(McpOAuth.redirectAllowed("https://claude.com/api/mcp/auth_callback", ENV)).toBe(true);
    expect(McpOAuth.redirectAllowed("http://localhost:33418/callback", ENV)).toBe(true);
    expect(McpOAuth.redirectAllowed("http://127.0.0.1:5000/cb", ENV)).toBe(true);
    expect(McpOAuth.redirectAllowed("https://evil.example.com/cb", ENV)).toBe(false);
    expect(McpOAuth.redirectAllowed("https://claude.ai.evil.com/api/mcp/auth_callback", ENV)).toBe(false);
    expect(McpOAuth.redirectAllowed("https://claude.ai/other", ENV)).toBe(false);
    expect(McpOAuth.redirectAllowed("http://localhost.evil.com/cb", ENV)).toBe(false);
    expect(McpOAuth.redirectAllowed("https://ok.example.org/cb", { ...ENV, MCP_REDIRECT_URIS: "https://ok.example.org/cb" })).toBe(true);
  });

  it("refuses to register a client for a redirect URI it doesn't allow", () => {
    expect(() => register(["https://evil.example.com/cb"])).toThrow(McpOAuthError);
    expect(() => register([])).toThrow(McpOAuthError);
  });

  it("registers public clients by default and gives confidential ones a derived secret", () => {
    expect(register()).not.toHaveProperty("client_secret");
    expect(register()).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [CLAUDE] });
    const c = register([CLAUDE], { token_endpoint_auth_method: "client_secret_post" });
    expect(c.client_secret).toBe(McpOAuth.clientSecret(c.client_id, KEY));
  });

  it("publishes discovery metadata that points at this app", () => {
    expect(McpOAuth.resourceMetadata(ORIGIN)).toMatchObject({ resource: `${ORIGIN}/api/mcp`, authorization_servers: [ORIGIN] });
    expect(McpOAuth.serverMetadata(ORIGIN)).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ["S256"], registration_endpoint: `${ORIGIN}/oauth/register` });
    expect(McpOAuth.challenge(ORIGIN)).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
  });
});

describe("McpOAuth authorize and token", () => {
  it("never redirects to an unchecked URI: a bad client or redirect shows an error instead", () => {
    const c = register();
    expect(McpOAuth.checkAuthorize({ client_id: "nope", redirect_uri: "https://evil.example.com" }, KEY, ORIGIN, ENV)).toMatchObject({ ok: false, message: expect.any(String) });
    expect(authorize(c.client_id, verifier(), { redirect_uri: "https://claude.com/api/mcp/auth_callback" })).toMatchObject({ ok: false, message: expect.any(String) });
  });

  it("requires PKCE S256 (error goes back to the registered redirect)", () => {
    const c = register();
    const r = authorize(c.client_id, verifier(), { code_challenge_method: "plain" });
    expect(r.ok).toBe(false);
    expect("redirect" in r && new URL(r.redirect).searchParams.get("error")).toBe("invalid_request");
  });

  it("exchanges a code with the right verifier for access and refresh tokens, and refreshes", async () => {
    const { client, v, code, redirect } = await fullFlow();
    expect(redirect.searchParams.get("state")).toBe("s1");
    expect(redirect.searchParams.get("iss")).toBe(ORIGIN);
    const t = await McpOAuth.token({ grant_type: "authorization_code", code, code_verifier: v, client_id: client.client_id, redirect_uri: CLAUDE }, null, KEY, allowed);
    expect(McpOAuth.bearer(`Bearer ${t.access_token}`, KEY)?.e).toBe("jordan.pike@example.org");
    expect(McpOAuth.bearer(`Bearer ${t.refresh_token}`, KEY)).toBeNull();
    const r = await McpOAuth.token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id }, null, KEY, allowed);
    expect(McpOAuth.bearer(`Bearer ${r.access_token}`, KEY)?.e).toBe("jordan.pike@example.org");
  });

  it("refuses a wrong verifier, another client's code, and a person who lost access", async () => {
    const { client, v, code } = await fullFlow();
    await expect(McpOAuth.token({ grant_type: "authorization_code", code, code_verifier: verifier(), client_id: client.client_id }, null, KEY, allowed)).rejects.toMatchObject({ error: "invalid_grant" });
    const other = register();
    await expect(McpOAuth.token({ grant_type: "authorization_code", code, code_verifier: v, client_id: other.client_id }, null, KEY, allowed)).rejects.toMatchObject({ error: "invalid_grant" });
    await expect(McpOAuth.token({ grant_type: "authorization_code", code, code_verifier: v, client_id: client.client_id }, null, KEY, async () => false)).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("checks a confidential client's secret", async () => {
    const c = register([CLAUDE], { token_endpoint_auth_method: "client_secret_basic" });
    await expect(McpOAuth.token({ grant_type: "refresh_token", refresh_token: "x" }, { id: c.client_id, secret: "wrong" }, KEY, allowed)).rejects.toMatchObject({ error: "invalid_client" });
  });

  it("expires codes after two minutes", async () => {
    const { client, v, code } = await fullFlow();
    const later = new Date(Date.now() + (McpTokens.CODE_TTL_S + 5) * 1000);
    await expect(McpOAuth.token({ grant_type: "authorization_code", code, code_verifier: v, client_id: client.client_id }, null, KEY, allowed, later)).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("can be switched off", () => {
    expect(McpOAuth.enabled({})).toBe(true);
    expect(McpOAuth.enabled({ MCP_CONNECTOR_DISABLED: "true" })).toBe(false);
  });
});
