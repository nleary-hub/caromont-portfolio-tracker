import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Roles & Permissions: on-demand year-end report (matrix 4.8, Y1/Y2, Y-T1 to Y-T4). Fictional people and projects only.
const h = vi.hoisted(() => ({ viewer: null as unknown, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { FakeDb } = await import("./helpers/FakeDb");
const { Factory } = await import("./helpers/factories");
const { ServiceLine } = await import("@/lib/domain/ServiceLine");
const { roleSeed } = await import("@/lib/permissions");
const { ReportsPageData } = await import("@/lib/report/ReportsPageData");
const { YearEndOnDemand } = await import("@/lib/report/YearEndOnDemand");
const { YearEndOnDemandCopy } = await import("@/lib/report/YearEndOnDemandCopy");
const { YearEndReportService } = await import("@/lib/services/YearEndReportService");
const reports = await import("@/app/actions/reports");
const route = await import("@/app/api/reports/year-end/route");

const OWNER_EMAIL = "riley.owner@example.org";
const KEY = "report.yearEnd.onDemand";
/** A stored role, optionally with the on-demand key granted (as the Owner can per role). */
const person = (roleId: string, grant: boolean) => {
  const seed = roleSeed(roleId)!;
  const keys = grant ? [...new Set([...seed.keys, KEY])] : seed.keys.filter((k) => k !== KEY);
  return { email: `${roleId}.sample@example.org`, isAdmin: roleId === "admin", name: `Sample ${roleId}`, roleId, rank: seed.rank, keys };
};
const ROLES = ["admin", "director", "manager", "editor", "viewer"] as const;
const REVEALING = [/freez/i, /frozen/i, /snapshot/i, /handoff/i, /delivery/i, /next freeze/i, /stored report archive/i, /saved report archive/i, /\/reports\/year-end\//i];
const AT = new Date("2026-09-27T16:00:00Z");

let fake: InstanceType<typeof FakeDb>;
beforeEach(() => {
  vi.stubEnv("OWNER_EMAIL", OWNER_EMAIL);
  vi.stubEnv("ADMIN_EMAILS", OWNER_EMAIL);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeDb();
  fake.state.projects.push({ ...Factory.project(), name: "Sample Intake Refresh", status: "Complete", completedOn: Factory.date("2026-02-01"), createdAt: new Date("2025-03-01T15:00:00Z"), serviceLineId: ServiceLine.DEFAULT_ID });
  for (const r of ROLES) fake.grant(`${r}.sample@example.org`, ServiceLine.DEFAULT_ID);
  h.db = fake.asClient();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.viewer = null;
});

const get = (q = "?fy=FY26") => route.GET(new Request(`http://localhost/api/reports/year-end${q}`));

describe("Y-T1: on-demand generate stores nothing", () => {
  it.each(ROLES)("%s holding the key gets a PDF attachment; no year_end_report row, create never called", async (roleId) => {
    h.viewer = person(roleId, true);
    const before = fake.state.yearEndReports.length;
    const db = h.db as { yearEndReport: { create: (...a: unknown[]) => unknown } };
    const create = vi.spyOn(db.yearEndReport, "create");
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="year-end-fy26-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(fake.state.yearEndReports.length).toBe(before);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(ROLES)("%s calling the storing action gets Not found. and no row", async (roleId) => {
    h.viewer = person(roleId, true);
    expect(await reports.generateYearEndReport("FY26")).toEqual({ ok: false, message: "Not found." });
    expect(fake.state.yearEndReports.length).toBe(0);
  });

  it("the bytes equal the Owner's stored render of the same data", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);
    const owner = { email: OWNER_EMAIL, isAdmin: true, name: "Riley Owner" };
    await YearEndReportService.generate(owner, "FY26", ServiceLine.defaultScope(), h.db as never, AT);
    const stored = Buffer.from(fake.state.yearEndReports[0].bytes as Uint8Array);
    const live = await YearEndOnDemand.render(owner, "FY26", ServiceLine.defaultScope(), h.db as never, AT);
    vi.useRealTimers();
    expect(live!.bytes.equals(stored)).toBe(true);
  });
});

describe("Y-T2: separation", () => {
  const FORBIDDEN = /FreezeGuard|FreezeService|ReportArchiveService|ReportDeliveryService|SnapshotService|StoredPdf|HandoffBuilder|ReportLog|YearEndReportService|ReportHttp|reportSnapshot|yearEndReport\./;
  it.each(["src/lib/report/YearEndOnDemand.ts", "src/lib/report/YearEndOnDemandCopy.ts", "src/app/api/reports/year-end/route.ts", "src/components/YearEndOnDemandButton.tsx"])("%s imports nothing from the freeze or stored-report modules", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(FORBIDDEN);
  });
});

describe("Y-T3: nothing revealing", () => {
  it("copy, file name and headers carry none of the revealing terms", async () => {
    h.viewer = person("director", true);
    const res = await get();
    const text = [YearEndOnDemandCopy.BUTTON, YearEndOnDemandCopy.HELPER, res.headers.get("Content-Disposition"), YearEndOnDemandCopy.href("FY26", ["completed"])].join(" ");
    for (const r of REVEALING) expect(text).not.toMatch(r);
  });

  it("the Director's /reports data has the picker years and nothing stored", async () => {
    const data = await ReportsPageData.load(person("director", true) as never, ServiceLine.defaultScope());
    expect(data).toMatchObject({ kind: "viewer" });
    expect(Object.keys(data!).sort()).toEqual(["canDownloadPdf", "kind", "yearEndYears"]);
    expect(JSON.stringify(data)).not.toMatch(/freez|snapshot|delivery|handoff|\/reports\/year-end\//i);
  });
});

describe("Y-T4: permission", () => {
  it.each(ROLES)("%s without the key: no control in page data and a 404", async (roleId) => {
    h.viewer = person(roleId, false);
    const data = await ReportsPageData.load(h.viewer as never, ServiceLine.defaultScope());
    expect(data && "yearEndYears" in data).toBe(false);
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("bad fiscal year, future year or bad categories: 404", async () => {
    h.viewer = person("director", true);
    for (const q of ["?fy=nope", "?fy=FY40", "?fy=FY26&categories=bogus", "?fy=FY26&categories="]) expect((await get(q)).status).toBe(404);
  });

  it("no viewer: 404", async () => {
    expect((await get()).status).toBe(404);
  });
});
