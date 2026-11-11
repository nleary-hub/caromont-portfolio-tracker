import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// CAR-5 / CAR-10: the Claude connector is admin-only. Fictional emails only.
// ADMIN_EMAILS is read on every check (the same flag McpViewer already uses for admin rights).

const ADMIN = "admin.one@example.org";
const MEMBER = "member.one@example.org";
const PASSWORD_ADMIN = "pw.admin@example.org";
const ORIGIN = "https://tracker.example.org";
const CLAUDE = "https://claude.ai/api/mcp/auth_callback";
const PROJECT = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  blocked: new Set<string>(),
  deleteProject: vi.fn(async () => ({ ok: true })),
  listProjects: vi.fn(async () => ({ projects: [{ id: "p1", name: "Valve Clinic" }] })),
  updateProject: vi.fn(async () => ({ id: "p1", name: "Valve Clinic", latestUpdate: "Kickoff held." })),
  viewer: { email: "member.one@example.org", isAdmin: true, name: null as string | null, roleId: "viewer", rank: 10, keys: [] as string[] },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "tracker.example.org", "x-forwarded-proto": "https" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const err = new Error("REDIRECT");
    (err as Error & { url: string }).url = url;
    throw err;
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({
  Db: {
    isConfigured: () => true,
    get client() {
      return {
        signInBlock: {
          findUnique: async ({ where }: { where: { email: string } }) => (h.blocked.has(where.email) ? { email: where.email } : null),
        },
        appUser: { findUnique: async () => null },
        role: { findUnique: async () => null },
      };
    },
  },
}));
vi.mock("@/app/actions/admin", () => ({
  deleteProject: () => h.deleteProject(),
  setProjectHidden: vi.fn(),
  restoreProject: vi.fn(),
}));
vi.mock("@/lib/mcp/McpProjectTools", () => ({
  McpToolError: class McpToolError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "McpToolError";
    }
  },
  McpProjectTools: {
    context: async (viewer: unknown) => ({ viewer, scope: { id: "line-1", shortName: "CV" }, lines: [], db: {} }),
    explain: (e: unknown) => (e instanceof Error ? e : new Error("failed")),
    listProjects: () => h.listProjects(),
    updateProject: () => h.updateProject(),
  },
}));

const { McpOAuth } = await import("@/lib/mcp/McpOAuth");
const { McpTokens } = await import("@/lib/mcp/McpTokens");
const { McpViewer } = await import("@/lib/mcp/McpViewer");
const { POST } = await import("@/app/api/mcp/route");
const { POST: postToken } = await import("@/app/oauth/token/route");
const { default: ConnectorAuthorizePage } = await import("@/app/oauth/authorize/page");
const { decideConnectorAccess } = await import("@/app/oauth/authorize/actions");

const ENV = () => ({ ALLOWED_EMAILS: `${ADMIN} ${MEMBER}`, ADMIN_EMAILS: ADMIN, AUTH_SECRET: "test-secret-for-connector" });
const verifier = () => randomBytes(32).toString("base64url");
const challenge = (v: string) => createHash("sha256").update(v).digest("base64url");

function redirectUrl(err: unknown): string {
  if (err instanceof Error && err.message === "REDIRECT" && "url" in err) return String((err as Error & { url: string }).url);
  throw err;
}

function hasTestId(node: ReactNode, id: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => hasTestId(child, id));
  const props = (node as { props?: { children?: ReactNode; "data-testid"?: string } }).props;
  if (!props) return false;
  if (props["data-testid"] === id) return true;
  return hasTestId(props.children, id);
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) return textOf((node as { props?: { children?: ReactNode } }).props?.children);
  return "";
}

function authorizeParams(clientId: string, v: string) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE,
    code_challenge: challenge(v),
    code_challenge_method: "S256",
    state: "s1",
    scope: "projects admin",
  };
}

function tokenFor(email: string) {
  return McpTokens.sign("access", { e: email, c: "client", s: ["projects", "admin"], exp: McpTokens.nowS() + 3600, jti: randomBytes(8).toString("hex") }, McpTokens.key()!);
}

function signedCode(email: string, clientId: string, codeChallenge: string) {
  return McpTokens.sign(
    "code",
    { e: email, c: McpTokens.clientHash(clientId), r: CLAUDE, cc: codeChallenge, s: ["projects", "admin"], exp: McpTokens.nowS() + 60, jti: randomBytes(8).toString("hex") },
    McpTokens.key()!,
  );
}

function signedRefresh(email: string, clientId: string) {
  return McpTokens.sign(
    "refresh",
    { e: email, c: McpTokens.clientHash(clientId), s: ["projects", "admin"], exp: McpTokens.nowS() + 3600, jti: randomBytes(8).toString("hex") },
    McpTokens.key()!,
  );
}

async function tokenEndpoint(fields: Record<string, string>) {
  const res = await postToken(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );
  const body = (await res.json()) as { error?: string; error_description?: string; access_token?: string; refresh_token?: string };
  return { status: res.status, body };
}

async function approveCode(clientId: string, v: string) {
  const params = authorizeParams(clientId, v);
  const form = new FormData();
  for (const [k, value] of Object.entries(params)) form.set(k, value);
  form.set("decision", "approve");
  const url = redirectUrl(await decideConnectorAccess(form).then(() => null, (e) => e));
  return { params, url, code: new URL(url).searchParams.get("code") };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await POST(
    new Request(`${ORIGIN}/api/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as { error?: string; error_description?: string; result?: { isError?: boolean; content?: { text: string }[] } };
  const text = body.result?.content?.[0]?.text ?? "";
  return { status: res.status, body, text, isError: Boolean(body.result?.isError) };
}

describe("Claude connector is limited to ADMIN_EMAILS", () => {
  beforeEach(() => {
    h.blocked.clear();
    h.deleteProject.mockClear();
    h.listProjects.mockClear();
    h.updateProject.mockClear();
    h.viewer = { email: MEMBER, isAdmin: true, name: null, roleId: "viewer", rank: 10, keys: [] };
    for (const [k, v] of Object.entries(ENV())) vi.stubEnv(k, v);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a non-admin at authorize and issues no code, even if the session claims admin", async () => {
    const client = McpOAuth.register({ redirect_uris: [CLAUDE], client_name: "Claude" }, McpTokens.key()!);
    const params = authorizeParams(client.client_id, verifier());
    const page = await ConnectorAuthorizePage({ searchParams: Promise.resolve(params) });
    expect(hasTestId(page, "connector-admin-only")).toBe(true);
    expect(textOf(page)).toContain(McpViewer.NOT_ADMIN_MESSAGE);
    expect(hasTestId(page, "connector-approve")).toBe(false);
    expect(hasTestId(page, "connector-consent")).toBe(false);

    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    form.set("decision", "approve");
    const url = redirectUrl(await decideConnectorAccess(form).then(() => null, (e) => e));
    expect(url.startsWith("/oauth/authorize")).toBe(true);
    expect(new URL(url, ORIGIN).searchParams.has("code")).toBe(false);
  });

  it("shows Allow for an admin and the approval redirect carries a code for that admin", async () => {
    h.viewer = { ...h.viewer, email: ADMIN, isAdmin: false };
    const client = McpOAuth.register({ redirect_uris: [CLAUDE], client_name: "Claude" }, McpTokens.key()!);
    const params = authorizeParams(client.client_id, verifier());
    const page = await ConnectorAuthorizePage({ searchParams: Promise.resolve(params) });
    expect(hasTestId(page, "connector-approve")).toBe(true);
    expect(hasTestId(page, "connector-admin-only")).toBe(false);

    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.set(k, v);
    form.set("decision", "approve");
    const url = redirectUrl(await decideConnectorAccess(form).then(() => null, (e) => e));
    const code = new URL(url).searchParams.get("code");
    expect(code).toBeTruthy();
    expect(McpTokens.verify("code", code, McpTokens.key())?.e).toBe(ADMIN);
  });

  it("returns 403 for a non-admin token on a tool call and does not run the tool", async () => {
    const res = await tool(tokenFor(MEMBER), "list_projects");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(res.body.error_description).toContain("not an admin");
    expect(h.listProjects).not.toHaveBeenCalled();
  });

  it("lets an admin read, write and delete, and still requires confirmed:true for delete", async () => {
    const token = tokenFor(ADMIN);
    const read = await tool(token, "list_projects");
    expect(read.status).toBe(200);
    expect(read.isError).toBe(false);
    expect(read.text).toContain("Valve Clinic");
    expect(h.listProjects).toHaveBeenCalledOnce();

    const write = await tool(token, "update_project", { projectId: PROJECT, changes: { latestUpdate: "Kickoff held." } });
    expect(write.status).toBe(200);
    expect(write.isError).toBe(false);
    expect(write.text).toContain("Kickoff held.");
    expect(h.updateProject).toHaveBeenCalledOnce();

    const unconfirmed = await tool(token, "run_app_action", { action: "delete_project", input: { projectId: PROJECT } });
    expect(unconfirmed.status).toBe(200);
    expect(unconfirmed.isError).toBe(true);
    expect(unconfirmed.text).toContain("confirmed: true");
    expect(h.deleteProject).not.toHaveBeenCalled();

    const deleted = await tool(token, "run_app_action", { action: "delete_project", input: { projectId: PROJECT }, confirmed: true });
    expect(deleted.status).toBe(200);
    expect(deleted.isError).toBe(false);
    expect(h.deleteProject).toHaveBeenCalledOnce();
  });

  it("refuses an admin removed from ADMIN_EMAILS on the next call", async () => {
    const token = tokenFor(ADMIN);
    expect((await tool(token, "list_projects")).status).toBe(200);
    vi.stubEnv("ADMIN_EMAILS", "");
    const again = await tool(token, "list_projects");
    expect(again.status).toBe(403);
    expect(again.body.error).toBe("forbidden");
    expect(h.listProjects).toHaveBeenCalledOnce();
  });

  it("a sign-in block cuts off an existing admin token on the next call", async () => {
    const token = tokenFor(ADMIN);
    h.blocked.add(ADMIN);
    const res = await tool(token, "list_projects");
    expect(res.status).toBe(401);
    expect(h.listProjects).not.toHaveBeenCalled();
  });

  it.each(["empty", "unset"] as const)("%s ADMIN_EMAILS refuses every allowlisted account at authorize, token and /api/mcp", async (mode) => {
    if (mode === "empty") vi.stubEnv("ADMIN_EMAILS", "");
    else vi.stubEnv("ADMIN_EMAILS", undefined);
    expect(process.env.ADMIN_EMAILS).toBe(mode === "empty" ? "" : undefined);

    for (const email of [ADMIN, MEMBER]) {
      h.viewer = { ...h.viewer, email, isAdmin: true };
      const v = verifier();
      const client = McpOAuth.register({ redirect_uris: [CLAUDE], client_name: "Claude" }, McpTokens.key()!);
      const params = authorizeParams(client.client_id, v);
      const page = await ConnectorAuthorizePage({ searchParams: Promise.resolve(params) });
      expect(hasTestId(page, "connector-admin-only")).toBe(true);
      expect(textOf(page)).toContain(McpViewer.NOT_ADMIN_MESSAGE);
      expect(hasTestId(page, "connector-approve")).toBe(false);
      expect(hasTestId(page, "connector-consent")).toBe(false);

      const form = new FormData();
      for (const [k, value] of Object.entries(params)) form.set(k, value);
      form.set("decision", "approve");
      const url = redirectUrl(await decideConnectorAccess(form).then(() => null, (e) => e));
      expect(url.startsWith("/oauth/authorize")).toBe(true);
      expect(new URL(url, ORIGIN).searchParams.has("code")).toBe(false);

      const exchanged = await tokenEndpoint({
        grant_type: "authorization_code",
        code: signedCode(email, client.client_id, params.code_challenge),
        code_verifier: v,
        client_id: client.client_id,
        redirect_uri: CLAUDE,
      });
      expect(exchanged.status).toBe(400);
      expect(exchanged.body.error).toBe("invalid_grant");
      expect(exchanged.body.access_token).toBeUndefined();

      const refreshed = await tokenEndpoint({
        grant_type: "refresh_token",
        refresh_token: signedRefresh(email, client.client_id),
        client_id: client.client_id,
      });
      expect(refreshed.status).toBe(400);
      expect(refreshed.body.error).toBe("invalid_grant");
      expect(refreshed.body.access_token).toBeUndefined();

      const mcp = await tool(tokenFor(email), "list_projects");
      expect(mcp.status).toBe(403);
      expect(mcp.body.error).toBe("forbidden");
    }
    expect(h.listProjects).not.toHaveBeenCalled();
  });

  it("matches an admin email with different capitalization and surrounding whitespace", async () => {
    const account = "  ADMIN.ONE@example.org  ";
    vi.stubEnv("ADMIN_EMAILS", "  Admin.One@Example.Org  ");
    h.viewer = { ...h.viewer, email: account, isAdmin: false };
    const v = verifier();
    const client = McpOAuth.register({ redirect_uris: [CLAUDE], client_name: "Claude" }, McpTokens.key()!);
    const params = authorizeParams(client.client_id, v);
    const page = await ConnectorAuthorizePage({ searchParams: Promise.resolve(params) });
    expect(hasTestId(page, "connector-approve")).toBe(true);
    expect(hasTestId(page, "connector-admin-only")).toBe(false);

    const { code } = await approveCode(client.client_id, v);
    expect(code).toBeTruthy();
    expect(McpTokens.verify("code", code, McpTokens.key())?.e).toBe(account);

    const exchanged = await tokenEndpoint({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: v,
      client_id: client.client_id,
      redirect_uri: CLAUDE,
    });
    expect(exchanged.status).toBe(200);
    expect(McpTokens.verify("access", exchanged.body.access_token, McpTokens.key())?.e).toBe(account);

    const read = await tool(exchanged.body.access_token!, "list_projects");
    expect(read.status).toBe(200);
    expect(read.isError).toBe(false);
    expect(read.text).toContain("Valve Clinic");
    expect(h.listProjects).toHaveBeenCalledOnce();

    const refreshed = await tokenEndpoint({
      grant_type: "refresh_token",
      refresh_token: exchanged.body.refresh_token!,
      client_id: client.client_id,
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
  });

  it("refuses a refresh_token grant after the account is removed from ADMIN_EMAILS", async () => {
    h.viewer = { ...h.viewer, email: ADMIN, isAdmin: true };
    const v = verifier();
    const client = McpOAuth.register({ redirect_uris: [CLAUDE], client_name: "Claude" }, McpTokens.key()!);
    const { code } = await approveCode(client.client_id, v);
    const issued = await tokenEndpoint({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: v,
      client_id: client.client_id,
      redirect_uri: CLAUDE,
    });
    expect(issued.status).toBe(200);

    vi.stubEnv("ADMIN_EMAILS", "other.admin@example.org");
    const again = await tokenEndpoint({
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token!,
      client_id: client.client_id,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    expect(again.body.error_description).toContain("cannot use the Claude connector");
    expect(again.body.access_token).toBeUndefined();
  });

  it("refuses a refresh_token grant after the account is blocked", async () => {
    h.viewer = { ...h.viewer, email: ADMIN, isAdmin: true };
    const v = verifier();
    const client = McpOAuth.register({ redirect_uris: [CLAUDE], client_name: "Claude" }, McpTokens.key()!);
    const { code } = await approveCode(client.client_id, v);
    const issued = await tokenEndpoint({
      grant_type: "authorization_code",
      code: code!,
      code_verifier: v,
      client_id: client.client_id,
      redirect_uri: CLAUDE,
    });
    expect(issued.status).toBe(200);

    h.blocked.add(ADMIN);
    const again = await tokenEndpoint({
      grant_type: "refresh_token",
      refresh_token: issued.body.refresh_token!,
      client_id: client.client_id,
    });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_grant");
    expect(again.body.error_description).toContain("cannot use the Claude connector");
    expect(again.body.access_token).toBeUndefined();
  });

  it("treats a password admin the same way McpViewer already treats admin rights", async () => {
    const db = {
      signInBlock: { findUnique: async () => null },
      appUser: { findUnique: async () => ({ addedBy: ADMIN, email: PASSWORD_ADMIN }) },
    };
    const env = { ALLOWED_EMAILS: "", ADMIN_EMAILS: PASSWORD_ADMIN };
    await expect(McpViewer.access(PASSWORD_ADMIN, env, db as never)).resolves.toMatchObject({ ok: true, viewer: { email: PASSWORD_ADMIN, isAdmin: true } });
    await expect(McpViewer.access(MEMBER, env, { ...db, appUser: { findUnique: async () => ({ addedBy: ADMIN, email: MEMBER }) } } as never)).resolves.toMatchObject({ ok: false, status: 403 });
  });
});
