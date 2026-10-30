import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { LINE, query, signIn } from "./helpers/rbacSeed";

// Claude connector end to end on the real server (next dev + PGlite with every migration): discovery, Dynamic Client
// Registration, sign-in and the consent page, the token exchange, then real MCP tool calls through the project
// services, the History tag, the permission limits and revocation. Fictional people and projects only.
const ADMIN = "jordan.pike@example.org";
const VIEWER = "riley.moss@example.org";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");

type Rpc = { result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean; tools?: { name: string }[] }; error?: unknown };

const rpc = async (request: APIRequestContext, token: string, method: string, params: Record<string, unknown> = {}): Promise<Rpc> => {
  const res = await request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
};
const call = async (request: APIRequestContext, token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(request, token, "tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  return { isError: Boolean(r.result?.isError), text, json: () => JSON.parse(text) };
};

async function connect(page: import("@playwright/test").Page, request: APIRequestContext, email: string): Promise<string> {
  const reg = await request.post("/oauth/register", { data: { client_name: "Claude", redirect_uris: [CALLBACK] } });
  expect(reg.status()).toBe(201);
  const client = await reg.json();

  await signIn(page, email);
  let callback: URL | null = null;
  await page.route("https://claude.ai/**", async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ status: 200, body: "ok" });
  });
  const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "projects" });
  await page.goto(`/oauth/authorize?${q}`);
  await expect(page.getByTestId("connector-consent")).toContainText(email);
  await page.getByTestId("connector-approve").click();
  await expect.poll(() => callback?.searchParams.get("code") ?? null, { timeout: 60000 }).not.toBeNull();
  expect(callback!.searchParams.get("state")).toBe("xyz");

  const tok = await request.post("/oauth/token", {
    form: { grant_type: "authorization_code", code: callback!.searchParams.get("code")!, code_verifier: verifier, client_id: client.client_id, redirect_uri: CALLBACK },
  });
  expect(tok.status(), await tok.text()).toBe(200);
  return (await tok.json()).access_token as string;
}

test("Claude connector: sign in, consent, and edit projects through the app's own rules", async ({ page, request, browser }) => {
  // Discovery and the 401 challenge a client starts from.
  const prm = await (await request.get("/.well-known/oauth-protected-resource/api/mcp")).json();
  expect(prm.resource).toMatch(/\/api\/mcp$/);
  const asm = await (await request.get("/.well-known/oauth-authorization-server")).json();
  expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
  const anon = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  expect(anon.status()).toBe(401);
  expect(anon.headers()["www-authenticate"]).toContain("resource_metadata=");
  expect((await request.post("/oauth/register", { data: { redirect_uris: ["https://evil.example.com/cb"] } })).status()).toBe(400);

  const token = await connect(page, request, ADMIN);

  const init = await rpc(request, token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("service-line-portfolio");
  const tools = (await rpc(request, token, "tools/list")).result!.tools!.map((t) => t.name);
  expect(tools).toEqual(expect.arrayContaining(["whoami", "list_projects", "get_project", "update_project", "update_milestones", "add_blocker", "resolve_blocker", "create_project"]));

  const me = (await call(request, token, "whoami")).json();
  expect(me.email).toBe(ADMIN);
  expect(me.can.edit).toBe(true);
  const department = me.departments[0];

  // Create, edit fields, edit the checklist, blocker add and resolve.
  const created = await call(request, token, "create_project", {
    name: "Connector Check Valve Clinic",
    department,
    description: "Fictional project for the connector e2e.",
    milestones: [{ name: "Draft workflow", dueDate: "2027-01-15" }, { name: "Go-live", dueDate: "2027-03-01" }],
  });
  expect(created.isError, created.text).toBe(false);
  const p = created.json();
  expect(p.nextMilestone).toBe("Draft workflow");

  const updated = await call(request, token, "update_project", { projectId: p.id, changes: { status: "On track", latestUpdate: "Kickoff held; workflow draft started.", percentComplete: 10 } });
  expect(updated.isError, updated.text).toBe(false);
  expect(updated.json()).toMatchObject({ status: "On track", latestUpdate: "Kickoff held; workflow draft started.", percentComplete: 10 });

  const refusedComplete = await call(request, token, "update_project", { projectId: p.id, changes: { status: "Complete" } });
  expect(refusedComplete.isError).toBe(true);
  expect(refusedComplete.text).toContain("last milestone");

  const steps = await call(request, token, "update_milestones", {
    projectId: p.id,
    actions: [{ action: "complete", milestone: "Draft workflow" }, { action: "add", name: "Staff training", dueDate: "2027-02-10", position: "next" }],
  });
  expect(steps.isError, steps.text).toBe(false);
  expect(steps.json().nextMilestone).toBe("Staff training");

  const blocked = await call(request, token, "add_blocker", { projectId: p.id, description: "Order set build", waitingOn: "IT order set team", followUpOn: "2027-01-20" });
  expect(blocked.isError, blocked.text).toBe(false);
  const blockerId = blocked.json().blockers[0].id;
  const resolved = await call(request, token, "resolve_blocker", { projectId: p.id, blockerId, resolution: "Build finished" });
  expect(resolved.isError, resolved.text).toBe(false);
  expect(resolved.json().blockers).toHaveLength(0);

  const listed = (await call(request, token, "list_projects", { query: "check valve" })).json();
  expect(listed.projects.map((x: { id: string }) => x.id)).toContain(p.id);

  // History: every connector save is by the person and tagged as the connector; the timeline labels it.
  const rows = await query(`SELECT field, "changedBy", comment FROM "ProjectHistory" WHERE "projectId" = $1`, [p.id]);
  expect(rows.length).toBeGreaterThan(4);
  expect(rows.every((r: { changedBy: string }) => r.changedBy === ADMIN)).toBe(true);
  expect(rows.filter((r: { comment: string | null }) => r.comment === "ai:claude_connector").length).toBeGreaterThan(3);
  const history = (await call(request, token, "get_project_history", { projectId: p.id })).json();
  expect(history.changes.length).toBeGreaterThan(0);

  // A Viewer with access to the line can read but not change.
  await query(`INSERT INTO app_user (email, "createdAt") VALUES ($1, now()) ON CONFLICT DO NOTHING`, [VIEWER]);
  await query(`INSERT INTO service_line_access (email, "serviceLineId", "grantedBy") VALUES ($1, $2, 'e2e') ON CONFLICT DO NOTHING`, [VIEWER, LINE]);
  const viewerContext = await browser.newContext();
  const viewerPage = await viewerContext.newPage();
  const viewerToken = await connect(viewerPage, viewerContext.request, VIEWER);
  const viewerRead = await call(viewerContext.request, viewerToken, "get_project", { projectId: p.id });
  expect(viewerRead.isError, viewerRead.text).toBe(false);
  expect(viewerRead.json().canEdit).toBe(false);
  const viewerEdit = await call(viewerContext.request, viewerToken, "update_project", { projectId: p.id, changes: { latestUpdate: "Should not save" } });
  expect(viewerEdit.isError).toBe(true);
  expect(viewerEdit.text).toContain("can't edit");
  await viewerContext.close();

  // Turning the person's sign-in off stops the connector on the next call.
  await query(`INSERT INTO sign_in_block (email, "blockedBy", "blockedAt") VALUES ($1, 'e2e', now()) ON CONFLICT DO NOTHING`, [ADMIN]).catch(async () => {
    await query(`INSERT INTO sign_in_block (email) VALUES ($1) ON CONFLICT DO NOTHING`, [ADMIN]);
  });
  const blockedRes = await request.post("/api/mcp", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream" },
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(blockedRes.status()).toBe(401);
  await query(`DELETE FROM sign_in_block WHERE email = $1`, [ADMIN]);
});
