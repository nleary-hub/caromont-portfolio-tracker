import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardTable, LatestUpdateCell, PeopleCell } from "@/components/DashboardTable";
import { DashboardColumnModel } from "@/lib/dashboard/DashboardColumnModel";
import { CompletedBlockCopy, DashboardGroups } from "@/lib/dashboard/DashboardGroups";
import { DashboardViewModel, type DashboardCompletedRow, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { PeopleStack } from "@/lib/dashboard/PeopleStack";
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

describe("Latest update", () => {
  it("is the current note, whitespace collapsed, null when blank", () => {
    expect(LatestUpdate.text({ note: "  Vendor  install\n booked. " })).toBe("Vendor install booked.");
    expect(LatestUpdate.text({ note: "   " })).toBeNull();
    expect(LatestUpdate.text({ note: null })).toBeNull();
  });

  it("clamps to 3 lines with the full text as a tooltip and on focus; blank shows the empty glyph", () => {
    expect(LatestUpdate.EMPTY_NOTE_GLYPH).toBe("\u2014");
    expect(LatestUpdate.CLAMP_LINES).toBe(3);
    const html = renderToStaticMarkup(createElement(LatestUpdateCell, { note: SampleReportData.LONG_NOTE }));
    expect(html).toContain("line-clamp-3");
    expect(html).toContain("focus:line-clamp-none");
    expect(html).toContain('tabindex="0"');
    expect(html).toContain(`title="${SampleReportData.LONG_NOTE.replace(/\s+/g, " ").trim()}"`);
    expect(renderToStaticMarkup(createElement(LatestUpdateCell, { note: null }))).toContain(">\u2014<");
  });
});

describe("Column model and show/hide", () => {
  it("default: gutter, Project, then the saved order with People and Latest update (the one flex column)", () => {
    expect(keys(dash())).toEqual(["gutter", "project", "serviceArea", "people", "status", "nextMilestone", "due", "latestUpdate", "flags"]);
    const cols = DashboardColumnModel.columns(dash());
    expect(cols.filter((c) => c.flex).map((c) => c.key)).toEqual(["latestUpdate"]);
    expect(DashboardColumnModel.spec("people")).toMatchObject({ header: "People", width: 200, minWidth: 160 });
    expect(DashboardColumnModel.spec("latestUpdate")).toMatchObject({ header: "Latest update", minWidth: 240, flex: true });
    expect(DashboardColumnModel.spec("gutter")).toMatchObject({ width: 24, structural: true });
    expect(DashboardColumnModel.minTableWidth(cols)).toBe(24 + 256 + 120 + 200 + 112 + 170 + 84 + 240 + 176);
  });

  it("each people field hides on its own; People goes away only when all three are hidden", () => {
    const hide = (...h: string[]) => dash({ hiddenColumns: h });
    expect(DashboardColumnModel.peopleVisibility(hide("owner"))).toEqual({ owner: false, requester: true, contracts: true });
    expect(keys(hide("owner", "physicianChampion"))).toContain("people");
    expect(DashboardColumnModel.peopleVisibility(hide("owner", "physicianChampion"))).toEqual({ owner: false, requester: false, contracts: true });
    expect(keys(hide("owner", "physicianChampion", "contractsLead"))).not.toContain("people");
    expect(keys(hide("latestUpdate"))).not.toContain("latestUpdate");
    expect(keys(hide("latestUpdate", "owner"))).toEqual(["gutter", "project", "serviceArea", "people", "status", "nextMilestone", "due", "flags"]);
    // Only the contracts lead left (it sits last in the order): People stays where Owner was.
    expect(keys(hide("owner", "physicianChampion")).indexOf("people")).toBe(3);
  });

  it("People follows the first people key in the saved order; Project stays first", () => {
    const moved = dash({ columnOrder: ["status", "owner", "project", "physicianChampion"] });
    expect(keys(moved).slice(0, 4)).toEqual(["gutter", "project", "status", "people"]);
  });

  it("the picker groups the dashboard people keys under People and keeps the report list flat", () => {
    const entries = DashboardColumnModel.pickerEntries("dashboard", dash());
    const people = entries.filter((e) => e.kind === "people");
    expect(people).toEqual([{ kind: "people", label: "People", columns: ["owner", "physicianChampion", "contractsLead"] }]);
    expect(entries.some((e) => e.kind === "column" && e.column === "latestUpdate")).toBe(true);
    expect(DashboardColumnModel.pickerEntries("report", ViewSettings.defaults("report")).every((e) => e.kind === "column")).toBe(true);
  });

  it("moving the People entry moves all three keys; report moves match withColumnMoved", () => {
    const d = dash();
    const entries = DashboardColumnModel.pickerEntries("dashboard", d);
    const from = entries.findIndex((e) => e.kind === "people");
    const next = DashboardColumnModel.moveEntry("dashboard", d, from, entries.length - 1);
    expect(next.columnOrder.slice(-3)).toEqual(["owner", "physicianChampion", "contractsLead"]);
    expect(keys(next).at(-1)).toBe("people");
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
    expect(keys(v)).not.toContain("latestUpdate");
    expect(DashboardColumnModel.peopleVisibility(v)).toEqual({ owner: true, requester: false, contracts: true });
  });

  it("a saved view from before the note column existed gets Latest update visible by default", () => {
    const v = ViewSettings.normalize("dashboard", { columnOrder: ["project", "owner", "status"], hiddenColumns: [] });
    expect(v.columnOrder).toContain("latestUpdate");
    expect(keys(v)).toContain("latestUpdate");
    expect(ViewSettings.normalize("dashboard", {})).toEqual(ViewSettings.defaults("dashboard"));
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
    expect(html).toContain(">Latest update</th>");
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
