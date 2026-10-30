import { McpHttp } from "@/lib/mcp/McpHttp";
import { McpOAuth } from "@/lib/mcp/McpOAuth";
import { McpTokens } from "@/lib/mcp/McpTokens";

// RFC 7591 Dynamic Client Registration for the Claude connector. Stateless (the client_id is signed) and limited to
// allowed redirect URIs (McpOAuth.redirectAllowed), so registering grants nothing by itself. Public (see src/proxy.ts).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const off = McpHttp.off();
  if (off) return off;
  try {
    let body: unknown = {};
    try {
      body = JSON.parse((await request.text()).slice(0, 20_000));
    } catch {
      return McpHttp.json({ error: "invalid_client_metadata", error_description: "Send the registration as JSON." }, 400);
    }
    return McpHttp.json(McpOAuth.register(body, McpTokens.key()), 201);
  } catch (e) {
    return McpHttp.oauthError(e);
  }
}

export async function OPTIONS() {
  return McpHttp.preflight();
}
