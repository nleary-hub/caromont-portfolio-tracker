import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardTable } from "@/components/DashboardTable";
import { ProjectEditPolicy } from "@/lib/access/ProjectEditPolicy";
import { DashboardQuery } from "@/lib/dashboard/DashboardQuery";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReviewService } from "@/lib/services/ReviewService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const TODAY = "2026-10-12";
const admin = { email: "nick.leary@example.org", isAdmin: true };
const viewer = { email: "viewer@example.org", isAdmin: false };
const scope = ServiceLine.defaultScope();

function rows(projects: ProjectRecord[]): DashboardRow[] {
  const settings = ViewSettings.normalize("dashboard", {});
  return DashboardViewModel.rows(projects, settings, [], null, TODAY);
}

describe("header sort stays inside departments", () => {
  const projects = [
    Factory.project({ name: "Zeta EP", serviceArea: "EP" }),
    Factory.project({ name: "Alpha Cath", serviceArea: "Cath" }),
    Factory.project({ name: "Beta EP", serviceArea: "EP" }),
    Factory.project({ name: "Yak Cath", serviceArea: "Cath" }),
  ];
  const render = (sort: { key: "name"; dir: "asc" | "desc" } | null) => {
    const settings = ViewSettings.normalize("dashboard", {});
    return renderToStaticMarkup(
      createElement(DashboardTable, {
        rows: rows(projects),
        settings,
        selectedId: null,
        onSelect: () => {},
        today: TODAY,
        emptyText: "None",
        renderMeta: () => null,
        onSort: () => {},
        layout: { value: { columns: null, rowOrder: {} } as never, canEdit: true, sort, onColumns: () => {}, onRowOrder: () => {} },
      }),
    );
  };
  const order = (html: string) => [...html.matchAll(/data-part="project-name"[^>]*>([^<]+)</g)].map((m) => m[1]);
  const areas = (html: string) => [...html.matchAll(/data-area="([^"]+)"/g)].map((m) => m[1]);

  it("ascending and descending reorder rows within each department; the department order never changes", () => {
    const asc = render({ key: "name", dir: "asc" });
    const desc = render({ key: "name", dir: "desc" });
    expect(areas(asc)).toEqual(["Cath", "EP"]);
    expect(areas(desc)).toEqual(["Cath", "EP"]);
    expect(order(asc)).toEqual(["Alpha Cath", "Yak Cath", "Beta EP", "Zeta EP"]);
    expect(order(desc)).toEqual(["Yak Cath", "Alpha Cath", "Zeta EP", "Beta EP"]);
    expect(asc).toContain('aria-sort="ascending"');
    expect(desc).toContain('aria-sort="descending"');
  });

  it("cycles ascending, descending, manual", () => {
    const a = DashboardQuery.nextSort(null, "name");
    const d = DashboardQuery.nextSort(a, "name");
    expect(a).toEqual({ key: "name", dir: "asc" });
    expect(d).toEqual({ key: "name", dir: "desc" });
    expect(DashboardQuery.nextSort(d, "name")).toBeNull();
  });
});

describe("filters, search and sort combined", () => {
  const projects = [
    Factory.project({ name: "Holter upgrade", serviceArea: "EP", owner: "Owner A", status: "OnTrack", dueDate: new Date("2026-10-14T00:00:00Z") }),
    Factory.project({ name: "Holter archive", serviceArea: "EP", owner: "Owner A", status: "AtRisk", dueDate: new Date("2026-10-13T00:00:00Z") }),
    Factory.project({ name: "Holter legacy", serviceArea: "Cath", owner: "Owner B", status: "OnTrack", dueDate: new Date("2026-10-15T00:00:00Z") }),
    Factory.project({ name: "Cath lab refresh", serviceArea: "Cath", owner: "Owner A", status: "OnTrack", dueDate: new Date("2026-12-01T00:00:00Z") }),
  ];
  it("search + owner + due this week, then sorted by name", () => {
    const q = { ...DashboardQuery.empty(), search: "holter", projectOwners: ["Owner A"], due: { kind: "thisWeek" as const }, sort: { key: "name" as const, dir: "asc" as const } };
    const out = DashboardQuery.apply(rows(projects), q, TODAY);
    expect(out.map((r) => r.name).sort()).toEqual(["Holter archive", "Holter upgrade"]);
    const sorted = [...out].sort(DashboardQuery.comparator(q.sort)!);
    expect(sorted.map((r) => r.name)).toEqual(["Holter archive", "Holter upgrade"]);
    expect(DashboardQuery.weekRange(TODAY)).toEqual({ from: "2026-10-12", to: "2026-10-18" });
  });

  it("persists per user and normalizes bad storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const q = { ...DashboardQuery.empty(), search: "holter" };
    DashboardQuery.write(storage as never, "a@x.org", q);
    expect(DashboardQuery.read(storage as never, "a@x.org").search).toBe("holter");
    expect(DashboardQuery.read(storage as never, "b@x.org")).toEqual(DashboardQuery.empty());
    expect(DashboardQuery.normalize("garbage")).toEqual(DashboardQuery.empty());
  });
});

describe("mark as reviewed", () => {
  const p = { id: "p1", dueDate: null, status: "OnTrack" as const };
  const edit = (at: string, field = "nextMilestone"): HistoryEntryRecord => ({ projectId: "p1", field, changedAt: new Date(at) });
  const prev = new Date("2026-10-01T10:00:00Z");

  it("clears Changed; the next edit brings it back", () => {
    const history = [edit("2026-10-05T10:00:00Z")];
    expect(ReportBuilder.flags(p, history, prev, TODAY).changed).toBe(true);
    const reviewed = { ...p, reviewedAt: new Date("2026-10-06T10:00:00Z") };
    const withMark = [...history, edit("2026-10-06T10:00:00Z", "reviewed")];
    expect(ReportBuilder.flags(reviewed, withMark, prev, TODAY).changed).toBe(false);
    expect(ReportBuilder.flags(reviewed, [...withMark, edit("2026-10-07T10:00:00Z")], prev, TODAY).changed).toBe(true);
  });

  it("never sets Changed and leaves Stale (Updated) untouched", () => {
    const old = [edit("2026-08-01T10:00:00Z")];
    const mark = [...old, edit("2026-10-11T10:00:00Z", "reviewed")];
    expect(ReportBuilder.updatedOn("p1", mark)).toBe(ReportBuilder.updatedOn("p1", old));
    expect(ReportBuilder.flags({ ...p, reviewedAt: new Date("2026-10-11T10:00:00Z") }, mark, prev, TODAY).changed).toBe(false);
    expect(ReportBuilder.isChanged("p1", mark, prev)).toBe(ReportBuilder.isChanged("p1", old, prev));
  });

  it("only people who can edit the line's projects may mark; others are skipped, and it is audited", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const proj = await ProjectService.create({ name: "A", serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" } as never, { changedBy: admin.email }, db);
    expect(ProjectEditPolicy.canEdit(viewer, scope, proj)).toBe(false);
    expect(ProjectEditPolicy.canEditLine(viewer)).toBe(false);
    const denied = await ReviewService.mark(db, viewer, scope, [proj.id], false);
    expect(denied).toMatchObject({ ids: [], skipped: 1 });
    const now = new Date("2026-10-12T14:00:00Z");
    const ok = await ReviewService.mark(db, admin, scope, [proj.id], true, now);
    expect(ok.ids).toEqual([proj.id]);
    const row = fake.state.projects.find((x) => x.id === proj.id) as unknown as { reviewedAt: Date; reviewedBy: string };
    expect(row.reviewedAt.toISOString()).toBe(now.toISOString());
    expect(row.reviewedBy).toBe(admin.email);
    const audit = fake.state.history.filter((h) => h.field === "reviewed");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ comment: "bulk", changedBy: admin.email });
  });
});

describe("status chip toggles and the PDF legend", () => {
  const m = new TextMeasure();
  const off = ViewSettings.defaults("report");
  const on = ViewSettings.withStatusChips("report", off, true);
  const head = (s: typeof off) => {
    const input = SampleReportData.docInput({ viewSettings: s });
    return ReportLayout.header(m, input, input.header!);
  };

  it("both contexts default to off", () => {
    expect(ViewSettings.defaults("report").showStatusChips).toBe(false);
    expect(ViewSettings.defaults("dashboard").showStatusChips).toBe(false);
    expect(ViewSettings.isColumnVisible(off, "flags")).toBe(false);
    expect(ViewSettings.isColumnVisible(on, "flags")).toBe(true);
  });

  it("off drops the legend and the flag key; on keeps them", () => {
    expect(head(off).chips).toBe(false);
    expect(head(on).chips).toBe(true);
    expect(ReportLayout.key(m, off).title).toBe("Status key");
    expect(ReportLayout.key(m, off).flags).toEqual([]);
    expect(ReportLayout.key(m, on).flags.length).toBeGreaterThan(0);
  });

  it("legacy settings (no key, frozen snapshots) keep the classic chips and legend", () => {
    expect(head(ViewSettings.normalize("report", null)).chips).toBe(true);
    expect(head(ViewSettings.normalize("report", null)).reviewCopy).toBe(false);
    expect(ReportLayout.legendText("changed")).toBe("differs from last report");
  });

  it("chips on: the Changed legend mentions the review; Overdue and Stale unchanged", () => {
    expect(head(on).reviewCopy).toBe(true);
    expect(ReportLayout.legendText("changed", true)).toBe("edited since the last report or review");
    expect(ReportLayout.legendText("overdue", true)).toBe(ReportLayout.legendText("overdue"));
    expect(ReportLayout.legendText("stale", true)).toBe(ReportLayout.legendText("stale"));
  });
});

describe("review copy", () => {
  it("per-row and bulk buttons say 'as reviewed'", async () => {
    const { QueryCopy } = await import("@/components/DashboardQueryControls");
    expect(QueryCopy.MARK_REVIEWED).toBe("Mark as reviewed");
    expect(QueryCopy.markAll(7)).toBe("Mark all as reviewed (7)");
  });
});
