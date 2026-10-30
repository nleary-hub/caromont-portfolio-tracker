import { McpOAuth, McpOAuthError } from "@/lib/mcp/McpOAuth";

/**
 * Shared HTTP bits for the connector's public endpoints (outside the sign-in proxy): JSON with no-store, CORS for
 * browser-based MCP clients (no cookies are ever read on these endpoints, so a wildcard origin grants nothing), and
 * the 404 used when the connector is switched off.
 */
export class McpHttp {
  static readonly CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
    "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
    "Access-Control-Max-Age": "86400",
  };

  static json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...McpHttp.CORS, ...extra } });
  }

  static oauthError(e: unknown): Response {
    if (e instanceof McpOAuthError) {
      return McpHttp.json({ error: e.error, error_description: e.description }, e.status, e.status === 401 ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {});
    }
    console.error("Claude connector OAuth failed", (e as Error)?.name);
    return McpHttp.json({ error: "server_error", error_description: "Something went wrong." }, 500);
  }

  static preflight(): Response {
    return new Response(null, { status: 204, headers: McpHttp.CORS });
  }

  static off(): Response | null {
    return McpOAuth.enabled() ? null : new Response("Not found", { status: 404 });
  }

  /** Form (application/x-www-form-urlencoded, the OAuth standard) or JSON body, as strings. */
  static async form(request: Request): Promise<Record<string, string>> {
    const type = request.headers.get("content-type") ?? "";
    const text = (await request.text()).slice(0, 20_000);
    if (type.includes("application/json")) {
      try {
        const o = JSON.parse(text) as Record<string, unknown>;
        return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string")) as Record<string, string>;
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(text));
  }
}
