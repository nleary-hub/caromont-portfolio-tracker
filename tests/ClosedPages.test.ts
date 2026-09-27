import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// The Completed and Cancelled pages and Restore to active, through the real pages, loader and Server Action: the
// session viewer and Db.client are fakes (same setup as LineAccessServer.test.ts).
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
  usePathname: () => "/completed",
}));
vi.mock("@/auth", () => ({
  auth: async () => (h.viewer ? { user: { email: h.viewer.email } } : null),
  signOut: async () => undefined,
  signIn: async () => undefined,
  SIGN_IN_PATH: "/signin",
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

const { default: CompletedPage } = await import("@/app/completed/page");
const { default: CancelledPage } = await import("@/app/cancelled/page");
const { restoreCancelledProject } = await import("@/app/actions/closed");
const { NoAccessCard } = await import("@/components/NoAccessCard");
const { ClosedProjectsView } = await import("@/components/ClosedProjectsView");
const { MainNav } = await import("@/components/MainNav");
const { ProjectService, ProjectNotCancelledError } = await import("@/lib/services/ProjectService");
const { ProjectHistoryService } = await import("@/lib/services/ProjectHistoryService");
const { ServiceLine } = await import("@/lib/domain/ServiceLine");
const { DepartmentFilter } = await import("@/lib/domain/DepartmentFilter");
const { ClosedPageModel } = await import("@/lib/closed/ClosedPageModel");
const { ClosedPagesCopy } = await import("@/lib/closed/ClosedPagesCopy");
const { ClosedPageData } = await import("@/lib/closed/ClosedPageData");
const { RestoreRules } = await import("@/lib/closed/RestoreRules");
const { FiscalYearRows } = await import("@/lib/dashboard/FiscalYearRows");
const { AdminRequiredError } = await import("@/lib/auth/AdminPolicy");
const { CompletedFiscalYearCard } = await import("@/components/ProjectDashboard");

type Row = import("@/lib/dashboard/FiscalYearSections").DashboardFyRow;
type Kind = import("@/lib/closed/ClosedPageModel").ClosedPageKind;

const JANE = { email: "jane.doe@caromonthealth.org", isAdmin: false, name: "Jane Doe" };
const ADMIN = { ...Factory.ADMIN, name: "Admin" };
const TODAY = "2026-09-27";
const CVPSL = ServiceLine.defaultScope();
const LIST = CVPSL.departments;
const OPTIONS = DepartmentFilter.optionsFor(CVPSL);
const actor = { changedBy: "nick.leary@caromonthealth.org" };

let fake: FakeDb;
let ep: string;

class W {
  static async add(name: string, serviceArea: string, status: string, extra: Record<string, unknown> = {}, scope = CVPSL): Promise<string> {
    const p = await ProjectService.create({ name, serviceArea, status, owner: "Owner A", nextMilestone: "M1", ...extra }, actor, h.db as never, scope);
    return p.id;
  }

  static async set(id: string, status: string, iso: string): Promise<void> {
    const before = fake.state.history.length;
    await ProjectService.update(id, { status }, actor, h.db as never);
    for (const x of fake.state.history.slice(before)) x.changedAt = new Date(iso);
  }

  static at(id: string, iso: string): void {
    for (const x of fake.state.history) if (x.projectId === id) x.changedAt = new Date(iso);
  }

  static async page(page: typeof CompletedPage, params: Record<string, string> = {}): Promise<ReactElement> {
    return page({ searchParams: Promise.resolve(params) });
  }

  static props(el: ReactElement): { rows: Row[]; restore: Record<string, unknown> | null; restoreAction?: unknown; initialView: { fy: string; departments: string[] } } {
    return el.props as never;
  }

  static html(kind: Kind, rows: Row[], view = { fy: "FY27", departments: [...OPTIONS] }, restore: Record<string, { statusLabel: string; fromHistory: boolean }> | null = null): string {
    return renderToStaticMarkup(
      createElement(ClosedProjectsView, {
        kind,
        rows,
        today: TODAY,
        initialView: view,
        options: OPTIONS,
        list: LIST,
        restore,
        ...(restore ? { restoreAction: async () => ({ ok: false as const, error: "x" }) } : {}),
        lineSlot: null,
        adminSlot: null,
        loadError: null,
      }),
    );
  }

  static row(over: Partial<Row>): Row {
    return {
      id: over.name ?? "id",
      name: "P",
      serviceArea: "Cath",
      owner: "Owner A",
      physicianChampion: null,
      status: "Complete",
      closedOn: "2026-08-01",
      fiscalYear: "FY27",
      finalUpdate: null,
      inforRequestNumber: null,
      ...over,
    } as unknown as Row;
  }
}

beforeEach(async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fake = new FakeDb();
  h.db = fake.asClient();
  h.viewer = null;
  ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP", departments: ["Cath", "IR"] }).id as string;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Completed and Cancelled pages: model", () => {
  const rows = [
    W.row({ id: "a", name: "Alpha", serviceArea: "Cath", closedOn: "2026-08-01" }),
    W.row({ id: "b", name: "Bravo", serviceArea: "Cath", closedOn: "2026-09-10" }),
    W.row({ id: "c", name: "Charlie", serviceArea: "EP", closedOn: "2026-07-02" }),
    W.row({ id: "d", name: "Delta", serviceArea: "IR", closedOn: "2026-03-01", fiscalYear: "FY26" }),
    W.row({ id: "x", name: "Xray", serviceArea: "Cath", status: "Cancelled", closedOn: "2026-09-01" }),
  ];
  const all = { fy: "FY27", departments: [...OPTIONS] };

  it("groups by department (empty departments hidden), newest first, with the summary line", () => {
    const s = ClosedPageModel.state(rows, "Complete", all, OPTIONS, LIST);
    expect(s.groups.map((g) => [g.area, g.rows.map((r) => r.name)])).toEqual([
      ["Cath", ["Bravo", "Alpha"]],
      ["EP", ["Charlie"]],
    ]);
    expect(ClosedPageModel.summary(s)).toBe("3 projects in 2 departments");
    expect(s.empty).toBeNull();
    // Only this page's status.
    expect(ClosedPageModel.state(rows, "Cancelled", all, OPTIONS, LIST).groups.map((g) => g.rows.map((r) => r.name))).toEqual([["Xray"]]);
  });

  it("filters by fiscal year and department; the FY list is current first then past years with rows", () => {
    expect(ClosedPageModel.state(rows, "Complete", { ...all, fy: "FY26" }, OPTIONS, LIST).groups.map((g) => g.area)).toEqual(["IR"]);
    expect(ClosedPageModel.years(rows, "Complete", TODAY)).toEqual(["FY27", "FY26"]);
    expect(ClosedPageModel.years(rows, "Cancelled", TODAY)).toEqual(["FY27"]);
    const ep1 = ClosedPageModel.state(rows, "Complete", { ...all, departments: ["EP"] }, OPTIONS, LIST);
    expect(ep1.groups.map((g) => g.area)).toEqual(["EP"]);
    expect(ClosedPageModel.summary(ep1)).toBe("1 project in 1 department");
  });

  it("summary line names Unassigned only when its group is showing; the department count excludes it", () => {
    // The copy, every case.
    expect(ClosedPagesCopy.summary(6, 3, true)).toBe("6 projects in 3 departments and Unassigned");
    expect(ClosedPagesCopy.summary(1, 1, true)).toBe("1 project in 1 department and Unassigned");
    expect(ClosedPagesCopy.summary(2, 1, true)).toBe("2 projects in 1 department and Unassigned");
    expect(ClosedPagesCopy.summary(2, 0, true)).toBe("2 projects in Unassigned");
    expect(ClosedPagesCopy.summary(1, 0, true)).toBe("1 project in Unassigned");
    expect(ClosedPagesCopy.summary(6, 3, false)).toBe("6 projects in 3 departments");
    expect(ClosedPagesCopy.summary(1, 1)).toBe("1 project in 1 department");
    // Through the page state: an Unassigned row shows its group, and the summary names it.
    const withNone = [...rows, W.row({ id: "n1", name: "November", serviceArea: null as never, closedOn: "2026-08-15" })];
    const s = ClosedPageModel.state(withNone, "Complete", all, OPTIONS, LIST);
    expect(s.groups.map((g) => g.area)).toEqual(["Cath", "EP", "Unassigned"]);
    expect([s.departmentCount, s.unassigned]).toEqual([2, true]);
    expect(ClosedPageModel.summary(s)).toBe("4 projects in 2 departments and Unassigned");
    // Only Unassigned showing (one and two projects): never "0 departments".
    const only1 = [W.row({ id: "n1", name: "November", serviceArea: null as never, closedOn: "2026-08-15" })];
    expect(ClosedPageModel.summary(ClosedPageModel.state(only1, "Complete", all, OPTIONS, LIST))).toBe("1 project in Unassigned");
    const only2 = [...only1, W.row({ id: "n2", name: "Oscar", serviceArea: null as never, closedOn: "2026-08-16" })];
    expect(ClosedPageModel.summary(ClosedPageModel.state(only2, "Complete", all, OPTIONS, LIST))).toBe("2 projects in Unassigned");
    // One department plus Unassigned (singular).
    const one = [W.row({ id: "e1", name: "Echo one", serviceArea: "Echo", closedOn: "2026-08-10" }), only1[0]];
    expect(ClosedPageModel.summary(ClosedPageModel.state(one, "Complete", all, OPTIONS, LIST))).toBe("2 projects in 1 department and Unassigned");
    // A narrowed filter hides the Unassigned group (as on the dashboard), so the text is unchanged.
    const narrowed = ClosedPageModel.state(withNone, "Complete", { ...all, departments: ["EP"] }, OPTIONS, LIST);
    expect([narrowed.unassigned, ClosedPageModel.summary(narrowed)]).toEqual([false, "1 project in 1 department"]);
    // No Unassigned group: unchanged text.
    expect(ClosedPageModel.summary(ClosedPageModel.state(rows, "Complete", all, OPTIONS, LIST))).toBe("3 projects in 2 departments");
    // Rendered: the line shows with Unassigned; an empty view still has no summary line.
    expect(W.html(ClosedPageModel.COMPLETED, withNone)).toContain("4 projects in 2 departments and Unassigned");
    const empty = W.html(ClosedPageModel.COMPLETED, withNone, { fy: "FY25", departments: [...OPTIONS] });
    expect(empty).not.toMatch(/projects? in /);
  });

  it("empty states: nothing in the year vs filters hiding everything", () => {
    expect(ClosedPageModel.state(rows, "Cancelled", { ...all, fy: "FY26" }, OPTIONS, LIST).empty).toBe("year");
    expect(ClosedPageModel.state(rows, "Complete", { ...all, departments: ["Echo"] }, OPTIONS, LIST).empty).toBe("filtered");
  });

  it("the URL keeps only fy and departments; defaults are dropped; nav links keep them", () => {
    const view = ClosedPageModel.parse({ fy: "fy26", departments: "cath,EP,Nope", line: "EP", q: "x" }, TODAY, OPTIONS, LIST);
    expect(view).toEqual({ fy: "FY26", departments: ["Cath", "EP"] });
    expect(ClosedPageModel.query(view, TODAY, OPTIONS, LIST)).toBe("?fy=FY26&departments=Cath,EP");
    expect(ClosedPageModel.query(ClosedPageModel.parse({}, TODAY, OPTIONS, LIST), TODAY, OPTIONS, LIST)).toBe("");
    expect(ClosedPageModel.parse({ fy: "junk" }, TODAY, OPTIONS, LIST).fy).toBe("FY27");
    const nav = renderToStaticMarkup(createElement(MainNav, { active: "completed", closedQuery: "?fy=FY26&departments=Cath" }));
    expect([...nav.matchAll(/href="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[2], m[1].replace(/&amp;/g, "&")])).toEqual([
      ["Dashboard", "/"],
      ["Completed", "/completed?fy=FY26&departments=Cath"],
      ["Cancelled", "/cancelled?fy=FY26&departments=Cath"],
      ["Reports", "/reports"],
    ]);
    // Dashboard cancel toast link carries the current fy and departments.
    expect(ClosedPageModel.href(ClosedPageModel.CANCELLED.path, { fy: "FY27", departments: ["Cath"] }, TODAY, OPTIONS, LIST)).toBe("/cancelled?departments=Cath");
    expect(ClosedPagesCopy.cancelledToast("Cardiac MRI")).toBe("Cardiac MRI is cancelled and off the dashboard.");
    expect(ClosedPagesCopy.CANCEL_ERROR).toBe("Couldn't cancel the project. Try again.");
    expect(ClosedPagesCopy.VIEW_ON_CANCELLED).toBe("View on Cancelled page");
  });

  it("copy has no em dashes", () => {
    const strings = [
      ...Object.values(ClosedPagesCopy).filter((v) => typeof v === "string"),
      ClosedPagesCopy.restoreBody("On track", true),
      ClosedPagesCopy.restoreBody("Not started", false),
      ClosedPagesCopy.emptyYear("Complete", "FY26", "FY27"),
      ClosedPagesCopy.emptyYearHint("Cancelled", "FY27", "FY27")!,
    ];
    for (const s of strings) expect(s).not.toContain("\u2014");
  });
});

describe("Completed and Cancelled pages: render", () => {
  const done = [W.row({ id: "a", name: "Alpha", inforRequestNumber: 4871, finalUpdate: "Went live in all rooms." } as never), W.row({ id: "b", name: "Bravo", serviceArea: "EP", owner: null, closedOn: "2026-09-10" } as never)];

  it("Completed: title, summary, heading bars with counts, columns, Infor under the name, gray dash for empty cells, no chips", () => {
    const html = W.html(ClosedPageModel.COMPLETED, done);
    expect(html).toContain("Completed projects");
    expect(html).toContain("2 projects in 2 departments");
    expect(html).toContain("Fiscal year");
    for (const c of ["Project", "Owner", "Requester", "Completed", "Final update"]) expect(html).toContain(`>${c}<`);
    expect(html).toContain("4871");
    expect(html).toContain("Went live in all rooms.");
    expect(html).toContain(ClosedPagesCopy.EMPTY_CELL);
    expect(html).toMatch(/1 project</);
    expect(html).not.toContain("data-status-chip");
    expect(html).not.toContain(ClosedPagesCopy.ROW_MENU_LABEL);
  });

  it("empty states: current FY with its gray line, past FY, filtered with Clear filters", () => {
    const cur = W.html(ClosedPageModel.COMPLETED, []);
    expect(cur).toContain("No projects completed in FY27 yet.");
    expect(cur).toContain("Projects show up here as soon as they&#x27;re marked Complete.");
    expect(ClosedPagesCopy.MOVE_HINT).toBe("Projects show up here as soon as they're marked Complete.");
    const past = W.html(ClosedPageModel.COMPLETED, [], { fy: "FY26", departments: [...OPTIONS] });
    expect(past).toContain("No projects were completed in FY26.");
    expect(past).not.toContain("marked Complete");
    const cCur = W.html(ClosedPageModel.CANCELLED, []);
    expect(cCur).toContain("No projects cancelled in FY27 yet.");
    expect(cCur).toContain("Projects show up here as soon as they&#x27;re cancelled.");
    const cPast = W.html(ClosedPageModel.CANCELLED, [], { fy: "FY26", departments: [...OPTIONS] });
    expect(cPast).toContain("No projects were cancelled in FY26.");
    expect(cPast).not.toContain("Projects show up here");
    const filtered = W.html(ClosedPageModel.COMPLETED, done, { fy: "FY27", departments: ["Echo"] });
    expect(filtered).toContain("No projects match these filters.");
    expect(filtered).toContain("Clear filters");  });

  it("hides the summary line whenever the list is empty (FY-empty and filtered-empty), on both pages", () => {
    const cancelled = [W.row({ id: "x", name: "Xray", status: "Cancelled" })];
    for (const [kind, rows] of [[ClosedPageModel.COMPLETED, done], [ClosedPageModel.CANCELLED, cancelled]] as const) {
      expect(W.html(kind, [...rows])).toContain('data-testid="closed-summary"');
      for (const html of [W.html(kind, []), W.html(kind, [], { fy: "FY26", departments: [...OPTIONS] }), W.html(kind, [...rows], { fy: "FY27", departments: ["INU"] })]) {
        expect(html).not.toContain('data-testid="closed-summary"');
        expect(html).not.toMatch(/0 projects in 0 departments/);
      }
    }
  });

  it("Cancelled: the row menu column only for admins", () => {
    const rows = [W.row({ id: "x", name: "Xray", status: "Cancelled" })];
    expect(W.html(ClosedPageModel.CANCELLED, rows)).not.toContain(ClosedPagesCopy.ROW_MENU_LABEL);
    expect(W.html(ClosedPageModel.CANCELLED, rows, undefined, { x: { statusLabel: "On track", fromHistory: true } })).toContain(ClosedPagesCopy.ROW_MENU_LABEL);
  });
});

describe("Completed and Cancelled pages: server (gate, access, admin-only parts)", () => {
  it("no line access: the no-access card, and no project is read", async () => {
    h.viewer = JANE;
    const reads = vi.spyOn((h.db as { project: { findMany: () => unknown } }).project, "findMany");
    for (const page of [CompletedPage, CancelledPage]) expect((await W.page(page)).type).toBe(NoAccessCard);
    expect(reads).not.toHaveBeenCalled();
  });

  it("access filtering is the dashboard's (line access): only the viewer's line; deleted and hidden-from-dashboard excluded", async () => {
    const epScope = (await import("@/lib/access/ServiceLineAccess")).ServiceLineAccess.toScope(fake.state.serviceLines.find((l) => l.id === ep) as never);
    await W.add("CVPSL done", "Cath", "Complete");
    const hidden = await W.add("Hidden done", "Cath", "Complete");
    await ProjectService.setHidden(hidden, "dashboard", true, Factory.ADMIN, h.db as never);
    const del = await W.add("Deleted done", "Cath", "Complete");
    await ProjectService.softDelete(del, Factory.ADMIN, h.db as never);
    await W.add("EP done", "Cath", "Complete", {}, epScope);
    await W.add("Still active", "Cath", "OnTrack");

    h.viewer = JANE;
    fake.grant(JANE.email, ep);
    expect(W.props(await W.page(CompletedPage)).rows.map((r) => r.name)).toEqual(["EP done"]);
    fake.state.accessGrants = [];
    fake.grant(JANE.email, ServiceLine.DEFAULT_ID);
    const el = await W.page(CompletedPage);
    expect(W.props(el).rows.map((r) => r.name)).toEqual(["CVPSL done"]);
    expect(W.props(el).restore).toBeNull();
    expect(W.props(el).initialView.fy).toBe("FY27");
  });

  it("Restore to active is wired only for admins on the Cancelled page", async () => {
    const x = await W.add("Xray", "Cath", "OnTrack");
    await W.set(x, "Cancelled", "2026-09-20T14:00:00Z");
    h.viewer = JANE;
    fake.grant(JANE.email, ServiceLine.DEFAULT_ID);
    const member = W.props(await W.page(CancelledPage));
    expect(member.rows.map((r) => r.name)).toEqual(["Xray"]);
    expect(member.restore).toBeNull();
    expect(member.restoreAction).toBeUndefined();
    h.viewer = ADMIN;
    const admin = W.props(await W.page(CancelledPage));
    expect(admin.restore).toEqual({ [x]: { statusLabel: "On track", fromHistory: true } });
    expect(admin.restoreAction).toBeTypeOf("function");
    expect(W.props(await W.page(CompletedPage)).restore).toBeNull();
  });

  it("the drawer's History loads for a non-admin on closed projects (not on the dashboard)", async () => {
    const x = await W.add("Xray", "Cath", "OnTrack");
    await W.set(x, "Cancelled", "2026-09-20T14:00:00Z");
    const t = await ProjectHistoryService.timeline(x, JANE, h.db as never, CVPSL);
    expect(t.entries.length).toBeGreaterThan(0);
  });
});

describe("Restore to active", () => {
  it("returns to the status before the cancellation and writes the History entry", async () => {
    const x = await W.add("Xray", "Cath", "OnTrack");
    await W.set(x, "AtRisk", "2026-09-01T14:00:00Z");
    await W.set(x, "Cancelled", "2026-09-20T14:00:00Z");
    const { project, target } = await ProjectService.restoreFromCancelled(x, ADMIN, h.db as never, CVPSL, new Date("2026-09-27T14:00:00Z"));
    expect(project.status).toBe("AtRisk");
    expect(target).toEqual({ status: "AtRisk", fromHistory: true });
    const row = fake.state.history.find((r) => r.projectId === x && r.comment === RestoreRules.COMMENT)!;
    expect(row).toMatchObject({ field: "status", oldValue: "Cancelled", newValue: "AtRisk", changedBy: ADMIN.email });
    const t = await ProjectHistoryService.timeline(x, ADMIN, h.db as never, CVPSL);
    expect(JSON.stringify(t)).toContain("Restored from Cancelled. Status is At risk again.");
    expect(ClosedPagesCopy.restoreToast("Xray", "At risk")).toBe("Xray is active again, set to At risk.");
  });

  it("walks back past Complete to the last active status", () => {
    const h1 = [
      { field: "status", oldValue: "OnTrack", newValue: "Complete", changedAt: new Date("2026-08-01T00:00:00Z") },
      { field: "status", oldValue: "Complete", newValue: "Cancelled", changedAt: new Date("2026-09-01T00:00:00Z") },
    ];
    expect(RestoreRules.target(h1)).toEqual({ status: "OnTrack", fromHistory: true });
  });

  it("falls back to Not started when there is no earlier status", async () => {
    const x = await W.add("Born cancelled", "Cath", "Cancelled");
    const { project, target } = await ProjectService.restoreFromCancelled(x, ADMIN, h.db as never, CVPSL);
    expect(project.status).toBe("NotStarted");
    expect(target.fromHistory).toBe(false);
    expect(fake.state.history.find((r) => r.projectId === x && r.comment === RestoreRules.COMMENT_FALLBACK)).toBeDefined();
    const t = await ProjectHistoryService.timeline(x, ADMIN, h.db as never, CVPSL);
    expect(JSON.stringify(t)).toContain("Restored from Cancelled. Status set to Not started.");
    expect(ClosedPagesCopy.restoreBody("Not started", false)).toBe("It goes back to Not started, since there's no earlier status, and returns to the dashboard.");
    expect(ClosedPagesCopy.restoreBody("On track", true)).toBe("It goes back to On track and returns to the dashboard. You can cancel it again later.");
  });

  it("rejects a non-admin in the service and in the Server Action; rejects a project that is not cancelled", async () => {
    const x = await W.add("Xray", "Cath", "OnTrack");
    await W.set(x, "Cancelled", "2026-09-20T14:00:00Z");
    await expect(ProjectService.restoreFromCancelled(x, JANE, h.db as never, CVPSL)).rejects.toBeInstanceOf(AdminRequiredError);
    h.viewer = JANE;
    fake.grant(JANE.email, ServiceLine.DEFAULT_ID);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await restoreCancelledProject(x)).toEqual({ ok: false, error: "Couldn't restore the project. Try again." });
    expect(fake.state.projects.find((p) => p.id === x)!.status).toBe("Cancelled");
    h.viewer = ADMIN;
    expect(await restoreCancelledProject(x)).toEqual({ ok: true, name: "Xray", statusLabel: "On track" });
    expect(fake.state.projects.find((p) => p.id === x)!.status).toBe("OnTrack");
    await expect(ProjectService.restoreFromCancelled(x, ADMIN, h.db as never, CVPSL)).rejects.toBeInstanceOf(ProjectNotCancelledError);
    expect(await restoreCancelledProject(x)).toEqual({ ok: false, error: "Couldn't restore the project. Try again." });
  });
});

describe("Completed FY27 to date tile", () => {
  it("keeps its count and links to /completed", async () => {
    const a = await W.add("A", "Cath", "Complete");
    W.at(a, "2026-08-01T14:00:00Z");
    const b = await W.add("B", "EP", "Complete");
    W.at(b, "2026-09-25T14:00:00Z");
    await W.add("C", "IR", "Cancelled");
    const load = await ClosedPageData.load(ADMIN, "Complete", TODAY, CVPSL, h.db as never);
    const tile = FiscalYearRows.tile(load.rows, TODAY);
    expect(tile.count).toBe(2);
    expect(ClosedPageModel.state(load.rows, "Complete", { fy: "FY27", departments: [...OPTIONS] }, OPTIONS, LIST).count).toBe(tile.count);
    const html = renderToStaticMarkup(createElement(CompletedFiscalYearCard, { fy: tile, href: ClosedPageModel.tileHref() }));
    expect(html).toContain('href="/completed"');
    expect(html).toContain('aria-label="See completed projects for FY27"');
    expect(html).toContain(">2<");
  });
});
