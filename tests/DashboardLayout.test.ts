import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardTable, DueFlagsCellView, MilestoneUpdateCell, PeopleCell } from "@/components/DashboardTable";
import { DashboardColumnModel } from "@/lib/dashboard/DashboardColumnModel";
import { CompletedBlockCopy, DashboardGroups } from "@/lib/dashboard/DashboardGroups";
import { DashboardViewModel, type DashboardCompletedRow, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { PeopleStack } from "@/lib/dashboard/PeopleStack";
import { DueFlags, MilestoneUpdateStack } from "@/lib/dashboard/StackedCells";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import type { CompletableProject } from "@/lib/report/CompletedThisPeriod";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { CompletedBlockStyle, ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { Factory } from "./helpers/factories";

const TODAY = "2026-09-26";
const ALL = { owner: true, requester: true, contracts: true };
const dash = (raw: object = {}): ViewSettingsValue => ViewSettings.normalize("dashboard", raw);
const keys = (s: ViewSettingsValue) => DashboardColumnModel.columns(s).map((c) => c.key);

function completable(over: Partial<CompletableProject> = {}): CompletableProject {
  return { ...Factory.project(), completionReportedAt: null, createdAt: new Date("2026-09-01T12:00:00Z"), ...over };
}
function statusToComplete(projectId: string, at: string): HistoryEntryRecord {
  return { projectId, field: "status", oldValue: "OnTrack", newValue: "Complete", changedAt: new Date(at), changedBy: "x", comment: null } as HistoryEntryRecord;
}
function dashRows(projects: ProjectRecord[], settings = dash()): DashboardRow[] {
  return DashboardViewModel.rows(projects, settings, [], null, TODAY);
}

describe("Grouping matches the PDF", () => {
  it("same department sections, order, counts and row order as ReportLayout.layout on the sample report", () => {
    const input = SampleReportData.docInput();
    const rows = input.rows.filter((r) => ViewSettings.isStatusVisible(input.viewSettings, r.status));
    const completed = input.completed ?? [];
    const layout = ReportLayout.layout(input, new TextMeasure());
    const blocks = layout.pages.flatMap((p) => p.blocks);
    const pdfSections = blocks.flatMap((b) => (b.kind === "section" && !b.continued ? [b] : []));
    const groups = DashboardGroups.group(rows, completed);
    expect(groups.map((g) => g.area)).toEqual(pdfSections.map((s) => s.area));
    expect(groups.map((g) => g.countText)).toEqual(pdfSections.map((s) => ReportLayout.sectionCountText(s.count, s.completedCount)));
    const pdfRowOrder = blocks.flatMap((b) => (b.kind === "row" ? [b.row.projectId] : []));
    expect(groups.flatMap((g) => g.rows.map((r) => r.projectId))).toEqual(pdfRowOrder);
    const pdfCompleted = blocks.flatMap((b) => (b.kind === "completed" ? b.rows.map((r) => r.projectId) : []));
    expect(groups.flatMap((g) => g.completed.map((c) => c.projectId))).toEqual(pdfCompleted);
  });

  it("departments in ServiceAreaInfo order with Unassigned last; empty departments are left out", () => {
    const rows = [
      { serviceArea: null, id: "u" },
      { serviceArea: "IR" as const, id: "ir" },
      { serviceArea: "CardioNeuro" as const, id: "cn" },
      { serviceArea: "EP" as const, id: "ep" },
      { serviceArea: "Cath" as const, id: "cath" },
    ];
    const groups = DashboardGroups.group(rows);
    // The PDF order comes from ServiceAreaInfo.groups(): CardioNeuro before IR.
    expect(groups.map((g) => g.label)).toEqual(["Cath", "EP", "CardioNeuro", "IR", "Unassigned"]);
    expect(groups.map((g) => g.area)).toEqual(ServiceAreaInfo.groups().filter((a) => groups.some((g) => g.area === a)));
    expect(groups.find((g) => g.area === "Unassigned")?.muted).toBe(true);
    expect(groups.filter((g) => g.muted)).toHaveLength(1);
    expect(groups.some((g) => g.area === "Echo")).toBe(false);
  });

  it("a comparator sorts inside each group and never mixes groups", () => {
    const rows = [
      { serviceArea: "EP" as const, name: "b" },
      { serviceArea: "Cath" as const, name: "z" },
      { serviceArea: "EP" as const, name: "a" },
      { serviceArea: "Cath" as const, name: "y" },
    ];
    const groups = DashboardGroups.group(rows, [], (x, y) => x.name.localeCompare(y.name));
    expect(groups.map((g) => g.rows.map((r) => r.name))).toEqual([["y", "z"], ["a", "b"]]);
  });

  it("count text is the PDF section count text", () => {
    for (const [n, c] of [[0, 1], [1, 0], [2, 0], [1, 1], [8, 2], [0, 3]]) {
      expect(DashboardGroups.countText(n, c)).toBe(ReportLayout.sectionCountText(n, c));
    }
    expect(DashboardGroups.countText(8, 0)).toBe("8 projects");
  });

  it("completed block copy matches the PDF block", () => {
    expect(CompletedBlockCopy.HEADING).toBe(CompletedBlockStyle.HEADING);
    expect(CompletedBlockCopy.NOTE).toBe(CompletedBlockStyle.NOTE);
    expect(CompletedBlockCopy.ACCOMPLISHMENT_MAX_LINES).toBe(CompletedBlockStyle.ACCOMPLISHMENT_MAX_LINES);
  });
});

describe("Completed this period on the dashboard", () => {
  const now = new Date("2026-09-26T18:00:00Z");

  it("lists what the next report lists, at the end of its own department group", () => {
    const done = completable({ name: "Done EP", serviceArea: "EP", status: "Complete", accomplishment: "Shipped", completedOn: Factory.date("2026-09-20") });
    const old = completable({ name: "Reported", status: "Complete", completionReportedAt: new Date("2026-09-15T00:00:00Z") });
    const later = completable({ name: "After cutoff", status: "Complete" });
    const hidden = completable({ name: "Hidden from dashboard", status: "Complete", hiddenFromDashboard: true });
    const active = completable({ name: "Active EP", serviceArea: "EP" });
    const projects = [done, old, later, hidden, active];
    const history = [statusToComplete(done.id, "2026-09-20T15:00:00Z"), statusToComplete(later.id, "2026-09-27T15:00:00Z"), statusToComplete(hidden.id, "2026-09-20T15:00:00Z")];
    const rows = dashRows(projects);
    expect(rows.map((r) => r.name)).toEqual(["Active EP"]); // Complete is hidden on the dashboard by default
    const selected = DashboardViewModel.completedThisPeriod({ projects, history, reportSettings: ViewSettings.defaults("report"), rowIds: rows.map((r) => r.id), now });
    expect(selected.map((c) => c.name)).toEqual(["Done EP"]);
    const full = DashboardViewModel.completedRows(projects, selected, history, null, TODAY);
    expect(full[0]).toMatchObject({ id: done.id, name: "Done EP", accomplishment: "Shipped", completedOn: "2026-09-20", status: "Complete" });
    const groups = DashboardGroups.group(rows, full);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ area: "EP", countText: "1 project \u00b7 1 completed this period" });
    expect(groups[0].completed.map((c) => c.name)).toEqual(["Done EP"]);
  });

  it("nothing when Complete is shown in the report, and never a project that is already a regular row", () => {
    const done = completable({ name: "Done", status: "Complete" });
    const history = [statusToComplete(done.id, "2026-09-20T15:00:00Z")];
    const shown = ViewSettings.withStatusHidden("report", ViewSettings.defaults("report"), "Complete", false);
    expect(DashboardViewModel.completedThisPeriod({ projects: [done], history, reportSettings: shown, rowIds: [], now })).toEqual([]);
    const dashShowsComplete = ViewSettings.withStatusHidden("dashboard", dash(), "Complete", false);
    const rows = dashRows([done], dashShowsComplete);
    expect(rows.map((r) => r.id)).toEqual([done.id]);
    expect(DashboardViewModel.completedThisPeriod({ projects: [done], history, reportSettings: ViewSettings.defaults("report"), rowIds: rows.map((r) => r.id), now })).toEqual([]);
  });

  it("a department with only completed rows still gets a section", () => {
    const groups = DashboardGroups.group([] as { serviceArea: null }[], [{ serviceArea: null }]);
    expect(groups.map((g) => [g.area, g.countText])).toEqual([["Unassigned", "1 completed this period"]]);
  });
});

describe("People cell display rules", () => {
  const texts = (row: Parameters<typeof PeopleStack.lines>[0], show = ALL) => PeopleStack.lines(row, show).map((l) => [l.kind, l.prefix ? `${l.prefix} ${l.text}` : l.text, l.muted]);

  it("Owner, Requester, Contracts in PDF order; blank reads To assign (muted)", () => {
    expect(texts({ owner: "Nick Leary", physicianChampion: "Dr. A", contractsLead: "Shea Waldron" })).toEqual([
      ["owner", "Nick Leary", false],
      ["requester", "Dr. A", false],
      ["contracts", "Contracts Shea Waldron", false],
    ]);
    expect(texts({ owner: null, physicianChampion: " ", contractsLead: null })).toEqual([
      ["owner", "To assign", true],
      ["requester", "To assign", true],
      ["contracts", "Contracts To assign", true],
    ]);
  });

  it("Not applicable drops the requester line; hidden fields drop their lines", () => {
    expect(texts({ owner: "O", physicianChampion: null, requesterNotApplicable: true, contractsLead: "C" }).map((t) => t[0])).toEqual(["owner", "contracts"]);
    expect(texts({ owner: "O", physicianChampion: "R", contractsLead: "C" }, { owner: false, requester: true, contracts: false }).map((t) => t[0])).toEqual(["requester"]);
    expect(PeopleStack.lines({ owner: "O", physicianChampion: "R" }, { owner: false, requester: false, contracts: false })).toEqual([]);
  });

  it("renders single-line entries with tooltips, To assign regular and gray, prefix at weight 500", () => {
    const html = renderToStaticMarkup(createElement(PeopleCell, { lines: PeopleStack.lines({ owner: null, physicianChampion: "Dr. Very Long Name", contractsLead: "Jeff Krause" }, ALL) }));
    expect(html).toContain('title="Dr. Very Long Name" class="truncate"');
    expect(html).toContain('title="Contracts Jeff Krause"');
    expect(html).toContain('<span class="font-normal text-muted">To assign</span>');
    expect(html).toContain('<span class="font-medium text-muted">Contracts </span>');
    expect(html).not.toMatch(/amber|at-risk/);
  });
});

describe("Next milestone / Latest update cell", () => {
  const BOTH = { milestone: true, update: true };
  const lines = (row: { nextMilestone?: string | null; note?: string | null; changed?: boolean }, show = BOTH) =>
    MilestoneUpdateStack.lines({ nextMilestone: row.nextMilestone ?? null, note: row.note ?? null, changed: row.changed ?? true }, show);

  it("the latest update is the current note, whitespace collapsed, null when blank", () => {
    expect(LatestUpdate.text({ note: "  Vendor  install\n booked. " })).toBe("Vendor install booked.");
    expect(LatestUpdate.text({ note: "   " })).toBeNull();
    expect(LatestUpdate.text({ note: null })).toBeNull();
    expect(LatestUpdate.EMPTY_NOTE_GLYPH).toBe("\u2014");
  });

  it("milestone first, then the update; unchanged rows read No change. in secondary (PDF)", () => {
    expect(lines({ nextMilestone: " Go  live ", note: "Booked.", changed: true })).toEqual([
      { kind: "milestone", text: "Go live" },
      { kind: "update", prefix: null, text: "Booked.", full: "Booked.", muted: false },
    ]);
    expect(lines({ nextMilestone: "M", note: "Same.", changed: false })[1]).toEqual({ kind: "update", prefix: "No change.", text: "Same.", full: "No change. Same.", muted: true });
    // Unchanged with no note still prints No change.; changed with no note prints nothing (PDF).
    expect(lines({ nextMilestone: "M", note: null, changed: false }).map((l) => l.kind)).toEqual(["milestone", "update"]);
    expect(lines({ nextMilestone: "M", note: " ", changed: true }).map((l) => l.kind)).toEqual(["milestone"]);
  });

  it("a blank milestone renders nothing (PDF), not a dash; an empty cell renders nothing", () => {
    expect(lines({ nextMilestone: "  ", note: "N", changed: true }).map((l) => l.kind)).toEqual(["update"]);
    expect(lines({ nextMilestone: null, note: null, changed: true })).toEqual([]);
    expect(renderToStaticMarkup(createElement(MilestoneUpdateCell, { lines: [] }))).toBe("");
  });

  it("hiding one part drops its line and the gap; hiding both leaves nothing", () => {
    const row = { nextMilestone: "M", note: "N", changed: true };
    expect(lines(row, { milestone: false, update: true }).map((l) => l.kind)).toEqual(["update"]);
    expect(lines(row, { milestone: true, update: false }).map((l) => l.kind)).toEqual(["milestone"]);
    expect(lines(row, { milestone: false, update: false })).toEqual([]);
    const one = renderToStaticMarkup(createElement(MilestoneUpdateCell, { lines: lines(row, { milestone: true, update: false }) }));
    expect(one).not.toContain('data-line="update"');
  });

  it("renders 13/18, milestone regular weight primary 2-line clamp with a tooltip, update unclamped with a 2px gap", () => {
    const html = renderToStaticMarkup(createElement(MilestoneUpdateCell, { lines: lines({ nextMilestone: "Go live", note: SampleReportData.LONG_NOTE, changed: false }) }));
    expect(html).toContain("text-[13px] leading-[18px]");
    expect(html).toContain("gap:2px");
    expect(html).toContain('data-line="milestone" title="Go live" class="line-clamp-2 break-words font-normal text-fg"');
    expect(html).toContain('data-line="update" data-muted="true"');
    expect(html).toContain('<span data-part="no-change">No change.</span>');
    expect(html).not.toMatch(/data-line="update"[^>]*line-clamp/);
  });
});

describe("Due / Flags cell", () => {
  const BOTH = { due: true, flags: true };
  const row = (over: Partial<{ dueDate: string | null; changed: boolean; overdue: boolean; stale: boolean }> = {}) => ({ dueDate: "2026-10-02", changed: false, overdue: false, stale: false, ...over });

  it("PDF date format (year when it differs), overdue flagged, blank date is a muted en dash", () => {
    expect(DueFlags.cell(row(), BOTH, TODAY).due).toEqual({ text: "Oct 2", overdue: false, muted: false });
    expect(DueFlags.cell(row({ dueDate: "2027-01-15" }), BOTH, TODAY).due?.text).toBe("Jan 15, 2027");
    expect(DueFlags.cell(row({ dueDate: "2026-09-01", overdue: true }), BOTH, TODAY).due).toEqual({ text: "Sep 1", overdue: true, muted: false });
    expect(DueFlags.cell(row({ dueDate: null }), BOTH, TODAY).due).toEqual({ text: "\u2013", overdue: false, muted: true });
  });

  it("flags in PDF order Changed, Overdue, Stale with PDF labels", () => {
    const c = DueFlags.cell(row({ changed: true, overdue: true, stale: true }), BOTH, TODAY);
    expect(c.flags).toEqual([
      { kind: "changed", label: "Changed" },
      { kind: "overdue", label: "! Overdue" },
      { kind: "stale", label: "Stale" },
    ]);
    expect(c.flags.map((f) => f.label)).toEqual((["changed", "overdue", "stale"] as const).map((k) => ReportLayout.flag(new TextMeasure(), k).label));
  });

  it("each part hides on its own", () => {
    const r = row({ changed: true });
    expect(DueFlags.cell(r, { due: false, flags: true }, TODAY)).toEqual({ due: null, flags: [{ kind: "changed", label: "Changed" }] });
    expect(DueFlags.cell(r, { due: true, flags: false }, TODAY).flags).toEqual([]);
    expect(DueFlags.cell(row(), { due: false, flags: true }, TODAY)).toEqual({ due: null, flags: [] });
    expect(renderToStaticMarkup(createElement(DueFlagsCellView, { cell: { due: null, flags: [] } }))).toBe("");
  });

  it("renders the date, 6px then 4px gaps, wrapping pills that never shrink, overdue weight 600", () => {
    const html = renderToStaticMarkup(createElement(DueFlagsCellView, { cell: DueFlags.cell(row({ overdue: true, changed: true, stale: true }), BOTH, TODAY) }));
    expect(html).toContain("flex flex-wrap items-start");
    expect(html).toContain("column-gap:6px;row-gap:4px");
    expect(html).toContain('<span data-part="due" class="whitespace-nowrap font-semibold text-danger">Oct 2<');
    expect(html).toContain('data-part="flags" class="flex flex-wrap" style="gap:4px"');
    expect(html).toContain('class="flag fl-changed flex-none" data-flag="changed"');
    expect(html).toContain('class="flag fl-overdue flex-none" data-flag="overdue"');
    expect(html).toContain('class="flag fl-stale flex-none" data-flag="stale"');
    expect(html).not.toContain("truncate");
    const blank = renderToStaticMarkup(createElement(DueFlagsCellView, { cell: DueFlags.cell(row({ dueDate: null }), BOTH, TODAY) }));
    expect(blank).toContain('class="whitespace-nowrap text-muted">\u2013<');
    expect(blank).not.toContain("data-flag");
  });
});

describe("Stacked cells match the PDF row", () => {
  it("milestone, update, due and flags equal ReportLayout.rowLayout on the sample report rows", () => {
    const input = SampleReportData.docInput();
    const settings = ViewSettings.defaults("report");
    const m = new TextMeasure();
    const date = input.reportDate;
    const squash = (t: string) => t.replace(/\s+/g, "");
    let checked = 0;
    for (const r of input.rows) {
      const pdf = ReportLayout.rowLayout(m, r, settings, date);
      const src = { nextMilestone: r.nextMilestone, note: r.note, changed: r.changed, dueDate: r.dueDate, overdue: r.overdue, stale: Boolean(r.stale) };
      const lines = MilestoneUpdateStack.lines(src, { milestone: true, update: true });
      const update = lines.find((l) => l.kind === "update");
      const milestone = lines.find((l) => l.kind === "milestone");
      if (pdf.note) {
        expect(update && update.kind === "update" ? squash(update.full) : null).toBe(squash(pdf.note.lines.map((l) => l.text).join("")));
        expect(update?.kind === "update" && update.muted).toBe(pdf.note.muted);
      } else {
        expect(update).toBeUndefined();
      }
      const ms = pdf.cells.find((c) => c.kind === "nextMilestone");
      if (ms?.kind === "nextMilestone") {
        if (ms.lines.length) {
          // The PDF may end its second line with an ellipsis; the dashboard clamps with CSS and keeps the full text.
          expect(milestone?.kind === "milestone" && squash(milestone.text).startsWith(squash(ms.lines.join("")).replace(/\u2026$/, ""))).toBe(true);
        } else expect(milestone).toBeUndefined();
      }
      const cell = DueFlags.cell(src, { due: true, flags: true }, date);
      const due = pdf.cells.find((c) => c.kind === "due");
      if (due?.kind === "due") {
        expect(cell.due?.text).toBe(due.text);
        expect(cell.due?.muted).toBe(due.muted);
        if (!due.muted) expect(cell.due?.overdue).toBe(due.overdue);
      }
      const flags = pdf.cells.find((c) => c.kind === "flags");
      if (flags?.kind === "flags") expect(cell.flags.map((f) => [f.kind, f.label])).toEqual(flags.flags.map((f) => [f.kind, f.label]));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe("Column model and show/hide", () => {
  const hide = (...h: string[]) => dash({ hiddenColumns: h });
  const flexKey = (v: ViewSettingsValue) => DashboardColumnModel.columns(v).filter((c) => c.flex).map((c) => c.key);

  it("default: gutter, Project, People, Status, Next milestone / Latest update (flex), Due / Flags; no department column", () => {
    expect(keys(dash())).toEqual(["gutter", "project", "people", "status", "milestoneUpdate", "dueFlags"]);
    const cols = DashboardColumnModel.columns(dash());
    expect(flexKey(dash())).toEqual(["milestoneUpdate"]);
    expect(DashboardColumnModel.spec("milestoneUpdate")).toMatchObject({ header: "Next milestone / Latest update", width: 280, minWidth: 280, flex: true });
    expect(DashboardColumnModel.spec("dueFlags")).toMatchObject({ header: "Due / Flags", width: 150, minWidth: 120, flex: false });
    expect(DashboardColumnModel.spec("people")).toMatchObject({ header: "People", width: 200, minWidth: 160 });
    expect(DashboardColumnModel.spec("gutter")).toMatchObject({ width: 24, structural: true });
    expect(DashboardColumnModel.minTableWidth(cols)).toBe(24 + 256 + 200 + 112 + 280 + 150);
    expect(ViewSettings.defaults("dashboard").columnOrder).not.toContain("serviceArea");
  });

  it("the department column is gone from the table and from show/hide", () => {
    expect(keys(dash()) as string[]).not.toContain("serviceArea");
    const entries = DashboardColumnModel.pickerEntries("dashboard", dash());
    expect(entries.some((e) => e.kind === "column" && e.column === "serviceArea")).toBe(false);
    expect(entries.some((e) => e.kind === "group" && e.columns.includes("serviceArea"))).toBe(false);
  });

  it("each people field hides on its own; People goes away only when all three are hidden", () => {
    expect(DashboardColumnModel.peopleVisibility(hide("owner"))).toEqual({ owner: false, requester: true, contracts: true });
    expect(keys(hide("owner", "physicianChampion"))).toContain("people");
    expect(DashboardColumnModel.peopleVisibility(hide("owner", "physicianChampion"))).toEqual({ owner: false, requester: false, contracts: true });
    expect(keys(hide("owner", "physicianChampion", "contractsLead"))).not.toContain("people");
    // Only the contracts lead left (it sits last in the order): People stays where Owner was.
    expect(keys(hide("owner", "physicianChampion")).indexOf("people")).toBe(2);
  });

  it("Next milestone and Latest update hide separately; the column goes only when both are hidden", () => {
    expect(DashboardColumnModel.milestoneUpdateVisibility(hide("latestUpdate"))).toEqual({ milestone: true, update: false });
    expect(keys(hide("latestUpdate"))).toContain("milestoneUpdate");
    expect(keys(hide("nextMilestone"))).toContain("milestoneUpdate");
    expect(keys(hide("nextMilestone", "latestUpdate"))).toEqual(["gutter", "project", "people", "status", "dueFlags"]);
  });

  it("Due date and Flags hide separately; the column goes only when both are hidden", () => {
    expect(DashboardColumnModel.dueFlagsVisibility(hide("flags"))).toEqual({ due: true, flags: false });
    expect(keys(hide("due"))).toContain("dueFlags");
    expect(keys(hide("flags"))).toContain("dueFlags");
    expect(keys(hide("due", "flags"))).toEqual(["gutter", "project", "people", "status", "milestoneUpdate"]);
  });

  it("stacked columns follow the first of their keys in the saved order; Project stays first", () => {
    const moved = dash({ columnOrder: ["status", "latestUpdate", "owner", "project", "due", "physicianChampion", "nextMilestone"] });
    expect(keys(moved).slice(0, 6)).toEqual(["gutter", "project", "status", "milestoneUpdate", "people", "dueFlags"]);
  });
});

describe("Flexible column fallback", () => {
  const hide = (...h: string[]) => dash({ hiddenColumns: h });
  const flexKey = (v: ViewSettingsValue) => DashboardColumnModel.columns(v).filter((c) => c.flex).map((c) => c.key);
  const BOTH_MU = ["nextMilestone", "latestUpdate"];
  const ALL_PEOPLE = ["owner", "physicianChampion", "contractsLead"];

  it("Next milestone / Latest update is flexible while either of its lines is shown", () => {
    expect(flexKey(dash())).toEqual(["milestoneUpdate"]);
    expect(flexKey(hide("nextMilestone"))).toEqual(["milestoneUpdate"]);
    expect(flexKey(hide("latestUpdate"))).toEqual(["milestoneUpdate"]);
  });

  it("hiding both moves the flexible role to People", () => {
    const cols = DashboardColumnModel.columns(hide(...BOTH_MU));
    expect(flexKey(hide(...BOTH_MU))).toEqual(["people"]);
    expect(DashboardColumnModel.minTableWidth(cols)).toBe(24 + 256 + 160 + 112 + 150);
  });

  it("People keeps the role with any one person line shown", () => {
    expect(flexKey(hide(...BOTH_MU, "owner", "physicianChampion"))).toEqual(["people"]);
  });

  it("with People hidden too, Project becomes flexible", () => {
    const v = hide(...BOTH_MU, ...ALL_PEOPLE);
    expect(flexKey(v)).toEqual(["project"]);
    expect(keys(v)).toEqual(["gutter", "project", "status", "dueFlags"]);
    expect(DashboardColumnModel.minTableWidth(DashboardColumnModel.columns(v))).toBe(24 + 200 + 112 + 150);
  });

  it("with only Project left, Project is flexible; exactly one flex column in every combination", () => {
    expect(flexKey(hide(...BOTH_MU, ...ALL_PEOPLE, "status", "due", "flags"))).toEqual(["project"]);
    const hideable = ["owner", "physicianChampion", "contractsLead", "status", "nextMilestone", "latestUpdate", "due", "flags"];
    for (let mask = 0; mask < 1 << hideable.length; mask++) {
      const v = hide(...hideable.filter((_, i) => mask & (1 << i)));
      const flex = flexKey(v);
      expect(flex).toHaveLength(1);
      const expected = DashboardColumnModel.FLEX_PREFERENCE.find((k) => keys(v).includes(k));
      expect(flex[0]).toBe(expected);
    }
  });

  it("the table renders the fallback: the flex col has only a min-width, the others a width", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardTable, {
        rows: [],
        completed: [],
        settings: hide(...BOTH_MU),
        selectedId: null,
        onSelect: () => {},
        today: TODAY,
        emptyText: "No projects yet.",
        renderMeta: () => null,
      }),
    );
    expect(html).toContain('data-col="people" style="min-width:160px"');
    expect(html).toContain('data-col="project" style="width:256px"');
    expect(html).not.toContain('data-col="milestoneUpdate"');
  });
});

describe("Show/hide groups", () => {
  it("the picker groups People, Next milestone / Latest update and Due / Flags, and keeps the report list flat", () => {
    const entries = DashboardColumnModel.pickerEntries("dashboard", dash());
    expect(entries.filter((e) => e.kind === "group")).toEqual([
      { kind: "group", stack: "people", label: "People", columns: ["owner", "physicianChampion", "contractsLead"] },
      { kind: "group", stack: "milestoneUpdate", label: "Next milestone / Latest update", columns: ["nextMilestone", "latestUpdate"] },
      { kind: "group", stack: "dueFlags", label: "Due / Flags", columns: ["due", "flags"] },
    ]);
    expect(ViewSettings.columnLabel("dashboard", "nextMilestone")).toBe("Next milestone");
    expect(ViewSettings.columnLabel("dashboard", "latestUpdate")).toBe("Latest update");
    expect(ViewSettings.columnLabel("dashboard", "due")).toBe("Due date");
    expect(ViewSettings.columnLabel("dashboard", "flags")).toBe("Flags");
    expect(DashboardColumnModel.pickerEntries("report", ViewSettings.defaults("report")).every((e) => e.kind === "column")).toBe(true);
  });

  it("moving a group moves all of its keys; report moves match withColumnMoved", () => {
    const d = dash();
    const entries = DashboardColumnModel.pickerEntries("dashboard", d);
    const from = entries.findIndex((e) => e.kind === "group" && e.stack === "people");
    const next = DashboardColumnModel.moveEntry("dashboard", d, from, entries.length - 1);
    expect(next.columnOrder.slice(-3)).toEqual(["owner", "physicianChampion", "contractsLead"]);
    expect(keys(next).at(-1)).toBe("people");
    const fromDue = entries.findIndex((e) => e.kind === "group" && e.stack === "dueFlags");
    const dueFirst = DashboardColumnModel.moveEntry("dashboard", d, fromDue, 1);
    expect(keys(dueFirst).slice(0, 3)).toEqual(["gutter", "project", "dueFlags"]);
    const r = ViewSettings.defaults("report");
    expect(DashboardColumnModel.moveEntry("report", r, 1, 4)).toEqual(ViewSettings.withColumnMoved("report", r, r.columnOrder[1], 4));
  });
});

describe("Old saved views still load", () => {
  it("a saved dashboard view that says note reads as Latest update (position and hidden state kept)", () => {
    const saved = {
      columnOrder: ["project", "note", "serviceArea", "owner", "physicianChampion", "status", "nextMilestone", "due", "flags", "inforNumber", "contractsLead"],
      hiddenColumns: ["note", "physicianChampion"],
      hiddenStatuses: ["Complete", "Cancelled"],
    };
    const v = ViewSettings.normalize("dashboard", saved);
    expect(v.columnOrder[1]).toBe("latestUpdate");
    expect(v.columnOrder).not.toContain("note");
    expect(v.hiddenColumns).toEqual(["latestUpdate", "physicianChampion"]);
    expect(DashboardColumnModel.milestoneUpdateVisibility(v)).toEqual({ milestone: true, update: false });
    expect(DashboardColumnModel.peopleVisibility(v)).toEqual({ owner: true, requester: false, contracts: true });
  });

  it("a saved view from before the note column existed gets Latest update visible by default", () => {
    const v = ViewSettings.normalize("dashboard", { columnOrder: ["project", "owner", "status"], hiddenColumns: [] });
    expect(v.columnOrder).toContain("latestUpdate");
    expect(DashboardColumnModel.milestoneUpdateVisibility(v).update).toBe(true);
    expect(ViewSettings.normalize("dashboard", {})).toEqual(ViewSettings.defaults("dashboard"));
  });

  it("a saved view that still lists or hides the department column loads quietly without it", () => {
    const saved = {
      columnOrder: ["project", "serviceArea", "owner", "physicianChampion", "status", "nextMilestone", "due", "note", "flags", "inforNumber", "contractsLead"],
      hiddenColumns: ["serviceArea", "flags"],
      hiddenStatuses: ["Complete", "Cancelled"],
    };
    const v = ViewSettings.normalize("dashboard", saved);
    expect(v.columnOrder).not.toContain("serviceArea");
    expect(v.hiddenColumns).toEqual(["flags"]);
    expect(keys(v)).toEqual(["gutter", "project", "people", "status", "milestoneUpdate", "dueFlags"]);
    expect(DashboardColumnModel.dueFlagsVisibility(v)).toEqual({ due: true, flags: false });
    expect(() => DashboardColumnModel.pickerEntries("dashboard", v)).not.toThrow();
    // The group header row still names the department and its count.
    const html = renderToStaticMarkup(
      createElement(DashboardTable, {
        rows: DashboardViewModel.rows([Factory.project({ name: "EP one", serviceArea: "EP" })], v, [], null, TODAY),
        completed: [],
        settings: v,
        selectedId: null,
        onSelect: () => {},
        today: TODAY,
        emptyText: "",
        renderMeta: () => null,
      }),
    );
    expect(html).toMatch(/data-testid="group-header".*>EP<\/span><span[^>]*>1 project<\/span>/);
    expect(html).not.toContain("area-tag");
  });

  it("the report context is unchanged: it keeps note and never offers latestUpdate", () => {
    const r = ViewSettings.normalize("report", { columnOrder: ["project", "note", "latestUpdate"], hiddenColumns: ["note"] });
    expect(r.columnOrder).toContain("note");
    expect(r.columnOrder).not.toContain("latestUpdate");
    expect(r.hiddenColumns).toEqual(["note"]);
    expect(ViewSettings.defaults("report").columnOrder).toEqual(["project", "owner", "physicianChampion", "status", "nextMilestone", "due", "flags", "note", "inforNumber", "contractsLead"]);
  });
});

describe("Grouped table markup", () => {
  const projects = [
    Factory.project({ name: "EP one", serviceArea: "EP", note: "EP note" }),
    Factory.project({ name: "Cath one", serviceArea: "Cath", owner: null }),
    Factory.project({ name: "No dept", serviceArea: null }),
  ];
  const render = (settings: ViewSettingsValue, completed: DashboardCompletedRow[] = []) =>
    renderToStaticMarkup(
      createElement(DashboardTable, {
        rows: dashRows(projects, settings),
        completed,
        settings,
        selectedId: null,
        onSelect: () => {},
        today: TODAY,
        emptyText: "No projects yet.",
        renderMeta: () => null,
      }),
    );

  it("one colgroup and header for every group, one tbody per department in PDF order, stable row keys", () => {
    const html = render(dash());
    expect(html.match(/<colgroup>/g)).toHaveLength(1);
    expect(html.match(/<thead>/g)).toHaveLength(1);
    expect([...html.matchAll(/data-area="([^"]+)"/g)].map((m) => m[1])).toEqual(["Cath", "EP", "Unassigned"]);
    expect([...html.matchAll(/data-row-key="([^"]+)"/g)].map((m) => m[1])).toEqual([projects[1].id, projects[0].id, projects[2].id]);
    expect(html).toContain('data-col="gutter" style="width:24px"');
    expect(html).toContain(">People</th>");
    expect(html).toContain(">Next milestone / Latest update</th>");
    expect(html).toContain(">Due / Flags</th>");
    expect(html).not.toContain(">Service area</th>");
    expect(html).toContain('data-col="milestoneUpdate" style="min-width:280px"');
    expect(html).toContain('data-col="dueFlags" style="width:150px"');
    expect(html).toContain('data-testid="milestone-update"');
    expect(html).toContain('data-testid="due-flags"');
    expect(html).toContain("py-[10px] align-top");
    expect(html.match(/data-testid="group-header"/g)).toHaveLength(3);
    expect(html).toContain(">1 project</span>");
  });

  it("hiding all three people fields removes the People column", () => {
    const html = render(dash({ hiddenColumns: ["owner", "physicianChampion", "contractsLead"] }));
    expect(html).not.toContain(">People</th>");
    expect(html).not.toContain('data-testid="people-cell"');
  });

  it("renders the completed block with the PDF copy, the teal date and the accomplishment", () => {
    const done: DashboardCompletedRow = { ...dashRows([Factory.project({ name: "Done Cath", serviceArea: "Cath", status: "Complete" })], dash({ hiddenStatuses: [] }))[0], accomplishment: "Opened lab 3", completedOn: "2026-09-20" };
    const html = render(dash(), [done]);
    expect(html).toContain(CompletedBlockCopy.HEADING);
    expect(html).toContain(CompletedBlockCopy.NOTE);
    expect(html).toContain("Sep 20");
    expect(html).toContain("Opened lab 3");
    expect(html).toContain('data-completed="true"');
    expect(html).toContain("1 project \u00b7 1 completed this period");
  });
});
