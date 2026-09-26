import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompletedFiscalYearCard } from "@/components/ProjectDashboard";
import { AppConfig } from "@/lib/config/AppConfig";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import type { ReportHeader } from "@/lib/domain/types";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "owner@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };

class Setup {
  static db() {
    const fake = new FakeDb();
    return { fake, db: fake.asClient() };
  }
  /** Move a project's history (optionally one field) to a fixed time. */
  static at(fake: FakeDb, projectId: string, iso: string, field?: string): void {
    for (const h of fake.state.history) if (h.projectId === projectId && (!field || h.field === field)) h.changedAt = new Date(iso);
  }
  static count(fake: FakeDb, reportDate: string) {
    return CompletedFiscalYear.count({ projects: fake.state.projects as never, history: fake.state.history as never, reportDate });
  }
}

describe("FiscalYear", () => {
  it("starts July 1 (AppConfig) and is named by the calendar year it ends in", () => {
    expect(AppConfig.FISCAL_YEAR_START_MONTH).toBe(7);
    expect(FiscalYear.of("2026-07-01")).toEqual({ label: "FY27", start: "2026-07-01", end: "2027-06-30" });
    expect(FiscalYear.of("2026-06-30")).toEqual({ label: "FY26", start: "2025-07-01", end: "2026-06-30" });
    expect(FiscalYear.of("2027-06-30").label).toBe("FY27");
    expect(FiscalYear.of("2026-03-15", 1)).toEqual({ label: "FY26", start: "2026-01-01", end: "2026-12-31" });
    expect(FiscalYear.completedLabel("FY27")).toBe("Completed FY27 to date");
  });
});

describe("Completed FY to date: count", () => {
  it("FY boundary: completedOn Jun 30 is last FY, Jul 1 counts; the report date is inclusive", async () => {
    const { fake, db } = Setup.db();
    await ProjectService.create({ ...base, name: "Jun 30", status: "Complete", completedOn: "2026-06-30" }, actor, db);
    await ProjectService.create({ ...base, name: "Jul 1", status: "Complete", completedOn: "2026-07-01" }, actor, db);
    await ProjectService.create({ ...base, name: "On report day", status: "Complete", completedOn: "2026-09-29" }, actor, db);
    await ProjectService.create({ ...base, name: "After report day", status: "Complete", completedOn: "2026-09-30" }, actor, db);
    expect(Setup.count(fake, "2026-09-29")).toEqual({ label: "FY27", start: "2026-07-01", count: 2 });
    expect(Setup.count(fake, "2026-06-30")).toMatchObject({ label: "FY26", count: 1 });
    // Not once-only: the same projects count again in a later report of the same FY.
    expect(Setup.count(fake, "2026-10-13").count).toBe(3);
    // The FY rolls over: nothing from FY27 counts in FY28.
    expect(Setup.count(fake, "2027-07-01").count).toBe(0);
  });

  it("uses completedOn when entered, else the day the status became Complete (history, ET)", async () => {
    const { fake, db } = Setup.db();
    const a = await ProjectService.create({ ...base, name: "Entered early", completedOn: "2026-06-15" }, actor, db);
    await ProjectService.update(a.id, { status: "Complete" }, actor, db);
    Setup.at(fake, a.id, "2026-09-10T15:00:00Z");
    const b = await ProjectService.create({ ...base, name: "No date" }, actor, db);
    await ProjectService.update(b.id, { status: "Complete" }, actor, db);
    Setup.at(fake, b.id, "2026-06-01T15:00:00Z", "created");
    // 2026-07-01 02:00 UTC is still June 30 in New York: last FY.
    Setup.at(fake, b.id, "2026-07-01T02:00:00Z", "status");
    expect(Setup.count(fake, "2026-09-29").count).toBe(0);
    Setup.at(fake, b.id, "2026-07-01T05:00:00Z", "status");
    expect(Setup.count(fake, "2026-09-29").count).toBe(1);
    const created = await ProjectService.create({ ...base, name: "Imported done", status: "Complete" }, actor, db);
    Setup.at(fake, created.id, "2026-08-01T15:00:00Z");
    expect(Setup.count(fake, "2026-09-29").count).toBe(2);
  });

  it("reopened, cancelled, hidden, not in report and deleted projects do not count", async () => {
    const { fake, db } = Setup.db();
    const done = { ...base, status: "Complete", completedOn: "2026-08-01" };
    await ProjectService.create({ ...done, name: "Counts" }, actor, db);
    const reopened = await ProjectService.create({ ...done, name: "Reopened" }, actor, db);
    await ProjectService.update(reopened.id, { status: "OnTrack" }, actor, db);
    await ProjectService.create({ ...base, name: "Cancelled", status: "Cancelled", completedOn: "2026-08-01" }, actor, db);
    const hidden = await ProjectService.create({ ...done, name: "Hidden" }, actor, db);
    await ProjectService.setHidden(hidden.id, "report", true, Factory.ADMIN, db);
    await ProjectService.create({ ...done, name: "Excluded", includeInReport: false }, actor, db);
    const deleted = await ProjectService.create({ ...done, name: "Deleted" }, actor, db);
    await ProjectService.softDelete(deleted.id, Factory.ADMIN, db);
    // Hidden from the dashboard only still counts (the rule follows the report).
    const dashHidden = await ProjectService.create({ ...done, name: "Dashboard hidden" }, actor, db);
    await ProjectService.setHidden(dashHidden.id, "dashboard", true, Factory.ADMIN, db);
    expect(Setup.count(fake, "2026-09-29").count).toBe(2);
  });

  it("is frozen in the snapshot header and survives later changes", async () => {
    const { fake, db } = Setup.db();
    const p = await ProjectService.create({ ...base, name: "Done", status: "Complete", completedOn: "2026-09-01" }, actor, db);
    const s = await SnapshotService.create({ periodStart: "2026-09-15", periodEnd: "2026-09-29", generatedBy: "nick", now: new Date("2026-09-29T21:00:00Z") }, db);
    const header = s.headerJson as unknown as ReportHeader;
    expect(header.completedFiscalYear).toEqual({ label: "FY27", start: "2026-07-01", count: 1 });
    await ProjectService.update(p.id, { status: "OnTrack" }, actor, db);
    expect(Setup.count(fake, "2026-09-29").count).toBe(0);
    expect((fake.state.snapshots[0].headerJson as unknown as ReportHeader).completedFiscalYear?.count).toBe(1);
  });
});

describe("Completed FY to date: display", () => {
  it("report page 1 shows it in place of the old period count (teal check); the section blocks stay", () => {
    const layout = ReportLayout.layout(SampleReportData.docInput(), new TextMeasure());
    expect(layout.header.completedFy).toEqual({ label: "Completed FY27 to date", count: SampleReportData.FY_COMPLETED });
    expect(layout.header.completedAt).not.toBeNull();
    expect(layout.pages.flatMap((p) => p.blocks).some((b) => b.kind === "completed")).toBe(true);
    expect(JSON.stringify(layout.header)).not.toContain("Completed this period");
  });

  it("dashboard summary card and handoff.json carry the label and count", () => {
    const html = renderToStaticMarkup(createElement(CompletedFiscalYearCard, { fy: { label: "FY27", start: "2026-07-01", count: 4 } }));
    expect(html).toContain(">4<");
    expect(html).toContain("Completed FY27 to date");
    const input = SampleReportData.docInput();
    const h = HandoffBuilder.build({
      snapshotId: "s",
      periodStart: "2026-09-15",
      periodEnd: "2026-09-29",
      reportDate: "2026-09-29",
      frozenAt: new Date("2026-09-29T21:00:00Z"),
      rows: input.rows,
      header: input.header,
      completed: input.completed,
      pdf: { fileName: "x.pdf", sha256: "0", byteSize: 1 },
      baseUrl: null,
      reportRecipient: null,
    });
    expect(h.completedFiscalYear).toEqual({ label: "FY27", fiscalYearStart: "2026-07-01", count: SampleReportData.FY_COMPLETED });
    expect(h.completedThisPeriod.projects.length).toBe(input.completed!.length);
    expect(HandoffBuilder.build({ ...{ snapshotId: "s", periodStart: "2026-09-15", periodEnd: "2026-09-29", reportDate: "2026-09-29", frozenAt: new Date(), rows: [], header: null, pdf: { fileName: "x", sha256: "0", byteSize: 1 }, baseUrl: null, reportRecipient: null } }).completedFiscalYear).toBeNull();
  });
});
