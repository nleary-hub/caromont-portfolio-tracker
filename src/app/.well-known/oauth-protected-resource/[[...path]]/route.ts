import { McpHttp } from "@/lib/mcp/McpHttp";
import { McpOAuth } from "@/lib/mcp/McpOAuth";

// RFC 9728 metadata for the Claude connector (/api/mcp). Served at /.well-known/oauth-protected-resource and the
// path-suffixed /.well-known/oauth-protected-resource/api/mcp that MCP clients try first. Public (see src/proxy.ts).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return McpHttp.off() ?? McpHttp.json(McpOAuth.resourceMetadata(McpOAuth.origin(request.url)));
}

export async function OPTIONS() {
  return McpHttp.preflight();
}
