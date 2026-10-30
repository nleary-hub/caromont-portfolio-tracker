import { McpHttp } from "@/lib/mcp/McpHttp";
import { McpOAuth } from "@/lib/mcp/McpOAuth";
import { McpTokens } from "@/lib/mcp/McpTokens";
import { McpViewer } from "@/lib/mcp/McpViewer";

// OAuth token endpoint for the Claude connector: authorization_code with PKCE, and refresh_token. Each grant re-checks
// that the person may still use the app. Public (see src/proxy.ts).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const off = McpHttp.off();
  if (off) return off;
  try {
    const form = await McpHttp.form(request);
    const r = await McpOAuth.token(form, McpOAuth.basicAuth(request.headers.get("authorization")), McpTokens.key(), (email) => McpViewer.stillAllowed(email));
    return McpHttp.json(r, 200, { Pragma: "no-cache" });
  } catch (e) {
    return McpHttp.oauthError(e);
  }
}

export async function OPTIONS() {
  return McpHttp.preflight();
}
