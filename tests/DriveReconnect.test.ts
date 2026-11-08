import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Report freeze > Reconnect Drive: the Owner renews the app's Drive sign-in in the browser. Owner only on the server,
// state and PKCE against CSRF, scope drive.file only with offline access and forced consent, the refresh token kept
// encrypted in the database (preferred over GOOGLE_DRIVE_REFRESH_TOKEN, which stays the fallback), and no token, code
// or client secret in a log, a URL we build back to the app, or the page. All values here are fictional.
const h = vi.hoisted(() => ({ session: null as unknown, db: null as unknown }));
vi.mock("@/auth", () => ({ auth: async () => h.session, signOut: async () => undefined, signIn: async () => undefined, SIGN_IN_PATH: "/signin" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/db/Db", () => ({
  Db: {
    get client() {
      if (!h.db) throw new Error("DATABASE_URL is not set");
      return h.db;
    },
    isConfigured: () => Boolean(h.db),
  },
}));

const { NextRequest } = await import("next/server");
const { POST: CONNECT } = await import("@/app/api/drive/connect/route");
const { GET: CALLBACK } = await import("@/app/api/drive/callback/route");
const { DriveOAuth } = await import("@/lib/report/DriveOAuth");
const { DriveConnection } = await import("@/lib/report/DriveConnection");
const { DriveConnectText } = await import("@/lib/report/DriveConnectText");
const { AiKeyCipher } = await import("@/lib/ai/AiKeyCipher");
const { DriveCheckService } = await import("@/lib/services/DriveCheckService");
const { ReportDeliveryService } = await import("@/lib/services/ReportDeliveryService");

const ORIGIN = "https://tracker.example.org";
const KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
const ENV = {
  GOOGLE_DRIVE_CLIENT_ID: "cid-fiction.apps.googleusercontent.com",
  GOOGLE_DRIVE_CLIENT_SECRET: "csecret-fiction-value",
  AI_SETTINGS_ENCRYPTION_KEY: KEY,
  APP_BASE_URL: ORIGIN,
};
const BASE = { ALLOWED_EMAILS: "@example.org", ADMIN_EMAILS: "admin@example.org,other-admin@example.org", OWNER_EMAIL: "admin@example.org" };
const OWNER = { user: { email: "admin@example.org" } };
const NEW_TOKEN = "1//new-refresh-token-fiction";
const CODE = "4/auth-code-fiction";

/** The one drive_connection row, in memory. */
class FakeConnectionDb {
  row: { id: number; refreshTokenCiphertext: string; connectedAt: Date; connectedBy: string } | null = null;
  upserts = 0;
  driveConnection = {
    findUnique: async () => this.row,
    upsert: async (args: { create: { id: number; refreshTokenCiphertext: string; connectedAt: Date; connectedBy: string }; update: { refreshTokenCiphertext: string; connectedAt: Date; connectedBy: string } }) => {
      this.upserts++;
      this.row = this.row ? { ...this.row, ...args.update } : { ...args.create };
      return this.row;
    },
  };
}

const logs: string[] = [];
beforeEach(() => {
  for (const [k, v] of Object.entries({ ...BASE, ...ENV })) vi.stubEnv(k, v);
  logs.length = 0;
  for (const m of ["info", "warn", "error", "log"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
  h.session = null;
  h.db = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const connectReq = (headers: Record<string, string> = { origin: ORIGIN }, url = `${ORIGIN}/api/drive/connect`) => new NextRequest(url, { method: "POST", headers });
const callbackReq = (query: Record<string, string>, cookie?: string) =>
  new NextRequest(`${ORIGIN}/api/drive/callback?${new URLSearchParams(query)}`, { headers: cookie ? { cookie: `${DriveOAuth.COOKIE}=${cookie}` } : {} });
const setCookie = (res: Response) => res.headers.getSetCookie().join("\n");

/** Starts a real round trip as the Owner: Google's URL and the cookie value. */
async function start(): Promise<{ google: URL; cookie: string }> {
  h.session = OWNER;
  const res = await CONNECT(connectReq());
  expect(res.status).toBe(303);
  const cookie = /drive_oauth=([^;]+)/.exec(setCookie(res))![1];
  return { google: new URL(res.headers.get("location")!), cookie };
}

/** Google's token endpoint: answers the code exchange. */
function google(body: unknown, status = 200) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}
const GRANT = { access_token: "ya29.fiction", expires_in: 3599, refresh_token: NEW_TOKEN, scope: DriveOAuth.SCOPE, token_type: "Bearer" };

describe("Reconnect Drive: starting (POST /api/drive/connect)", () => {
  it("no session, a viewer or an admin who isn't the Owner gets the generic 404, no cookie and no redirect", async () => {
    for (const session of [null, { user: { email: "jane@example.org" } }, { user: { email: "other-admin@example.org" } }]) {
      h.session = session;
      const res = await CONNECT(connectReq());
      expect(res.status).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(setCookie(res)).toBe("");
      expect(await res.text()).not.toMatch(/drive|google|oauth/i);
    }
  });

  it("the Owner goes to Google's consent page: drive.file only, offline access, forced consent, state and PKCE S256", async () => {
    const { google: url, cookie } = await start();
    expect(url.origin + url.pathname).toBe(DriveOAuth.AUTH_URL);
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(ENV.GOOGLE_DRIVE_CLIENT_ID);
    expect(p.get("redirect_uri")).toBe(`${ORIGIN}/api/drive/callback`);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.has("client_secret")).toBe(false);
    const [state, verifier] = cookie.split(".");
    expect(p.get("state")).toBe(state);
    expect(p.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(p.get("code_challenge")).not.toBe(verifier);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("the state cookie is httpOnly, Secure, SameSite=Lax, scoped to /api/drive and lives 10 minutes", async () => {
    h.session = OWNER;
    const c = setCookie(await CONNECT(connectReq())).toLowerCase();
    expect(c).toContain("httponly");
    expect(c).toContain("secure");
    expect(c).toContain("samesite=lax");
    expect(c).toContain("path=/api/drive");
    expect(c).toContain("max-age=600");
  });

  it("each start makes a fresh state and verifier", async () => {
    const a = await start();
    const b = await start();
    expect(a.cookie).not.toBe(b.cookie);
  });

  it("a cross-site POST (another Origin) gets the 404, even for the Owner", async () => {
    h.session = OWNER;
    const res = await CONNECT(connectReq({ origin: "https://evil.example.net" }));
    expect(res.status).toBe(404);
    expect(setCookie(res)).toBe("");
  });

  it("can't start: preview, no client, no encryption key, no base URL, another host; back to /reports with the reason", async () => {
    h.session = OWNER;
    const cases: [Record<string, string>, string][] = [
      [{ VERCEL_ENV: "preview" }, "preview"],
      [{ GOOGLE_DRIVE_CLIENT_SECRET: "" }, "not_configured"],
      [{ AI_SETTINGS_ENCRYPTION_KEY: "" }, "no_key"],
      [{ APP_BASE_URL: "", VERCEL_PROJECT_PRODUCTION_URL: "" }, "no_base_url"],
      [{ APP_BASE_URL: "https://elsewhere.example.org" }, "wrong_host"],
    ];
    for (const [env, code] of cases) {
      for (const [k, v] of Object.entries({ ...BASE, ...ENV, VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "" })) vi.stubEnv(k, v);
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const res = await CONNECT(connectReq());
      expect(res.status, code).toBe(303);
      expect(res.headers.get("location")).toBe(`${ORIGIN}/reports?drive=${code}`);
      expect(setCookie(res), code).toBe("");
      expect(DriveConnectText.message(code)?.ok).toBe(false);
    }
  });
});

describe("Reconnect Drive: Google sends the Owner back (GET /api/drive/callback)", () => {
  it("anyone but the Owner gets the 404: no code exchange, nothing saved, cookie cleared", async () => {
    const { google: url, cookie } = await start();
    const fetchSpy = google(GRANT);
    vi.stubGlobal("fetch", fetchSpy);
    const db = new FakeConnectionDb();
    h.db = db;
    for (const session of [null, { user: { email: "jane@example.org" } }, { user: { email: "other-admin@example.org" } }]) {
      h.session = session;
      const res = await CALLBACK(callbackReq({ state: url.searchParams.get("state")!, code: CODE }, cookie));
      expect(res.status).toBe(404);
      expect(setCookie(res)).toMatch(/drive_oauth=; Path=\/api\/drive; Max-Age=0/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.upserts).toBe(0);
  });

  it("a wrong, missing or forged state is refused before any exchange, and the cookie is cleared", async () => {
    const { google: url, cookie } = await start();
    const state = url.searchParams.get("state")!;
    const fetchSpy = google(GRANT);
    vi.stubGlobal("fetch", fetchSpy);
    const db = new FakeConnectionDb();
    h.db = db;
    const other = "A".repeat(43);
    const cases: [Record<string, string>, string | undefined][] = [
      [{ state: other, code: CODE }, cookie], // attacker's state
      [{ code: CODE }, cookie], // no state
      [{ state, code: CODE }, undefined], // no cookie (another browser)
      [{ state, code: CODE }, `${other}.${cookie.split(".")[1]}`], // cookie from another flow
      [{ state, code: CODE }, "not-a-cookie"],
      [{ state: state.slice(0, 42), code: CODE }, cookie],
      [{ state }, cookie], // no code
    ];
    for (const [q, c] of cases) {
      h.session = OWNER;
      const res = await CALLBACK(callbackReq(q, c));
      expect(res.headers.get("location"), JSON.stringify(q)).toBe(`${ORIGIN}/reports?drive=bad_state`);
      expect(setCookie(res)).toMatch(/drive_oauth=; Path=\/api\/drive; Max-Age=0/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.upserts).toBe(0);
  });

  it("the Owner who cancels at Google comes back with 'denied' and nothing is saved", async () => {
    const { google: url, cookie } = await start();
    const fetchSpy = google(GRANT);
    vi.stubGlobal("fetch", fetchSpy);
    h.db = new FakeConnectionDb();
    const res = await CALLBACK(callbackReq({ state: url.searchParams.get("state")!, error: "access_denied" }, cookie));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/reports?drive=denied`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("success: swaps the code with the PKCE verifier, saves the refresh token encrypted, and logs no secret", async () => {
    const { google: url, cookie } = await start();
    const fetchSpy = google(GRANT);
    vi.stubGlobal("fetch", fetchSpy);
    const db = new FakeConnectionDb();
    h.db = db;
    const res = await CALLBACK(callbackReq({ state: url.searchParams.get("state")!, code: CODE, scope: DriveOAuth.SCOPE }, cookie));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/reports?drive=connected`);
    expect(setCookie(res)).toMatch(/drive_oauth=; Path=\/api\/drive; Max-Age=0/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [tokenUrl, init] = fetchSpy.mock.calls[0];
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(String(init!.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe(CODE);
    expect(body.get("code_verifier")).toBe(cookie.split(".")[1]);
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/api/drive/callback`);
    expect(body.get("client_id")).toBe(ENV.GOOGLE_DRIVE_CLIENT_ID);
    expect(body.get("client_secret")).toBe(ENV.GOOGLE_DRIVE_CLIENT_SECRET);

    expect(db.row!.connectedBy).toBe("admin@example.org");
    expect(db.row!.refreshTokenCiphertext).toMatch(/^v1:/);
    expect(db.row!.refreshTokenCiphertext).not.toContain(NEW_TOKEN);
    expect(AiKeyCipher.decrypt(db.row!.refreshTokenCiphertext, Buffer.from(KEY, "base64"), DriveConnection.BINDING)).toBe(NEW_TOKEN);
    // Bound to its own column: the same ciphertext doesn't decrypt as an AI provider key.
    expect(AiKeyCipher.decrypt(db.row!.refreshTokenCiphertext, Buffer.from(KEY, "base64"), AiKeyCipher.providerBinding("openai"))).toBeNull();

    const all = [...logs, res.headers.get("location")!, setCookie(res)].join("\n");
    for (const secret of [NEW_TOKEN, CODE, ENV.GOOGLE_DRIVE_CLIENT_SECRET, "ya29.fiction", cookie.split(".")[1]]) expect(all).not.toContain(secret);
  });

  it("Google refuses the code: 'exchange_failed', only Google's error code is logged, nothing saved", async () => {
    const { google: url, cookie } = await start();
    vi.stubGlobal("fetch", google({ error: "invalid_grant", error_description: "Bad Request leaked-detail-fiction" }, 400));
    const db = new FakeConnectionDb();
    h.db = db;
    const res = await CALLBACK(callbackReq({ state: url.searchParams.get("state")!, code: CODE }, cookie));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/reports?drive=exchange_failed`);
    expect(db.upserts).toBe(0);
    expect(logs.join("\n")).toContain("invalid_grant");
    expect(logs.join("\n")).not.toContain("leaked-detail-fiction");
    expect(logs.join("\n")).not.toContain(CODE);
  });

  it("no refresh token, or the Drive box unticked at Google: refused, nothing saved", async () => {
    for (const [grant, code] of [
      [{ ...GRANT, refresh_token: undefined }, "no_refresh_token"],
      [{ ...GRANT, scope: "openid email" }, "scope_missing"],
    ] as const) {
      const { google: url, cookie } = await start();
      vi.stubGlobal("fetch", google(grant));
      const db = new FakeConnectionDb();
      h.db = db;
      const res = await CALLBACK(callbackReq({ state: url.searchParams.get("state")!, code: CODE }, cookie));
      expect(res.headers.get("location")).toBe(`${ORIGIN}/reports?drive=${code}`);
      expect(db.upserts).toBe(0);
    }
  });

  it("on a preview the callback refuses before any exchange", async () => {
    const { google: url, cookie } = await start();
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchSpy = google(GRANT);
    vi.stubGlobal("fetch", fetchSpy);
    h.db = new FakeConnectionDb();
    const res = await CALLBACK(callbackReq({ state: url.searchParams.get("state")!, code: CODE }, cookie));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/reports?drive=preview`);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("DriveConnection.resolve: the saved token first, GOOGLE_DRIVE_REFRESH_TOKEN as the fallback", () => {
  const env = { ...ENV, GOOGLE_DRIVE_REFRESH_TOKEN: "env-token-fiction", GOOGLE_DRIVE_FOLDER_ID: "folder1" };

  it("prefers the token saved by Reconnect Drive", async () => {
    const db = new FakeConnectionDb();
    await DriveConnection.save(db, NEW_TOKEN, "admin@example.org", env);
    expect(await DriveConnection.resolve(env, db)).toEqual({ clientId: env.GOOGLE_DRIVE_CLIENT_ID, clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET, folderId: "folder1", refreshToken: NEW_TOKEN, source: "connected" });
  });

  it("falls back to the env var with no saved row, a different key, no key, a preview, or a database error", async () => {
    const saved = new FakeConnectionDb();
    await DriveConnection.save(saved, NEW_TOKEN, "admin@example.org", env);
    const broken = { driveConnection: { findUnique: async () => { throw new Error("relation does not exist"); }, upsert: async () => null } };
    const cases: [Record<string, string | undefined>, unknown][] = [
      [env, new FakeConnectionDb()],
      [{ ...env, AI_SETTINGS_ENCRYPTION_KEY: OTHER_KEY }, saved],
      [{ ...env, AI_SETTINGS_ENCRYPTION_KEY: undefined }, saved],
      [{ ...env, VERCEL_ENV: "preview" }, saved],
      [env, broken],
    ];
    for (const [e, db] of cases) {
      const r = await DriveConnection.resolve(e, db as never);
      expect(r?.refreshToken).toBe("env-token-fiction");
      expect(r?.source).toBe("env");
    }
  });

  it("null without the client ID and secret, and null with neither token", async () => {
    const db = new FakeConnectionDb();
    await DriveConnection.save(db, NEW_TOKEN, "admin@example.org", env);
    expect(await DriveConnection.resolve({ ...env, GOOGLE_DRIVE_CLIENT_ID: "" }, db)).toBeNull();
    expect(await DriveConnection.resolve(ENV, new FakeConnectionDb())).toBeNull();
  });

  it("works with only a saved token (GOOGLE_DRIVE_REFRESH_TOKEN removed later)", async () => {
    const db = new FakeConnectionDb();
    await DriveConnection.save(db, NEW_TOKEN, "admin@example.org", ENV);
    expect((await DriveConnection.resolve(ENV, db))?.refreshToken).toBe(NEW_TOKEN);
  });

  it("save refuses without a usable key (nothing is ever stored in plain text)", async () => {
    const db = new FakeConnectionDb();
    await expect(DriveConnection.save(db, NEW_TOKEN, "admin@example.org", { ...ENV, AI_SETTINGS_ENCRYPTION_KEY: "" })).rejects.toThrow();
    expect(db.row).toBeNull();
  });

  it("Check Drive refreshes with the saved token, not the expired env one", async () => {
    const db = new FakeConnectionDb();
    await DriveConnection.save(db, NEW_TOKEN, "admin@example.org", env);
    const refreshBodies: string[] = [];
    const fake = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") {
        refreshBodies.push(String(init?.body));
        return new Response('{"error":"invalid_grant"}', { status: 400 });
      }
      return new Response("{}", { status: 500 });
    });
    await DriveCheckService.run(env, fake, () => new Date("2026-11-04T12:00:00Z"), db);
    expect(new URLSearchParams(refreshBodies[0]).get("refresh_token")).toBe(NEW_TOKEN);
  });

  it("the freeze's redelivery decision counts a saved token when FreezeService says Drive is ready", () => {
    const linkOnly = ReportDeliveryService.parse({ status: "signed_link" });
    expect(ReportDeliveryService.needsDelivery(linkOnly, ENV)).toBe(false);
    expect(ReportDeliveryService.needsDelivery(linkOnly, ENV, true)).toBe(true);
    expect(ReportDeliveryService.needsDelivery(ReportDeliveryService.parse({ status: "drive" }), ENV, true)).toBe(false);
  });
});

describe("Reconnect Drive button and result line", () => {
  it("a plain form POST to the connect route; disabled with the note on a preview", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { ReconnectDriveButton } = await import("@/components/ReconnectDriveButton");
    expect(DriveOAuth.CONNECT_PATH).toBe(DriveConnectText.CONNECT_PATH);
    const on = renderToStaticMarkup(createElement(ReconnectDriveButton, {}));
    expect(on).toMatch(/<form [^>]*action="\/api\/drive\/connect" method="post">/);
    expect(on).toMatch(/<button type="submit"[^>]*data-testid="drive-reconnect">Reconnect Drive<\/button>/);
    expect(on).not.toContain(`disabled=""`);
    const off = renderToStaticMarkup(createElement(ReconnectDriveButton, { disabledNote: DriveConnectText.PREVIEW_OFF }));
    expect(off).toMatch(/<button type="submit" disabled=""/);
    expect(off).toContain(DriveConnectText.PREVIEW_OFF);
    const ok = renderToStaticMarkup(createElement(ReconnectDriveButton, { message: DriveConnectText.message("connected"), connectedNote: DriveConnectText.connected("Nov 4, 2026, 9:12 AM ET") }));
    expect(ok).toContain("text-(--status-on-track-dark-fg)");
    expect(ok).toContain("Connected in the app Nov 4, 2026, 9:12 AM ET.");
    const bad = renderToStaticMarkup(createElement(ReconnectDriveButton, { message: DriveConnectText.message("bad_state") }));
    expect(bad).toContain("text-danger");
    const uri = `${ORIGIN}/api/drive/callback`;
    expect(renderToStaticMarkup(createElement(ReconnectDriveButton, { redirectNote: DriveConnectText.redirectNote(uri) }))).toContain(`must list ${uri} as an authorized redirect URI`);
    expect(DriveConnectText.message("wrong_host", "tracker.example.org")!.text).toContain("Open the tracker at tracker.example.org");
  });

  it("only known codes show a line (the query string isn't trusted), and the copy has no em dashes or secrets", () => {
    for (const code of [undefined, "", "toString", "__proto__", "<script>", ["connected"]]) expect(DriveConnectText.message(code as never)).toBeNull();
    for (const code of ["connected", "denied", "bad_state", "exchange_failed", "no_refresh_token", "scope_missing", "save_failed", "preview", "not_configured", "no_key", "no_base_url", "wrong_host"]) {
      const m = DriveConnectText.message(code)!;
      expect(m.text).not.toMatch(/—/);
      expect(m.text).not.toMatch(/REFRESH_TOKEN|token/i);
    }
  });
});
