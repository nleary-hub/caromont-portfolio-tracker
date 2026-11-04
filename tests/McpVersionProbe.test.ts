import type { ErrorEvent } from "@sentry/nextjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { SentryScrub } from "@/lib/errors/SentryScrub";

/**
 * Sentry CAROMONT-PORTFOLIO-TRACKER-1. A dual-era MCP client (2026-07-28 plus the older handshake) first sends a
 * modern request; a 2025-11-25 server must answer 400 WITHOUT a modern error body (-32022) so the client falls back to
 * initialize. This pins the SDK's behavior the app relies on, and that the text it reports is what SentryScrub drops.
 */
async function probe(version: string) {
  const server = new McpServer({ name: "t", version: "1" });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const errors: Error[] = [];
  await server.connect(transport);
  transport.onerror = (e) => errors.push(e);
  const res = await transport.handleRequest(
    new Request("https://app.example.org/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );
  await server.close();
  return { res, body: (await res.json()) as { error?: { code?: number } }, errors };
}

const asEvent = (e: Error) => ({ type: undefined, exception: { values: [{ type: "Error", value: e.message, mechanism: { type: "auto.ai.mcp_server", handled: false } }] } }) as unknown as ErrorEvent;

describe("MCP 2026-07-28 probe against this server", () => {
  it("gets a legacy 400 (not the modern -32022 error), so the client falls back to initialize", async () => {
    const { res, body, errors } = await probe("2026-07-28");
    expect(res.status).toBe(400);
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.code).not.toBe(-32022);
    expect(errors).toHaveLength(1);
    expect(SentryScrub.event(asEvent(errors[0]))).toBeNull();
  });

  it("an older unsupported version is still rejected and still reported", async () => {
    const { res, errors } = await probe("2024-01-01");
    expect(res.status).toBe(400);
    expect(SentryScrub.event(asEvent(errors[0]))).not.toBeNull();
  });
});
