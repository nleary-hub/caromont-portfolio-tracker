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
  it("History, report downloads and year-end PDFs: nothing outside their departments", async () => {
    await FreezeService.run({ trigger: "cron", actor: "cron", now: FREEZE_RUN, env: { ...ENV }, fetch: vi.fn() }, h.db as never);
    const snap = fake.state.snapshots[0];
    const req = new Request("https://tracker.example.org/x");
    h.viewer = JANE;
    expect((await loadProjectHistory(ids.cath))?.entries).toEqual([]);
    expect(await loadProjectHistory(ids.cath)).toEqual(await loadProjectHistory(MISSING));
    expect((await loadProjectHistory(ids.echo))?.entries.length).toBeGreaterThan(0);
    // Reports cover every department: a limited viewer gets none.
    expect((await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) })).status).toBe(404);
    expect((await yearEndGET(req, { params: Promise.resolve({ id: "any" }) })).status).toBe(404);
    const page = Page.tree(await Page.render(ReportsPage));
    expect(page).toContain(DepartmentAccessCopy.reportsLimited("CVPSL"));
    expect(page).not.toContain(`/reports/${snap.id}/pdf`);
    fake.state.accessGrants[0].allDepartments = true;
    expect((await archiveGET(req, { params: Promise.resolve({ id: snap.id as string, file: "pdf" }) })).status).toBe(200);
    const full = Page.tree(await Page.render(ReportsPage));
    expect(full).toContain(`/reports/${snap.id}/pdf`);
    expect(full).not.toContain(DepartmentAccessCopy.reportsLimited("CVPSL"));
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

describe("Access grid render (Figma Bro)", () => {
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
