import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { ROLE_DEFAULTS } from "@/lib/permissions";

// Security fix (PR #96 review): "Generate PDF now" needs report.pdf.onDemand on the server, in the route and in
// DraftReportService.render, before any data load, PDF render or display-settings save. Real Prisma on PGlite.
// Fictional people only.
const state = vi.hoisted(() => ({ client: null as unknown, viewer: null as unknown }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return state.client; }, isConfigured: () => true } }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => state.viewer } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

import { GET } from "@/app/api/reports/preview/route";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportDataLoader } from "@/lib/report/ReportDataLoader";
import { DraftReportService } from "@/lib/services/DraftReportService";

const ENV = { OWNER_EMAIL: "jordan.pike@example.org", ADMIN_EMAILS: "casey.lund@example.org" };
const DEFAULT_LINE = "00000000-0000-4000-8000-000000000001";
const keysOf = (id: string) => [...ROLE_DEFAULTS.find((r) => r.id === id)!.keys];
const OWNER = { email: "jordan.pike@example.org", isAdmin: true, name: "Jordan Pike" };
const ADMIN_NO_PDF = { email: "casey.lund@example.org", isAdmin: true, roleId: "admin", rank: 50, keys: keysOf("admin").filter((k) => k !== "report.pdf.onDemand"), name: "Casey Lund" };
const MEMBER = { email: "riley.moss@example.org", isAdmin: false, roleId: "viewer", rank: 10, keys: keysOf("viewer"), name: "Riley Moss" };
const MEMBER_NO_PDF = { ...MEMBER, keys: MEMBER.keys.filter((k) => k !== "report.pdf.onDemand") };
const URL_ = "http://127.0.0.1/api/reports/preview";

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
const settingsRows = async () => Number((await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_display_settings`)).rows[0].n);

beforeAll(async () => {
  pg = await PGlite.create();
  const dir = path.resolve(__dirname, "../prisma/migrations");
  for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await pg.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
  await pg.exec(`INSERT INTO app_user (email, name, "roleId") VALUES ('riley.moss@example.org', 'Riley Moss', 'viewer')`);
  await pg.query(`INSERT INTO service_line_access (email, "serviceLineId", "grantedBy") VALUES ('riley.moss@example.org', $1, 'seed@example.org')`, [DEFAULT_LINE]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
  state.client = prisma;
}, 60_000);
afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
});
beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  await pg.exec(`DELETE FROM report_display_settings`);
});
afterEach(() => vi.restoreAllMocks());

const spies = () => ({ load: vi.spyOn(ReportDataLoader, "load"), pdf: vi.spyOn(PdfReportRenderer, "renderDocument"), save: vi.spyOn(DraftReportService, "saveDisplaySettings") });

describe("GET /api/reports/preview without report.pdf.onDemand", () => {
  it.each([["a member", MEMBER_NO_PDF], ["an admin", ADMIN_NO_PDF]])("answers 404 for %s with no data load, no PDF and no settings save", async (_label, viewer) => {
    const s = spies();
    state.viewer = viewer;
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").not.toContain("application/pdf");
    expect(s.load).not.toHaveBeenCalled();
    expect(s.pdf).not.toHaveBeenCalled();
    expect(s.save).not.toHaveBeenCalled();
    expect(await settingsRows()).toBe(0);
  });
  it("still answers 404 for no viewer", async () => {
    state.viewer = null;
    expect((await GET(new Request(URL_))).status).toBe(404);
  });
});

describe("DraftReportService.render called directly without report.pdf.onDemand", () => {
  it.each([["a member", MEMBER_NO_PDF], ["an admin", ADMIN_NO_PDF]])("returns null for %s before any data load, render or save", async (_label, viewer) => {
    const s = spies();
    expect(await DraftReportService.render(viewer, prisma)).toBeNull();
    expect(s.load).not.toHaveBeenCalled();
    expect(s.pdf).not.toHaveBeenCalled();
    expect(s.save).not.toHaveBeenCalled();
    expect(await settingsRows()).toBe(0);
  });
});

describe("authorized on-demand PDFs still work", () => {
  it.each([["the Owner", OWNER], ["a member with the key and line access", MEMBER]])("renders for %s through the route", async (_label, viewer) => {
    state.viewer = viewer;
    const res = await GET(new Request(URL_));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await settingsRows()).toBe(1);
  }, 60_000);
});
