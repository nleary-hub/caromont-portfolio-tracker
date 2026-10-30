import { McpHttp } from "@/lib/mcp/McpHttp";
import { McpOAuth } from "@/lib/mcp/McpOAuth";

// RFC 8414 metadata for the Claude connector's OAuth (the app itself is the authorization server). Also answers the
// path-suffixed form some clients request. Public (see src/proxy.ts).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return McpHttp.off() ?? McpHttp.json(McpOAuth.serverMetadata(McpOAuth.origin(request.url)));
}

export async function OPTIONS() {
  return McpHttp.preflight();
}
