import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Sentry CAROMONT-PORTFOLIO-TRACKER-1, at the route. A newer client's version probe must get the legacy 400 from
// /api/mcp without reaching the MCP SDK, whose transport.onerror is what Sentry records as an unhandled crash.
// Every other version still goes through the SDK. Fictional emails only.

const ADMIN = "admin.one@example.org";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  errors: [] as Error[],
}));

vi.mock("@/lib/db/Db", () => ({ Db: { isConfigured: () => true } }));
vi.mock("@/lib/mcp/McpViewer", () => ({
  McpViewer: {
    requestAccess: async (email: string) => ({ ok: true, user: { email, isAdmin: true, name: null, roleId: "admin", rank: 100, keys: [] } }),
  },
}));
vi.mock("@/lib/mcp/McpServerFactory", () => ({
  McpServerFactory: {
    create: (...args: unknown[]) => {
      h.create(...args);
      const server = new McpServer({ name: "t", version: "1" });
      const connect = server.connect.bind(server);
      // Record what the SDK would report (Sentry's MCP integration reads the same onerror).
      server.connect = async (transport) => {
        await connect(transport);
        transport.onerror = (e) => h.errors.push(e);
      };
      return server;
    },
  },
}));

const { McpTokens } = await import("@/lib/mcp/McpTokens");
const { POST } = await import("@/app/api/mcp/route");

function token() {
  return McpTokens.sign("access", { e: ADMIN, c: "client", s: ["projects"], exp: McpTokens.nowS() + 3600, jti: "probe-test" }, McpTokens.key()!);
}

async function call(version: string | null, auth = true) {
  const headers: Record<string, string> = { accept: "application/json, text/event-stream", "content-type": "application/json" };
  if (auth) headers.authorization = `Bearer ${token()}`;
  if (version !== null) headers["mcp-protocol-version"] = version;
  const res = await POST(
    new Request("https://tracker.example.org/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
  );
  return { res, body: (await res.json()) as { error?: unknown; result?: unknown } };
}

describe("/api/mcp answers a newer client's version probe itself", () => {
  beforeEach(() => {
    h.create.mockClear();
    h.errors.length = 0;
    vi.stubEnv("ALLOWED_EMAILS", ADMIN);
    vi.stubEnv("ADMIN_EMAILS", ADMIN);
    vi.stubEnv("AUTH_SECRET", "test-secret-for-connector");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns the legacy 400 with CORS, never builds an MCP server, and reports nothing", async () => {
    const { res, body } = await call("2026-07-28");
    expect(res.status).toBe(400);
    expect(body.error).toMatchObject({ code: -32000 });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(h.create).not.toHaveBeenCalled();
    expect(h.errors).toHaveLength(0);
  });

  it("still asks for sign-in first: a probe without a token gets 401, not the probe answer", async () => {
    const { res } = await call("2026-07-28", false);
    expect(res.status).toBe(401);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("serves a supported version through the SDK as before", async () => {
    const { res, body } = await call("2025-11-25");
    expect(res.status).toBe(200);
    expect(body.result).toBeDefined();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.errors).toHaveLength(0);
  });

  it("leaves an older unsupported version to the SDK, which still reports it", async () => {
    const { res } = await call("2024-01-01");
    expect(res.status).toBe(400);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.errors).toHaveLength(1);
  });
});
