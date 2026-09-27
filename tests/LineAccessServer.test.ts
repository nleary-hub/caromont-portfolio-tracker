import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Server-side enforcement (item 8) through the real pages, routes and Server Actions: the session viewer and
// Db.client are fakes; next/navigation's redirect and notFound throw so the tests can see them.
const h = vi.hoisted(() => ({ viewer: null as (Viewer & { name?: string | null }) | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
  usePathname: () => "/",
}));
vi.mock("@/auth", () => ({
  auth: async () => (h.viewer ? { user: { email: h.viewer.email } } : null),
  signOut: async () => undefined,
  signIn: async () => undefined,
  SIGN_IN_PATH: "/signin",
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const { default: DashboardPage } = await import("@/app/page");
const { default: ReportsPage } = await import("@/app/reports/page");
const { GET: archiveGET } = await import("@/app/reports/[id]/[file]/route");
const { GET: yearEndGET } = await import("@/app/reports/year-end/[id]/route");
const { GET: shareGET } = await import("@/app/api/share/[token]/[file]/route");
const { GET: cronGET } = await import("@/app/api/cron/freeze/route");
const { GET: exportGET } = await import("@/app/admin/import/export/route");
const { loadProjectHistory } = await import("@/app/actions/history");
const { switchServiceLine } = await import("@/app/actions/serviceLine");
const { setLineAccess, addAccessUser } = await import("@/app/actions/access");
const { NoAccessCard } = await import("@/components/NoAccessCard");
const { ProjectService } = await import("@/lib/services/ProjectService");
const { FreezeService } = await import("@/lib/services/FreezeService");
const { ExportService } = await import("@/lib/import/ExportService");
const { SignedLink } = await import("@/lib/report/SignedLink");
const { ServiceLine } = await import("@/lib/domain/ServiceLine");
const { config: proxyConfig } = await import("@/proxy");

const JANE = { email: "jane.doe@caromonthealth.org", isAdmin: false, name: "Jane Doe" };
const ADMIN = { ...Factory.ADMIN, name: "Admin" };
const SECRET = "s".repeat(48);
const ENV = {
  ALLOWED_EMAILS: "@caromonthealth.org @example.org",
  ADMIN_EMAILS: "admin@example.org",
  CRON_SECRET: "cron-secret-value-000000000000",
  SHARE_LINK_SECRET: SECRET,
  APP_BASE_URL: "https://tracker.example.org/",
  REPORT_RECIPIENT_EMAIL: "nick.leary@caromonthealth.org",
  GOOGLE_DRIVE_CLIENT_ID: "cid",
  GOOGLE_DRIVE_CLIENT_SECRET: "csecret",
  GOOGLE_DRIVE_REFRESH_TOKEN: "rtoken",
};
const FREEZE_RUN = new Date("2026-09-29T21:30:00Z"); // Tue 9/29 5:30 PM ET
const actor = { changedBy: "nick.leary@caromonthealth.org" };

let fake: FakeDb;
let ep: string;

class Drive {
  static json(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  /** Google Drive stand-in: token, folder lookup, uploads. */
  static fetch() {
    let n = 0;
    return vi.fn(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return Drive.json({ access_token: "at" });
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return Drive.json({ files: [{ id: "folder1" }] });
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) return Drive.json({ id: `file${++n}`, webViewLink: `https://drive.example/${n}` });
      throw new Error(`unexpected ${url}`);
    });
  }
}

class Page {
  static async render(page: (p: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>, params: Record<string, string> = {}): Promise<ReactElement> {
    return page({ searchParams: Promise.resolve(params) });
  }
}

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fake = new FakeDb();
  h.db = fake.asClient();
  h.viewer = null;
  ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
  await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "CVPSL secret project" }, actor, h.db as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pages: no line = the no-access card, and nothing else is read or sent", () => {
  it("dashboard and report archive show the card (email, sign out) without reading any project", async () => {
    h.viewer = JANE;
    const projectReads = vi.spyOn((h.db as { project: { findMany: () => unknown } }).project, "findMany");
    for (const page of [DashboardPage, ReportsPage]) {
      const el = await Page.render(page as never);
      expect(el.type).toBe(NoAccessCard);
      expect(Object.keys(el.props as object).sort()).toEqual(["email", "signOutAction"]);
      expect((el.props as { email: string }).email).toBe(JANE.email);
    }
    expect(projectReads).not.toHaveBeenCalled();
    // First sign-in recorded them (so they show up in the Access grid), with no lines.
    expect(fake.state.appUsers.map((u) => [u.email, u.name])).toEqual([[JANE.email, "Jane Doe"]]);
    expect(fake.state.accessGrants).toEqual([]);
  });

  it("a link to a line they lack names that line only and offers their first line", async () => {
    h.viewer = JANE;
    fake.grant(JANE.email, ep);
    const el = await Page.render(DashboardPage as never, { line: "CVPSL" });
    expect(el.type).toBe(NoAccessCard);
    expect(el.props).toMatchObject({ email: JANE.email, line: "CVPSL", goTo: { shortName: "EP", href: "/?line=EP" } });
    expect(JSON.stringify({ ...(el.props as object), signOutAction: null })).not.toMatch(/Cardiovascular|secret|00000000/i);
    const r = await Page.render(ReportsPage as never, { line: "CVPSL" });
    expect(r.props).toMatchObject({ line: "CVPSL", goTo: { shortName: "EP", href: "/reports?line=EP" } });
    // A link to their own line: saved, then the page reloads without the parameter.
    await expect(Page.render(DashboardPage as never, { line: "EP" })).rejects.toThrow("REDIRECT /");
  });

  it("someone with the line gets the page (not the card)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // the fake DB has no groupBy; the page shows its load error
    h.viewer = JANE;
    fake.grant(JANE.email, ServiceLine.DEFAULT_ID);
    const el = await Page.render(DashboardPage as never);
    expect(el.type).not.toBe(NoAccessCard);
  });
});

describe("routes and actions answer 404 / nothing without the line", () => {
  it("frozen report downloads, year-end PDFs and project history", async () => {
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: { ...ENV, GOOGLE_DRIVE_REFRESH_TOKEN: "" }, fetch: vi.fn() }, h.db as never);
    const snap = fake.state.snapshots[0];
    const project = fake.state.projects[0];
    const req = new Request("https://tracker.example.org/x");
    const ctx = { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) };
    h.viewer = JANE;
    expect((await archiveGET(req, ctx)).status).toBe(404);
    expect((await yearEndGET(req, { params: Promise.resolve({ id: "any" }) })).status).toBe(404);
    expect(await loadProjectHistory(project.id as string)).toBeNull();
    // With CVPSL access the same requests work.
    fake.grant(JANE.email, ServiceLine.DEFAULT_ID);
    expect((await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) })).status).toBe(200);
    expect(await loadProjectHistory(project.id as string)).not.toBeNull();
    // Access to EP only: CVPSL's report and project are not found.
    fake.state.accessGrants = [];
    fake.grant(JANE.email, ep);
    expect((await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) })).status).toBe(404);
    // The same empty answer as for a project that doesn't exist.
    expect(await loadProjectHistory(project.id as string)).toEqual(await loadProjectHistory("00000000-0000-4000-8000-00000000dead"));
    expect((await loadProjectHistory(project.id as string))?.entries).toEqual([]);
  });

  it("switching and the Access actions re-check on the server", async () => {
    h.viewer = JANE;
    fake.grant(JANE.email, ep);
    expect(await switchServiceLine(ServiceLine.DEFAULT_ID)).toEqual({ ok: false, message: "That service line is not available." });
    expect(await setLineAccess(JANE.email, ServiceLine.DEFAULT_ID, true)).toEqual({ ok: false, message: "Couldn't save access. Try again." });
    expect(await addAccessUser("x.y@caromonthealth.org")).toEqual({ ok: false, message: "Couldn't save access. Try again." });
    expect(fake.state.accessGrants.map((g) => g.serviceLineId)).toEqual([ep]);
    h.viewer = ADMIN;
    expect(await setLineAccess(JANE.email, ServiceLine.DEFAULT_ID, true)).toEqual({ ok: true, message: "Jane Doe can now see CVPSL." });
    expect(await addAccessUser("x.y@caromonthealth.org")).toEqual({ ok: true, message: "x.y@caromonthealth.org added." });
  });

  it("the proxy still leaves cron and share links to their own checks", () => {
    const m = proxyConfig.matcher[0];
    expect(m).toContain("api/cron/");
    expect(m).toContain("api/share/");
  });
});

describe("Frank: the Tuesday freeze runs with nobody signed in and nobody given access", () => {
  it("cron route: PDF and handoff.json stored, saved to Drive, archive link set; the signed share link serves both files", async () => {
    expect(fake.state.accessGrants).toEqual([]);
    h.viewer = null;
    vi.useFakeTimers({ toFake: ["Date"], now: FREEZE_RUN });
    const drive = Drive.fetch();
    vi.stubGlobal("fetch", drive);
    const res = await cronGET(new Request("https://tracker.example.org/api/cron/freeze", { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; delivery: string; period: { periodEnd: string } };
    expect(body).toMatchObject({ outcome: "created", delivery: "drive", period: { periodEnd: "2026-09-29" } });
    const kinds = fake.state.artifacts.map((a) => [a.kind, a.fileName]);
    expect(kinds).toEqual([
      ["pdf", "cardiac-portfolio-report-2026-09-29.pdf"],
      ["handoff", "handoff-2026-09-29.json"],
    ]);
    const handoff = JSON.parse(Buffer.from(fake.state.artifacts[1].bytes as Uint8Array).toString("utf8")) as { archiveUrl: string; totals: { projects: number } };
    expect(handoff.archiveUrl).toBe("https://tracker.example.org/reports");
    expect(handoff.totals.projects).toBe(1);
    expect(drive.mock.calls.filter((c) => String(c[0]).includes("/upload/"))).toHaveLength(2);
    expect(fake.state.deliveries.map((d) => [d.method, d.status])).toEqual([["drive", "ok"]]);

    // The signed fallback link (no sign-in, no access rows) still serves both files.
    const snap = fake.state.snapshots[0];
    const token = SignedLink.sign(snap.id as string, new Date("2026-10-06T21:00:00Z"), SECRET);
    for (const file of ["pdf", "handoff"]) {
      const r = await shareGET(new Request("https://tracker.example.org/"), { params: Promise.resolve({ token, file }) });
      expect(r.status, file).toBe(200);
    }
    // Wrong bearer: nothing runs.
    const denied = await cronGET(new Request("https://tracker.example.org/api/cron/freeze", { headers: { authorization: "Bearer nope" } }));
    expect(denied.status).toBe(401);
  });
});

describe("#36: the share-link fallback and the freeze stay outside sign-in and turn-off checks", () => {
  /** Next's matcher is a path regex; these paths must stay out of the auth proxy. */
  const proxied = (path: string) => new RegExp(`^${proxyConfig.matcher[0]}$`).test(path);

  it("the proxy (Auth.js) never runs for /api/cron/freeze or /api/share/*, and still runs for app pages", () => {
    expect(proxied("/api/cron/freeze")).toBe(false);
    expect(proxied("/api/share/some.token/pdf")).toBe(false);
    expect(proxied("/api/share/some.token/handoff")).toBe(false);
    expect(proxied("/admin/people")).toBe(true);
    expect(proxied("/reports")).toBe(true);
    expect(proxied("/")).toBe(true);
  });

  it("/api/share works with no session and never reads sign-in data, even when the report recipient is turned off; a bad token is the app's own 404", async () => {
    h.viewer = null;
    vi.useFakeTimers({ toFake: ["Date"], now: FREEZE_RUN });
    vi.stubGlobal("fetch", Drive.fetch());
    expect((await cronGET(new Request("https://tracker.example.org/api/cron/freeze", { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }))).status).toBe(200);
    const snap = fake.state.snapshots[0];
    const token = SignedLink.sign(snap.id as string, new Date("2026-10-06T21:00:00Z"), SECRET);

    // No session, and any read of the sign-in tables (turned off, passwords, attempts) or of auth() fails the test.
    const touched: string[] = [];
    const SIGN_IN_TABLES = new Set(["signInBlock", "passwordCredential", "passwordSignInAttempt", "passwordCredentialHistory"]);
    const client = h.db as Record<string, unknown>;
    h.db = new Proxy(client, {
      get(target, key) {
        if (typeof key === "string" && SIGN_IN_TABLES.has(key)) touched.push(key);
        return Reflect.get(target, key);
      },
    });
    const authMod = await import("@/auth");
    const authSpy = vi.spyOn(authMod, "auth");
    for (const file of ["pdf", "handoff"]) {
      const r = await shareGET(new Request("https://tracker.example.org/"), { params: Promise.resolve({ token, file }) });
      expect(r.status, file).toBe(200);
      expect((await r.arrayBuffer()).byteLength, file).toBeGreaterThan(0);
    }
    expect(touched).toEqual([]);
    expect(authSpy).not.toHaveBeenCalled();

    // Invalid, tampered or expired tokens and unknown files: the route's own plain 404, not a sign-in redirect.
    const expired = SignedLink.sign(snap.id as string, new Date("2026-09-01T00:00:00Z"), SECRET);
    for (const [t, file] of [["not-a-token", "pdf"], [`${token}x`, "pdf"], [expired, "pdf"], [token, "other"]]) {
      const r = await shareGET(new Request("https://tracker.example.org/"), { params: Promise.resolve({ token: t, file }) });
      expect(r.status, `${t} ${file}`).toBe(404);
      expect(r.headers.get("location")).toBeNull();
      expect(await r.text()).toBe("Not found");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("Writing Bot: the live project export for CVPSL", () => {
  it("CLI export (npm run export:csv, DATABASE_URL, no app sign-in) is CVPSL and ignores access rows", async () => {
    expect(fake.state.accessGrants).toEqual([]);
    const { csv, count } = await ExportService.exportCsv(h.db as never);
    expect(count).toBe(1);
    expect(csv).toContain("CVPSL secret project");
  });

  it("the web export (/admin/import/export) works for an admin with no access rows; non-admins still get 404", async () => {
    h.viewer = ADMIN;
    const res = await exportGET();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("CVPSL secret project");
    h.viewer = JANE;
    fake.grant(JANE.email, ServiceLine.DEFAULT_ID);
    await expect(exportGET()).rejects.toThrow("NOT_FOUND");
  });
});
