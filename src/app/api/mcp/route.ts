import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ActingViewer } from "@/lib/auth/ActingViewer";
import { Db } from "@/lib/db/Db";
import { McpHttp } from "@/lib/mcp/McpHttp";
import { McpOAuth } from "@/lib/mcp/McpOAuth";
import { McpServerFactory } from "@/lib/mcp/McpServerFactory";
import { McpTokens } from "@/lib/mcp/McpTokens";
import { McpViewer } from "@/lib/mcp/McpViewer";

// The Claude connector (remote MCP server, Streamable HTTP, stateless). Every request needs a connector access token
// (OAuth, see /oauth/*); the person is resolved again on each request, so turning their sign-in off ends access at once.
// Public to the sign-in proxy (it uses bearer tokens, not the session cookie; see src/proxy.ts).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class McpRoute {
  static unauthorized(origin: string, error?: "invalid_token"): Response {
    return McpHttp.json({ error: error ?? "unauthorized", error_description: "Connector sign-in required." }, 401, { "WWW-Authenticate": McpOAuth.challenge(origin, error) });
  }

  static async handle(request: Request): Promise<Response> {
    const off = McpHttp.off();
    if (off) return off;
    const origin = McpOAuth.origin(request.url);
    const header = request.headers.get("authorization");
    if (!header) return McpRoute.unauthorized(origin);
    const grant = McpOAuth.bearer(header, McpTokens.key());
    if (!grant) return McpRoute.unauthorized(origin, "invalid_token");
    if (!Db.isConfigured()) return McpHttp.json({ error: "Database not configured" }, 503);
    const viewer = await McpViewer.forEmail(grant.e).catch(() => null);
    if (!viewer) return McpRoute.unauthorized(origin, "invalid_token");

    const server = McpServerFactory.create(viewer, McpOAuth.scopesOf(grant));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      // The app's own Server Functions read the person from ActingViewer for this request only (see run_app_action).
      const res = await ActingViewer.run({ ...viewer, name: viewer.name ?? null }, () => transport.handleRequest(request));
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(McpHttp.CORS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      console.error("Claude connector request failed", (e as Error)?.name);
      return McpHttp.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, 500);
    } finally {
      // JSON responses are complete when handleRequest returns; nothing streams after this.
      await server.close().catch(() => undefined);
    }
  }
}

export async function POST(request: Request) {
  return McpRoute.handle(request);
}

export async function GET(request: Request) {
  return McpRoute.handle(request);
}

export async function DELETE(request: Request) {
  return McpRoute.handle(request);
}

export async function OPTIONS() {
  return McpHttp.preflight();
}
