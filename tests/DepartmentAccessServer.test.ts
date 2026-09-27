import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Department-level access enforced on the server through the real pages, routes and Server Actions (the session
// viewer and Db.client are fakes; redirect and notFound throw so the tests can see them).
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
const { GET: previewGET } = await import("@/app/api/reports/preview/route");
const { loadProjectHistory } = await import("@/app/actions/history");
const { setAllDepartments, setDepartmentAccess } = await import("@/app/actions/access");
const { NoAccessCard } = await import("@/components/NoAccessCard");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { ProjectService } = await import("@/lib/services/ProjectService");
const { FreezeService } = await import("@/lib/services/FreezeService");
const { ServiceLine } = await import("@/lib/domain/ServiceLine");
const { DepartmentAccessCopy } = await import("@/lib/access/DepartmentAccessCopy");
const { DepartmentFilter } = await import("@/lib/domain/DepartmentFilter");

const JANE = { email: "jane.doe@caromonthealth.org", isAdmin: false, name: "Jane Doe" };
const ADMIN = { ...Factory.ADMIN, name: "Admin" };
const ENV = { ALLOWED_EMAILS: "@caromonthealth.org @example.org", ADMIN_EMAILS: "admin@example.org" };
const FREEZE_RUN = new Date("2026-09-29T21:30:00Z");
const CVPSL = "00000000-0000-4000-8000-000000000001";
const MISSING = "00000000-0000-4000-8000-00000000dead";
const actor = { changedBy: "nick.leary@caromonthealth.org" };

/** PDF bytes with the creation date and document id masked (they differ on every render). */
class Pdf {
  static masked(bytes: Buffer): string {
    return bytes.toString("latin1").replace(/\(D:\d{14}Z\)/g, "(D:X)").replace(/\/ID \[<[0-9a-fA-F]+> <[0-9a-fA-F]+>\]/g, "/ID [X]");
  }
}

/** A stored year-end report row (Reports > Year-end report). */
class YearEnd {
  static add(serviceLineId: string): string {
    const id = "00000000-0000-4000-8000-0000000ab001";
    fake.state.yearEndReports.push({
      id, serviceLineId, fiscalYear: "FY27", periodStart: new Date("2026-07-01"), periodEnd: new Date("2026-09-27"), toDate: true,
      fileName: "CVPSL FY27 Year-End Report.pdf", contentType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]), byteSize: 4,
      sha256: "x", generatedAt: new Date("2026-09-27T14:00:00Z"), generatedBy: ADMIN.email, generatedByName: "Admin",
    });
    return id;
  }
}

let fake: FakeDb;
let ids: Record<string, string>;

type DashProps = { rows: { name: string }[]; fiscalYearRows: { name: string }[]; line: { departments: { name: string }[] }; initialProjectId?: string };

class Page {
  static async render(page: unknown, params: Record<string, string> = {}): Promise<ReactElement> {
    return (page as (p: { searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>)({ searchParams: Promise.resolve(params) });
  }

  /** A rendered element tree as text (React internals and functions dropped). */
  static tree(el: unknown): string {
    const out: string[] = [];
    const walk = (n: unknown): void => {
      if (n === null || n === undefined || typeof n === "boolean") return;
      if (typeof n === "string" || typeof n === "number") return void out.push(String(n));
      if (Array.isArray(n)) return n.forEach(walk);
      const props = (n as { props?: Record<string, unknown> }).props;
      if (!props) return;
      if (typeof props.href === "string") out.push(props.href);
      walk(props.children);
    };
    walk(el);
    return out.join(" ");
  }

  /** Everything the page would send to the browser, as text (functions dropped). */
  static payload(el: ReactElement): string {
    return JSON.stringify(el.props, (_k, v) => (typeof v === "function" ? undefined : v));
  }
}

beforeEach(async () => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fake = new FakeDb();
  h.db = fake.asClient();
  h.viewer = null;
  const make = (serviceArea: string | null, name: string, status = "OnTrack") =>
    ProjectService.create({ serviceArea, owner: "Owner A", status, nextMilestone: "M1", name } as never, actor, h.db as never).then((p) => p.id as string);
  ids = {
    echo: await make("Echo", "Echo visible project"),
    cath: await make("Cath", "Cath secret project"),
    ep: await make("EP", "EP secret project"),
    none: await make(null, "Unassigned secret project"),
    echoDone: await make("Echo", "Echo finished project", "Complete"),
  };
  fake.grant(JANE.email, CVPSL);
  fake.limit(JANE.email, CVPSL, "Echo", "IR");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("limited user: dashboard, tiles, counts, search and the filter only include their departments", () => {
  it("the dashboard reads and sends only their departments' projects (no Unassigned), and the filter lists only theirs", async () => {
    h.viewer = JANE;
    const reads = vi.spyOn((h.db as { project: { findMany: (a: unknown) => unknown } }).project, "findMany");
    const el = await Page.render(DashboardPage);
    expect(el.type).toBe(ProjectDashboard);
    const props = el.props as DashProps;
    expect(props.rows.map((r) => r.name)).toEqual(["Echo visible project"]);
    expect(props.fiscalYearRows.map((r) => r.name)).toEqual(["Echo finished project"]);
    expect(props.line.departments.map((d) => d.name)).toEqual(["Echo", "IR"]);
    expect(DepartmentFilter.optionsFor(props.line as never)).toEqual(["Echo", "IR"]);
    expect(reads.mock.calls[0][0]).toMatchObject({ where: { serviceLineId: CVPSL, departmentId: { in: ["Echo", "IR"] } } });
    // Tiles, counts and search are computed in the browser from these rows: nothing else is sent.
    expect(Page.payload(el)).not.toMatch(/secret|Cath Lab|EP Lab|CardioNeuro/);
  });

  it("the filter button reads 'My departments (N)' for a limited user; admins and users with every department keep 'Departments: All'", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const button = async () => {
      const html = renderToStaticMarkup(await Page.render(DashboardPage));
      return /data-testid="departments-select"><button[^>]*>([^<]*)<\/button>/.exec(html)?.[1];
    };
    h.viewer = JANE;
    expect(await button()).toBe("My departments (2)");
    fake.limit(JANE.email, CVPSL, "Echo", "IR", "EP");
    expect(await button()).toBe("My departments (3)");
    // Unit: N is how many departments they can see (the filter's options); a narrower pick keeps the usual text.
    expect(DepartmentFilter.summary(["Echo", "IR"], 32, ["Echo", "IR"], undefined, true)).toBe("My departments (2)");
    expect(DepartmentFilter.summary(["Echo", "IR"], 32, ["Echo", "IR"], undefined, false)).toBe("Departments: All");
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = true;
    expect(await button()).toBe("Departments: All");
    h.viewer = ADMIN;
    expect(await button()).toBe("Departments: All");
  });

  it("with All departments on, the same person gets the whole line", async () => {
    h.viewer = JANE;
    fake.state.accessGrants[0].allDepartments = true;
    const props = (await Page.render(DashboardPage)).props as DashProps;
    expect(props.rows.map((r) => r.name).sort()).toEqual(["Cath secret project", "EP secret project", "Echo visible project", "Unassigned secret project"]);
    expect(props.line.departments).toHaveLength(7);
  });
});

describe("project links", () => {
  it("their own project opens; another department, a missing, deleted or malformed id all get the same card without the name", async () => {
    h.viewer = JANE;
    const own = await Page.render(DashboardPage, { project: ids.echo });
    expect(own.type).toBe(ProjectDashboard);
    expect((own.props as DashProps).initialProjectId).toBe(ids.echo);
    const cards = [];
    for (const id of [ids.cath, ids.none, MISSING, "not-a-uuid"]) {
      const el = await Page.render(DashboardPage, { project: id });
      expect(el.type, id).toBe(NoAccessCard);
      cards.push(Page.payload(el));
    }
    expect(new Set(cards).size).toBe(1);
    expect(cards[0]).not.toMatch(/secret|Cath|00000000/);
    const card = (await Page.render(DashboardPage, { project: ids.cath })).props as { project: boolean };
    expect(card.project).toBe(true);
    // The card's copy.
    expect([DepartmentAccessCopy.PROJECT_TITLE, DepartmentAccessCopy.PROJECT_BODY, DepartmentAccessCopy.GO_TO_DASHBOARD]).toEqual(["You don't have access to this project", "Ask an admin if you need it.", "Go to dashboard"]);
  });

  it("a project in another line they have (and one of its departments) switches to that line; one they lack gets the card", async () => {
    const ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
    const abl = fake.addDepartment(ep, { name: "Ablation", shortName: "Abl" }).id as string;
    const other = fake.addDepartment(ep, { name: "Devices", shortName: "Dev" }).id as string;
    const inEp = await ProjectService.create({ serviceArea: null, owner: "O", status: "OnTrack", nextMilestone: "M", name: "EP line project" } as never, actor, h.db as never);
    const row = fake.state.projects.find((p) => p.id === inEp.id)!;
    Object.assign(row, { serviceLineId: ep, departmentId: abl, serviceArea: abl });
    h.viewer = JANE;
    expect((await Page.render(DashboardPage, { project: inEp.id as string })).type).toBe(NoAccessCard);
    fake.grant(JANE.email, ep);
    fake.limit(JANE.email, ep, other);
    expect((await Page.render(DashboardPage, { project: inEp.id as string })).type).toBe(NoAccessCard);
    fake.limit(JANE.email, ep, abl);
    await expect(Page.render(DashboardPage, { project: inEp.id as string })).rejects.toThrow(`REDIRECT /?project=${inEp.id}`);
    expect(fake.state.serviceLineUserState.find((s) => s.email === JANE.email)?.serviceLineId).toBe(ep);
  });

  it("admins open any project of their line", async () => {
    h.viewer = ADMIN;
    const el = await Page.render(DashboardPage, { project: ids.cath });
    expect((el.props as DashProps).initialProjectId).toBe(ids.cath);
  });
});

describe("routes and actions", () => {
  it("History: nothing outside their departments", async () => {
    h.viewer = JANE;
    expect((await loadProjectHistory(ids.cath))?.entries).toEqual([]);
    expect(await loadProjectHistory(ids.cath)).toEqual(await loadProjectHistory(MISSING));
    expect((await loadProjectHistory(ids.echo))?.entries.length).toBeGreaterThan(0);
  });

  it("reports: a limited user lists and opens the weekly PDF, the archive and the year-end report of their line, like a user with all departments", async () => {
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: { ...ENV }, fetch: vi.fn() }, h.db as never);
    const snap = fake.state.snapshots[0];
    const ye = YearEnd.add(CVPSL);
    const req = new Request("https://tracker.example.org/x");
    const open = async () => ({
      pdf: (await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) })).status,
      handoff: (await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "handoff" }) })).status,
      yearEnd: (await yearEndGET(req, { params: Promise.resolve({ id: ye }) })).status,
    });
    h.viewer = JANE;
    expect(fake.state.accessGrants.find((g) => g.email === JANE.email)?.allDepartments).toBe(false);
    const limited = Page.tree(await Page.render(ReportsPage));
    expect(limited).toContain(`/reports/${snap.id}/pdf`);
    expect(limited).toContain(`/reports/year-end/${ye}`);
    expect(limited).not.toMatch(/shared with people who can see all/);
    // handoff.json stays admin-only for every non-admin (unchanged).
    expect(await open()).toEqual({ pdf: 200, handoff: 404, yearEnd: 200 });
    // The same as with all departments.
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = true;
    expect(Page.tree(await Page.render(ReportsPage))).toEqual(limited);
    expect(await open()).toEqual({ pdf: 200, handoff: 404, yearEnd: 200 });
  });

  it("reports: a limited user opens the same full frozen report; opening never renders or saves anything, and Drive only ever gets the freeze job's full report", async () => {
    const { PdfReportRenderer } = await import("@/lib/report/PdfReportRenderer");
    const DRIVE_ENV = { ...ENV, GOOGLE_DRIVE_CLIENT_ID: "cid", GOOGLE_DRIVE_CLIENT_SECRET: "csecret", GOOGLE_DRIVE_REFRESH_TOKEN: "rtoken" };
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    const uploads: Buffer[] = [];
    const drive = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at" });
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return json({ files: [{ id: "cvpsl-report-folder" }] });
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
        uploads.push(Buffer.from(init?.body as unknown as Uint8Array));
        return json({ id: `file${uploads.length}`, webViewLink: `https://drive.example/${uploads.length}` });
      }
      throw new Error(`unexpected ${url}`);
    });
    // The freeze job (no viewer) is the only writer of report storage, with Jane's limits in place.
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: DRIVE_ENV, fetch: drive as never }, h.db as never);
    const snap = fake.state.snapshots[0];
    const pdf = fake.state.artifacts.find((a) => a.kind === "pdf")!;
    const frozen = Buffer.from(pdf.bytes as Uint8Array);
    // The frozen report is the full line: every department, including ones Jane can't see.
    const names = (snap.rowsJson as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["Echo visible project", "Cath secret project", "EP secret project"]));
    // Drive got exactly the freeze's files: the full PDF (same bytes) and handoff.json.
    expect(uploads).toHaveLength(2);
    expect(uploads[0].includes(frozen)).toBe(true);
    const stored = { artifacts: fake.state.artifacts.length, snapshots: fake.state.snapshots.length, yearEnd: fake.state.yearEndReports.length };
    const writes = fake.writes.length;
    const driveCalls = drive.mock.calls.length;

    const render = vi.spyOn(PdfReportRenderer, "render");
    const net = vi.spyOn(globalThis, "fetch");
    const ye = YearEnd.add(CVPSL);
    h.viewer = JANE;
    const req = new Request("https://tracker.example.org/x");
    await Page.render(ReportsPage);
    const res = await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) });
    expect(res.status).toBe(200);
    // Same bytes everyone gets, not a department-filtered version.
    expect(Buffer.from(await res.arrayBuffer()).equals(frozen)).toBe(true);
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = true;
    const full = await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) });
    expect(Buffer.from(await full.arrayBuffer()).equals(frozen)).toBe(true);
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = false;
    expect((await yearEndGET(req, { params: Promise.resolve({ id: ye }) })).status).toBe(200);

    // Nothing rendered, written, uploaded or fetched by opening.
    expect(render).not.toHaveBeenCalled();
    expect(net).not.toHaveBeenCalled();
    // (Opening a page may record the viewer's sign-in; report storage is never written.)
    const REPORT_STORAGE = ["reportSnapshot", "reportArtifact", "reportDelivery", "yearEndReport"];
    expect(fake.writes.slice(writes).filter((w) => REPORT_STORAGE.includes(w.model))).toEqual([]);
    expect(drive.mock.calls.length).toBe(driveCalls);
    expect({ artifacts: fake.state.artifacts.length, snapshots: fake.state.snapshots.length, yearEnd: fake.state.yearEndReports.length - 1 }).toEqual(stored);
  });

  it("reports: a user with no access to the line still can't list or open them (as in #29)", async () => {
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: { ...ENV }, fetch: vi.fn() }, h.db as never);
    const snap = fake.state.snapshots[0];
    const ye = YearEnd.add(CVPSL);
    const req = new Request("https://tracker.example.org/x");
    const open = async () => [
      (await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) })).status,
      (await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "handoff" }) })).status,
      (await yearEndGET(req, { params: Promise.resolve({ id: ye }) })).status,
    ];
    // No line at all.
    h.viewer = { email: "ben.noaccess@caromonthealth.org", isAdmin: false, name: "Ben" };
    expect((await Page.render(ReportsPage)).type).toBe(NoAccessCard);
    expect(await open()).toEqual([404, 404, 404]);
    // Another line only, even limited to some of its departments.
    const ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
    const abl = fake.addDepartment(ep, { name: "Ablation", shortName: "Abl" }).id as string;
    fake.grant("ben.noaccess@caromonthealth.org", ep);
    fake.limit("ben.noaccess@caromonthealth.org", ep, abl);
    const other = Page.tree(await Page.render(ReportsPage));
    expect(other).not.toContain(`/reports/${snap.id}/pdf`);
    expect(other).not.toContain(`/reports/year-end/${ye}`);
    expect(await open()).toEqual([404, 404, 404]);
  });

  it("the panel's actions re-check admin on the server", async () => {
    h.viewer = JANE;
    const fail = { ok: false, message: "Couldn't save access. Try again." };
    expect(await setAllDepartments(JANE.email, CVPSL, true)).toEqual(fail);
    expect(await setDepartmentAccess(JANE.email, CVPSL, "Cath", true)).toEqual(fail);
    expect(fake.state.deptAccess.map((d) => d.departmentId)).toEqual(["Echo", "IR"]);
    h.viewer = ADMIN;
    expect(await setDepartmentAccess(JANE.email, CVPSL, "Cath", true)).toEqual({ ok: true, message: "Jane Doe can now see Cath Lab in CVPSL." });
    expect(await setAllDepartments(JANE.email, CVPSL, true)).toEqual({ ok: true, message: "Jane Doe can now see all CVPSL departments." });
  });

  it("the scheduled freeze (no viewer) is built for admins: every department, whatever anyone's limits", async () => {
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: { ...ENV }, fetch: vi.fn() }, h.db as never);
    const withLimits = JSON.parse(Buffer.from(fake.state.artifacts.find((a) => a.kind === "handoff")!.bytes as Uint8Array).toString("utf8"));
    expect(withLimits.totals.projects).toBe(4);
    expect(ServiceLine.DEFAULT_ID).toBe(CVPSL);
  });
});

describe("on-demand PDFs (Generate PDF now): the departments the user is viewing, clamped to ones they can see", () => {
  type DocInput = { rows: readonly unknown[]; departments?: string[]; lineDepartments?: { id: string }[]; draft?: boolean };
  class Draft {
    static async get(query = ""): Promise<{ status: number; input: DocInput | null; bytes: Buffer }> {
      const { PdfReportRenderer } = await import("@/lib/report/PdfReportRenderer");
      const spy = vi.spyOn(PdfReportRenderer, "renderDocument");
      const res = await previewGET(new Request(`https://tracker.example.org/api/reports/preview${query}`));
      const input = (spy.mock.calls[0]?.[0] as unknown as DocInput | undefined) ?? null;
      spy.mockRestore();
      return { status: res.status, input, bytes: Buffer.from(await res.arrayBuffer()) };
    }

    /** Project names in the rendered rows (and "Completed this period"). */
    static names(input: DocInput | null): string[] {
      const text = JSON.stringify(input);
      return ["Echo visible project", "Echo finished project", "Cath secret project", "EP secret project", "Unassigned secret project"].filter((n) => text.includes(n));
    }
  }

  it("includes only the departments they have, even when others are requested", async () => {
    h.viewer = JANE; // Echo and IR in CVPSL
    const all = await Draft.get();
    expect(all.status).toBe(200);
    expect(all.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(Draft.names(all.input)).toEqual(["Echo visible project", "Echo finished project"]);
    expect(all.input!.departments).toEqual(["Echo", "IR"]);
    expect(all.input!.lineDepartments!.map((d) => d.id)).toEqual(["Echo", "IR"]);
    // Asking for departments they don't have (and junk) changes nothing: the server keeps only theirs.
    const forged = await Draft.get("?departments=Cath,EP,Echo,IR,CardioNeuro,nope");
    expect(Draft.names(forged.input)).toEqual(["Echo visible project", "Echo finished project"]);
    expect(forged.input!.departments).toEqual(["Echo", "IR"]);
    // Only departments they lack: falls back to all of theirs, never to the others.
    const onlyOthers = await Draft.get("?departments=Cath,EP");
    expect(Draft.names(onlyOthers.input)).toEqual(["Echo visible project", "Echo finished project"]);
  });

  it("narrowing to some of their departments gets only that subset", async () => {
    const ir = await ProjectService.create({ serviceArea: "IR", owner: "O", status: "OnTrack", nextMilestone: "M", name: "IR visible project" } as never, actor, h.db as never);
    h.viewer = JANE;
    const both = await Draft.get("?departments=Echo,IR");
    expect(JSON.stringify(both.input)).toContain("IR visible project");
    const irOnly = await Draft.get("?departments=IR");
    expect(irOnly.input!.departments).toEqual(["IR"]);
    expect(JSON.stringify(irOnly.input)).toContain("IR visible project");
    expect(Draft.names(irOnly.input)).toEqual([]);
    const echoOnly = await Draft.get("?departments=Echo");
    expect(Draft.names(echoOnly.input)).toEqual(["Echo visible project", "Echo finished project"]);
    expect(JSON.stringify(echoOnly.input)).not.toContain("IR visible project");
    expect(ir.id).toBeTruthy();
  });

  it("writes nothing to report storage (no snapshot, artifact, delivery, year-end row, Drive or network) and never becomes the frozen report", async () => {
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: { ...ENV }, fetch: vi.fn() }, h.db as never);
    const frozen = Buffer.from(fake.state.artifacts.find((a) => a.kind === "pdf")!.bytes as Uint8Array);
    const before = JSON.stringify({ s: fake.state.snapshots.map((x) => x.id), a: fake.state.artifacts.map((x) => x.id), d: fake.state.deliveries.length, y: fake.state.yearEndReports.length });
    const writes = fake.writes.length;
    const net = vi.spyOn(globalThis, "fetch");
    h.viewer = JANE;
    const r = await Draft.get("?departments=Echo");
    expect(r.status).toBe(200);
    expect(r.input!.draft).toBe(true);
    const REPORT_STORAGE = ["reportSnapshot", "reportArtifact", "reportDelivery", "yearEndReport"];
    expect(fake.writes.slice(writes).filter((w) => REPORT_STORAGE.includes(w.model))).toEqual([]);
    expect(JSON.stringify({ s: fake.state.snapshots.map((x) => x.id), a: fake.state.artifacts.map((x) => x.id), d: fake.state.deliveries.length, y: fake.state.yearEndReports.length })).toBe(before);
    expect(net.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith("data:"))).toEqual([]);
    // The frozen report is untouched and still what everyone opens.
    const res = await archiveGET(new Request("https://tracker.example.org/x"), { params: Promise.resolve({ id: fake.state.snapshots[0].id as string, file: "pdf" }) });
    expect(Buffer.from(await res.arrayBuffer()).equals(frozen)).toBe(true);
    expect(r.bytes.equals(frozen)).toBe(false);
  });

  it("admins follow their dashboard filter too: filtered to Cath+EP they get only those, even when the admin setting excludes EP", async () => {
    const { ReportOptionsService } = await import("@/lib/services/ReportOptionsService");
    const { ServiceLineAccess } = await import("@/lib/access/ServiceLineAccess");
    const scope = await ServiceLineAccess.activeFor(ADMIN, h.db as never);
    await ReportOptionsService.update({ departments: ["Cath", "Echo", "CVSS", "INU", "CardioNeuro", "IR"] }, ADMIN, h.db as never, scope);
    h.viewer = ADMIN;
    const some = await Draft.get("?departments=Cath,EP");
    expect(some.status).toBe(200);
    expect(some.input!.departments).toEqual(["Cath", "EP"]);
    expect(Draft.names(some.input)).toEqual(["Cath secret project", "EP secret project"]);
    // Other lines' ids and junk are dropped (clamped to the line's departments).
    const junk = await Draft.get("?departments=EP,nope,00000000-0000-4000-8000-00000000dead");
    expect(junk.input!.departments).toEqual(["EP"]);
    expect(Draft.names(junk.input)).toEqual(["EP secret project"]);
  });

  it("an unfiltered admin (every department selected, nothing sent, or nothing valid) gets exactly today's output: the admin report setting", async () => {
    const { ReportOptionsService } = await import("@/lib/services/ReportOptionsService");
    const { ServiceLineAccess } = await import("@/lib/access/ServiceLineAccess");
    const { DraftReportService } = await import("@/lib/services/DraftReportService");
    const scope = await ServiceLineAccess.activeFor(ADMIN, h.db as never);
    await ReportOptionsService.update({ departments: ["Cath", "Echo", "CVSS", "INU", "CardioNeuro", "IR"] }, ADMIN, h.db as never, scope);
    const NOW = new Date("2026-09-27T15:00:00Z");
    const render = async (requested?: string[]) => (await DraftReportService.render(ADMIN, h.db as never, NOW, undefined, requested))!.bytes;
    // Today's output: no departments sent (what the admin link sent before this change).
    const today = await render();
    // Two renders of the same input differ only in the PDF creation date and document id (as in the freeze check).
    expect(Pdf.masked(await render())).toBe(Pdf.masked(today));
    const everything = await render(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    const invalid = await render(["nope", "00000000-0000-4000-8000-00000000dead"]);
    expect(Pdf.masked(everything)).toBe(Pdf.masked(today));
    expect(Pdf.masked(invalid)).toBe(Pdf.masked(today));
    // And it is the admin setting (EP excluded), not every department.
    h.viewer = ADMIN;
    const viaRoute = await Draft.get("?departments=Cath,EP,Echo,CVSS,INU,CardioNeuro,IR");
    expect(viaRoute.input!.departments).toEqual(["Cath", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    // (As today, a report department filter that leaves any department out also leaves out Unassigned.)
    expect(Draft.names(viaRoute.input)).toEqual(["Echo visible project", "Echo finished project", "Cath secret project"]);
  });

  it("no access to the line is 404", async () => {
    h.viewer = { email: "ben.noaccess@caromonthealth.org", isAdmin: false, name: "Ben" };
    expect((await Draft.get()).status).toBe(404);
    expect((await Draft.get("?departments=Echo")).status).toBe(404);
    // A line they don't have: its departments are never theirs to request.
    const ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
    fake.grant("ben.noaccess@caromonthealth.org", ep);
    const other = await Draft.get("?departments=Echo,Cath");
    expect(Draft.names(other.input)).toEqual([]);
  });

  it("a non-admin with every department can generate: their dashboard filter selects among all the line's departments, clamped, and nothing is stored", async () => {
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: { ...ENV }, fetch: vi.fn() }, h.db as never);
    const frozen = Buffer.from(fake.state.artifacts.find((a) => a.kind === "pdf")!.bytes as Uint8Array);
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = true;
    h.viewer = JANE;
    const writes = fake.writes.length;
    const stored = JSON.stringify({ s: fake.state.snapshots.map((x) => x.id), a: fake.state.artifacts.map((x) => x.id), d: fake.state.deliveries.length, y: fake.state.yearEndReports.length });
    const net = vi.spyOn(globalThis, "fetch");
    // No filter sent (or all selected): the whole line, like the dashboard.
    const all = await Draft.get();
    expect(all.status).toBe(200);
    // (The finished Echo project was listed by the freeze above, so "Completed this period" doesn't repeat it.)
    expect(Draft.names(all.input)).toEqual(["Echo visible project", "Cath secret project", "EP secret project", "Unassigned secret project"]);
    expect(all.input!.lineDepartments).toHaveLength(7);
    // Narrowed to Cath and EP: only those.
    const some = await Draft.get("?departments=Cath,EP");
    expect(some.input!.departments).toEqual(["Cath", "EP"]);
    expect(Draft.names(some.input)).toEqual(["Cath secret project", "EP secret project"]);
    // Junk and other lines' ids are dropped; nothing valid left = all the line's departments.
    const junk = await Draft.get("?departments=Cath,nope,00000000-0000-4000-8000-00000000dead");
    expect(junk.input!.departments).toEqual(["Cath"]);
    expect(Draft.names((await Draft.get("?departments=nope")).input)).toEqual(Draft.names(all.input));
    // Download only: no report storage, Drive or network; the frozen report is unchanged.
    const REPORT_STORAGE = ["reportSnapshot", "reportArtifact", "reportDelivery", "yearEndReport"];
    expect(fake.writes.slice(writes).filter((w) => REPORT_STORAGE.includes(w.model))).toEqual([]);
    expect(JSON.stringify({ s: fake.state.snapshots.map((x) => x.id), a: fake.state.artifacts.map((x) => x.id), d: fake.state.deliveries.length, y: fake.state.yearEndReports.length })).toBe(stored);
    expect(net.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith("data:"))).toEqual([]);
    expect(some.bytes.equals(frozen)).toBe(false);
    expect(Buffer.from(fake.state.artifacts.find((a) => a.kind === "pdf")!.bytes as Uint8Array).equals(frozen)).toBe(true);
  });

  it("year-end Generate stays admin-only", async () => {
    const { generateYearEndReport } = await import("@/app/actions/reports");
    h.viewer = JANE;
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = true;
    const r = await generateYearEndReport("FY27");
    expect(r.ok).toBe(false);
    expect(fake.state.yearEndReports).toHaveLength(0);
  });

  it("every signed-in user with the line gets the Generate PDF now button, linked to the departments they are viewing", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const link = async () => /href="(\/api\/reports\/preview[^"]*)"[^>]*>Generate PDF now</.exec(renderToStaticMarkup(await Page.render(DashboardPage)))?.[1] ?? null;
    h.viewer = JANE;
    expect(await link()).toBe("/api/reports/preview?departments=Echo,IR");
    h.viewer = ADMIN;
    expect(await link()).toBe("/api/reports/preview?departments=Cath,EP,Echo,CVSS,INU,CardioNeuro,IR");
    h.viewer = JANE;
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = true;
    expect(await link()).toBe("/api/reports/preview?departments=Cath,EP,Echo,CVSS,INU,CardioNeuro,IR");
    // One tooltip for everyone, admins included.
    const tip = "Download a draft PDF of the departments you&#x27;re viewing. It isn&#x27;t an official report, and nothing is saved or sent.";
    for (const v of [JANE, ADMIN]) {
      h.viewer = v;
      const html = renderToStaticMarkup(await Page.render(DashboardPage));
      expect(html).toContain(`title="${tip}"`);
      expect(html).not.toContain("Not an official snapshot");
    }
  });
});

describe("Access grid render (Figma Bro)", () => {
  it("count rule in the rendered grid: none while All departments is on; '7 of 7' when it is off with every box checked", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AccessAdmin } = await import("@/components/AccessAdmin");
    const { LineAccessService } = await import("@/lib/services/LineAccessService");
    fake.state.appUsers.find((u) => u.email === JANE.email)!.name = "Jane Doe";
    const counts = async () => [...renderToStaticMarkup(createElement(AccessAdmin, { grid: await LineAccessService.grid(ADMIN, h.db as never, ENV) })).matchAll(/data-testid="access-count"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(await counts()).toEqual(["2 of 7"]);
    fake.limit(JANE.email, CVPSL, "Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR");
    expect(await counts()).toEqual(["7 of 7"]);
    fake.state.accessGrants.find((g) => g.email === JANE.email)!.allDepartments = true;
    expect(await counts()).toEqual([]);
  });

  it("limited cells show '3 of 7' with the screen reader label; unlimited cells stay a plain checkbox; admins don't expand", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { AccessAdmin } = await import("@/components/AccessAdmin");
    const { LineAccessService } = await import("@/lib/services/LineAccessService");
    fake.grant("editor@example.org", CVPSL);
    fake.limit(JANE.email, CVPSL, "Echo", "IR", "EP");
    fake.state.appUsers.find((u) => u.email === JANE.email)!.name = "Jane Doe";
    fake.grant(ADMIN.email);
    const grid = await LineAccessService.grid(ADMIN, h.db as never, ENV);
    const closed = renderToStaticMarkup(createElement(AccessAdmin, { grid }));
    expect(closed).toContain(">3 of 7</span>");
    expect(closed).toContain('aria-label="Jane Doe, CVPSL access, 3 of 7 departments"');
    expect(closed).toContain('aria-label="Editor, CVPSL access"');
    expect(closed.match(/data-testid="access-count"/g)).toHaveLength(1);
    expect(closed).toContain('aria-label="Show Jane Doe&#x27;s departments"');
    expect(closed.match(/data-testid="access-caret"/g)).toHaveLength(2); // Jane and Editor; not the admin
    expect(closed).not.toContain('data-testid="access-panel"');
    expect(closed).toContain("Covers all service lines and departments. Admins can see everything.");

    const open = renderToStaticMarkup(createElement(AccessAdmin, { grid, initialExpanded: JANE.email }));
    expect(open).toContain('aria-label="Hide Jane Doe&#x27;s departments"');
    expect(open).toContain('role="switch" aria-checked="false"');
    expect(open).toContain("Only the checked departments. New ones aren&#x27;t added.");
    const boxes = [...open.matchAll(/aria-label="Jane Doe, ([^"]+) in CVPSL"( checked="")?/g)].map((m) => [m[1], Boolean(m[2])]);
    expect(boxes).toEqual([
      ["CardioNeuro", false],
      ["Cath Lab", false],
      ["CVSS", false],
      ["Echo", true],
      ["EP Lab", true],
      ["INU", false],
      ["IR", true],
    ]);
    const editor = renderToStaticMarkup(createElement(AccessAdmin, { grid, initialExpanded: "editor@example.org" }));
    expect(editor).toContain('role="switch" aria-checked="true"');
    expect(editor).toContain("Includes departments added later.");
    expect(editor).not.toContain('data-testid="access-departments"');
    // An admin row never opens, even from a link.
    expect(renderToStaticMarkup(createElement(AccessAdmin, { grid, initialExpanded: ADMIN.email }))).not.toContain('data-testid="access-panel"');
  });
});
