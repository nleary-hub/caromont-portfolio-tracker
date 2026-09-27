import { describe, expect, it, vi } from "vitest";
import { FiscalYearRows } from "@/lib/dashboard/FiscalYearRows";
import { FiscalYearSections, type DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ClosedProjects } from "@/lib/report/ClosedProjects";
import { YearEndLayout } from "@/lib/report/pdf/YearEndLayout";
import { YearEndRenderer } from "@/lib/report/YearEndRenderer";
import { YearEndCopy, YearEndReportData } from "@/lib/report/YearEndReportData";
import { YearEndReportService } from "@/lib/services/YearEndReportService";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

vi.mock("next/dynamic", () => ({ default: () => () => null }));

type P = ProjectRecord & { createdAt: Date };
type Over = Omit<Partial<P>, "completedOn"> & { completedOn?: string };
const TODAY = "2026-09-27";
const CVPSL = ServiceAreaInfo.CVPSL;

class Fy {
  static p(over: Over = {}): P {
    const { completedOn, ...rest } = over;
    return { ...Factory.project(), createdAt: new Date("2026-01-05T15:00:00Z"), ...rest, completedOn: completedOn ? Factory.date(completedOn) : null } as P;
  }
  static status(projectId: string, iso: string, oldValue: string | null, newValue: string): HistoryEntryRecord {
    return { projectId, changedAt: new Date(iso), field: "status", oldValue, newValue };
  }
  static created(projectId: string, iso: string, status: string): HistoryEntryRecord {
    return { projectId, changedAt: new Date(iso), field: "created", oldValue: null, newValue: JSON.stringify({ name: "x", status }) };
  }
  static rows(projects: P[], history: HistoryEntryRecord[] = [], today = TODAY): DashboardFyRow[] {
    return FiscalYearRows.build({ projects, closedHistory: history, history: [], latestUpdates: [], previousSnapshotGeneratedAt: null, today });
  }
  static data(projects: P[], history: HistoryEntryRecord[], fiscalYear: string, today = TODAY) {
    return YearEndReportData.build({ projects, history, fiscalYear, today, departments: CVPSL, serviceLineName: "Cardiovascular & Pulmonary Service Line" });
  }
}

describe("ClosedProjects", () => {
  it("dates a completion by completedOn, else the day it became Complete (ET)", () => {
    const a = Fy.p({ status: "Complete", completedOn: "2026-08-03" });
    expect(ClosedProjects.closedOn(a, [])).toBe("2026-08-03");
    const b = Fy.p({ status: "Complete" });
    // 00:30 ET on Jul 1 is 04:30 UTC: counts as Jul 1 (FY27), not Jun 30.
    expect(ClosedProjects.closedOn(b, [Fy.status(b.id, "2026-07-01T04:30:00Z", "OnTrack", "Complete")])).toBe("2026-07-01");
    expect(ClosedProjects.closedOn(Fy.p({ status: "OnTrack" }), [])).toBeNull();
  });

  it("dates a cancellation by the latest change to Cancelled, else created as Cancelled, else creation (ET)", () => {
    const c = Fy.p({ status: "Cancelled" });
    const h = [Fy.status(c.id, "2026-02-01T15:00:00Z", "OnTrack", "Cancelled"), Fy.status(c.id, "2026-03-01T15:00:00Z", "Cancelled", "OnHold"), Fy.status(c.id, "2026-08-10T02:00:00Z", "OnHold", "Cancelled")];
    expect(ClosedProjects.closedOn(c, h)).toBe("2026-08-09");
    const d = Fy.p({ status: "Cancelled", createdAt: new Date("2026-05-02T12:00:00Z") });
    expect(ClosedProjects.closedOn(d, [Fy.created(d.id, "2026-05-02T12:00:00Z", "Cancelled")])).toBe("2026-05-02");
    expect(ClosedProjects.closedOn(d, [])).toBe("2026-05-02");
  });

  it("rebuilds the status at a day from history, ignoring malformed entries", () => {
    const p = Fy.p({ status: "Complete", createdAt: new Date("2025-09-01T12:00:00Z") });
    const h = [
      Fy.created(p.id, "2025-09-01T12:00:00Z", "NotStarted"),
      Fy.status(p.id, "2026-01-10T12:00:00Z", "NotStarted", "AtRisk"),
      Fy.status(p.id, "2026-08-01T12:00:00Z", "AtRisk", "Complete"),
      { projectId: p.id, changedAt: new Date("2026-03-01T12:00:00Z"), field: "status", oldValue: "old 200", newValue: "new 200" },
    ];
    expect(ClosedProjects.statusOn(p, "2025-10-01", h)).toBe("NotStarted");
    expect(ClosedProjects.statusOn(p, "2026-06-30", h)).toBe("AtRisk");
    expect(ClosedProjects.statusOn(p, "2026-08-01", h)).toBe("Complete");
    expect(ClosedProjects.statusOn(p, "2025-08-31", h)).toBeNull();
    // No usable history: today's status.
    expect(ClosedProjects.statusOn(p, "2026-06-30", [h[3]])).toBe("Complete");
    // Before the first change with no created entry: the value it changed from.
    expect(ClosedProjects.statusOn(p, "2025-12-01", h.slice(1))).toBe("NotStarted");
  });

  it("final update: the accomplishment of a completed project, else the note", () => {
    expect(ClosedProjects.finalUpdate({ status: "Complete", accomplishment: " Went live. ", note: "n" })).toBe("Went live.");
    expect(ClosedProjects.finalUpdate({ status: "Complete", accomplishment: " ", note: "Note" })).toBe("Note");
    expect(ClosedProjects.finalUpdate({ status: "Cancelled", accomplishment: "a", note: null })).toBeNull();
  });
});

describe("FiscalYear labels", () => {
  it("parses and advances labels", () => {
    expect(FiscalYear.fromLabel("FY27")).toEqual({ label: "FY27", start: "2026-07-01", end: "2027-06-30" });
    expect(FiscalYear.fromLabel("2027")).toBeNull();
    expect(FiscalYear.nextLabel("FY27")).toBe("FY28");
    expect(FiscalYear.nextLabel("FY99")).toBe("FY00");
  });
});

describe("FY sections (Completed and Cancelled pages, tile)", () => {
  const done = (over: Over) => Fy.p({ status: "Complete", ...over });

  it("sorts newest first, splits by year, and the tile equals the current Completed section", () => {
    const rows = Fy.rows([
      done({ name: "B", completedOn: "2026-08-01" }),
      done({ name: "A", completedOn: "2026-08-01" }),
      done({ name: "Newest", completedOn: "2026-09-20" }),
      done({ name: "Last FY", completedOn: "2026-06-30" }),
      done({ name: "Future", completedOn: "2026-10-01" }),
      Fy.p({ name: "Open", status: "OnTrack" }),
    ]);
    const current = FiscalYearSections.section(rows, "FY27", "Complete");
    expect(current.map((r) => r.name)).toEqual(["Newest", "A", "B"]);
    expect(FiscalYearSections.section(rows, "FY26", "Complete").map((r) => r.name)).toEqual(["Last FY"]);
    expect(FiscalYearRows.tile(rows, TODAY)).toEqual({ label: "FY27", start: "2026-07-01", count: current.length });
    expect(FiscalYearSections.years(rows, TODAY)).toEqual(["FY27", "FY26"]);
    expect(FiscalYearSections.years([], TODAY)).toEqual(["FY27"]);
  });

  it("rolls over on July 1", () => {
    const rows = Fy.rows([done({ completedOn: "2026-06-30" }), done({ completedOn: "2026-07-01" })], [], "2026-07-01");
    expect(FiscalYearRows.tile(rows, "2026-06-30").count).toBe(1);
    expect(FiscalYearRows.tile(rows, "2026-07-01")).toMatchObject({ label: "FY27", count: 1 });
    expect(FiscalYearRows.tile(rows, "2027-07-01")).toMatchObject({ label: "FY28", count: 0 });
  });

  it("follows dashboard visibility: hidden and deleted projects stay out", () => {
    const rows = Fy.rows([
      done({ name: "Shown", completedOn: "2026-08-01" }),
      done({ name: "Hidden", completedOn: "2026-08-01", hiddenFromDashboard: true }),
      done({ name: "Deleted", completedOn: "2026-08-01", archivedAt: new Date() }),
      done({ name: "Report-hidden", completedOn: "2026-08-01", hiddenFromReport: true }),
    ]);
    expect(rows.map((r) => r.name).sort()).toEqual(["Report-hidden", "Shown"]);
  });
});

describe("Year-end report data", () => {
  const projects = () => {
    const done27 = Fy.p({ name: "Done 27", serviceArea: "Echo", status: "Complete", completedOn: "2026-08-01", accomplishment: "Live." });
    const done26 = Fy.p({ name: "Done 26", serviceArea: "Cath", status: "Complete", completedOn: "2026-03-01" });
    const stop26 = Fy.p({ name: "Stop 26", serviceArea: null, status: "Cancelled" });
    const open = Fy.p({ name: "Open", serviceArea: "IR", status: "AtRisk", note: "Waiting on vendor." });
    const excluded = Fy.p({ name: "Excluded", serviceArea: "EP", status: "OnTrack", includeInReport: false });
    const hidden = Fy.p({ name: "Hidden", serviceArea: "EP", status: "Complete", completedOn: "2026-08-01", hiddenFromReport: true });
    const old = Fy.p({ name: "Closed FY25", serviceArea: "Cath", status: "Complete", completedOn: "2025-02-01", createdAt: new Date("2024-10-01T12:00:00Z") });
    const history = [
      Fy.status(stop26.id, "2026-02-10T15:00:00Z", "OnHold", "Cancelled"),
      Fy.status(done27.id, "2026-08-01T15:00:00Z", "OnTrack", "Complete"),
      Fy.created(done27.id, "2026-01-05T15:00:00Z", "OnTrack"),
      Fy.status(open.id, "2026-07-15T15:00:00Z", "OffTrack", "AtRisk"),
    ];
    return { list: [done27, done26, stop26, open, excluded, hidden, old], history };
  };

  it("current year: to date, carried uses today's status, every department regardless of the weekly filter", () => {
    const { list, history } = projects();
    const d = Fy.data(list, history, "FY27");
    expect(d.toDate).toBe(true);
    expect(d.title).toBe("FY27 Year-End Report");
    expect(d.periodText).toBe("Jul 1, 2026 \u2013 Sep 27, 2026 (to date)");
    expect(d.sections.map((s) => [s.heading, s.count])).toEqual([["Completed in FY27", 1], ["Cancelled in FY27", 0], ["Still in progress", 1]]);
    expect(d.sections[0].groups[0].rows[0]).toMatchObject({ name: "Done 27", date: "2026-08-01", finalUpdate: "Live." });
    expect(d.sections[1].emptyText).toBe("No projects cancelled in FY27 so far.");
    expect(d.sections[2].groups[0]).toMatchObject({ label: "IR" });
    expect(d.sections[2].groups[0].rows[0]).toMatchObject({ name: "Open", status: "AtRisk", date: null, finalUpdate: "Waiting on vendor." });
    // Grid: carried in from FY26 = open at the end of Jun 30, 2026 (Done 27 and Open); still in progress = open
    // today (Open); Completed FY27 1.
    expect(d.summary.at(-1)).toEqual({ area: "total", label: "Total", muted: false, carriedIn: 2, openAtEnd: 1, completed: 1 });
    expect(d.carriedInNote).toBeNull();
    expect(d.openAtEndNote).toBeNull();
  });

  it("past year: full period, closed dates in the year, carried status rebuilt at June 30", () => {
    const { list, history } = projects();
    const d = Fy.data(list, history, "FY26");
    expect(d.toDate).toBe(false);
    expect(d.periodText).toBe("Jul 1, 2025 \u2013 Jun 30, 2026");
    const names = (i: number) => d.sections[i].groups.flatMap((g) => g.rows.map((r) => r.name));
    expect(names(0)).toEqual(["Done 26"]);
    expect(names(1)).toEqual(["Stop 26"]);
    // Done 27 was OnTrack at the FY26 end (completed in FY27); Open was OffTrack then.
    expect(d.sections[2].groups.flatMap((g) => g.rows.map((r) => [r.name, r.status]))).toEqual([["Done 27", "OnTrack"], ["Open", "OffTrack"]]);
    // Groups follow the line's department order, Unassigned last and muted; empty departments are left out.
    // The grid has no Cancelled column, so a department with only a cancelled project (Unassigned here) isn't listed.
    expect(d.summary.map((s) => s.label)).toEqual(["Cath", "Echo", "IR", "Total"]);
    expect(d.sections[1].groups[0]).toMatchObject({ label: "Unassigned", muted: true });
  });

  it("empty past year copy, and the dialog years", () => {
    const d = Fy.data([], [], "FY25");
    expect(d.sections.map((s) => s.emptyText)).toEqual(["No projects were completed in FY25.", "No projects were cancelled in FY25.", "No active projects carry into FY26."]);
    const { list, history } = projects();
    expect(YearEndReportData.years(list, history, TODAY)).toEqual(["FY27", "FY26", "FY25"]);
  });

  it("copy and file names", () => {
    expect(YearEndCopy.BUTTON).toBe("Year-end report");
    expect(YearEndCopy.DIALOG_TITLE).toBe("Generate year-end report");
    expect(YearEndCopy.HELPER).toBe('Covers July 1 to June 30. A current-year report runs through today and is marked "to date." It isn\'t emailed or added to the scheduled archive.');
    expect(YearEndCopy.GENERATING).toBe("Generating\u2026");
    expect(YearEndCopy.ERROR).toBe("Couldn't generate the report. Try again.");
    expect(YearEndCopy.listRow("FY27", new Date("2026-09-27T04:34:00Z"), "Nick Leary")).toBe("FY27 Year-End Report, generated Sep 27, 2026, 12:34 AM ET by Nick Leary");
    expect(YearEndCopy.fileName("FY27", "2026-09-27", null)).toBe("fy27-year-end-report-2026-09-27.pdf");
    expect(YearEndCopy.fileName("FY27", "2026-09-27", "ONC")).toBe("onc-fy27-year-end-report-2026-09-27.pdf");
    const all = Object.values(YearEndCopy).filter((v) => typeof v === "string").join(" ");
    expect(all).not.toContain("\u2014");
  });

  it("lays out and renders a PDF with a continued department across pages", async () => {
    const many = Array.from({ length: 60 }, (_, i) => Fy.p({ name: `Carried ${String(i).padStart(2, "0")}`, serviceArea: "Cath", status: "OnTrack" }));
    const d = Fy.data(many, [], "FY27");
    const layout = YearEndLayout.layout(d, new Date("2026-09-27T16:00:00Z"), "Nick Leary");
    expect(layout.pages.length).toBeGreaterThan(1);
    expect(layout.footerLeft).toBe("Generated Sep 27, 2026 by Nick Leary \u00b7 FY27 Year-End Report");
    expect(layout.pages[1].blocks.find((b) => b.kind === "dept")).toMatchObject({ label: "Cath", continued: true });
    const pdf = await YearEndRenderer.render(d, new Date("2026-09-27T16:00:00Z"), "Nick Leary");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((pdf.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length).toBe(layout.pages.length);
  }, 30000);
});

describe("YearEndReportService", () => {
  it("stores one row per generation, admin only, and never creates a snapshot or artifact", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    fake.state.projects.push({ ...Fy.p({ name: "Done", status: "Complete", completedOn: "2026-08-01" }), serviceLineId: ServiceLine.DEFAULT_ID });
    const scope = ServiceLine.defaultScope();
    const now = new Date("2026-09-27T16:00:00Z");
    await expect(YearEndReportService.generate(Factory.MEMBER, "FY27", scope, db, now)).rejects.toBeInstanceOf(AdminRequiredError);
    const e = await YearEndReportService.generate({ ...Factory.ADMIN, name: "Nick Leary" }, "FY27", scope, db, now);
    expect(e).toMatchObject({ fiscalYear: "FY27", toDate: true, generatedByName: "Nick Leary", fileName: "fy27-year-end-report-2026-09-27.pdf" });
    expect(YearEndReportService.listText(e)).toBe("FY27 Year-End Report, generated Sep 27, 2026, 12:00 PM ET by Nick Leary");
    expect(fake.writes.map((w) => w.model)).toEqual(["yearEndReport"]);
    expect(fake.state.snapshots).toHaveLength(0);
    expect(fake.state.artifacts).toHaveLength(0);
    const row = fake.state.yearEndReports[0];
    expect(row.byteSize).toBe((row.bytes as Uint8Array).byteLength);
    expect(await YearEndReportService.list(scope, db)).toHaveLength(1);
    const file = await YearEndReportService.file(e.id, scope, db);
    expect(file?.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await YearEndReportService.file(e.id, { id: "00000000-0000-4000-8000-0000000000ff" }, db)).toBeNull();
    await expect(YearEndReportService.generate(Factory.ADMIN, "FY28", scope, db, now)).rejects.toThrow();
  }, 30000);
});
