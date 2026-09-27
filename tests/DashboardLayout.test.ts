import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DashboardTable, DueFlagsCellView, MilestoneUpdateCell, PeopleCell } from "@/components/DashboardTable";
import { DashboardColumnModel } from "@/lib/dashboard/DashboardColumnModel";
import { DashboardGroups } from "@/lib/dashboard/DashboardGroups";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { PeopleStack } from "@/lib/dashboard/PeopleStack";
import { DueFlags, MilestoneUpdateStack } from "@/lib/dashboard/StackedCells";
import { FlagSlots } from "@/lib/domain/FlagSlots";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { ProjectRecord } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportGeometry, ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { Factory } from "./helpers/factories";

const TODAY = "2026-09-26";
const ALL = { owner: true, requester: true, contracts: true };
const dash = (raw: object = {}): ViewSettingsValue => ViewSettings.normalize("dashboard", raw);
const keys = (s: ViewSettingsValue) => DashboardColumnModel.columns(s).map((c) => c.key);

/** Minimal sortable row for DashboardGroups (report order needs status, due date and name). */
function g<T extends object>(over: T) {
  return { status: "OnTrack" as const, dueDate: null, name: "x", ...over };
}
function dashRows(projects: ProjectRecord[], settings = dash()): DashboardRow[] {
  return DashboardViewModel.rows(projects, settings, [], null, TODAY);
}

describe("Grouping matches the PDF", () => {
  it("same department sections, order, counts and row order as ReportLayout.layout on the sample report (the dashboard has no completed block)", () => {
    const input = SampleReportData.docInput({ completed: [] });
    const rows = input.rows.filter((r) => ViewSettings.isStatusVisible(input.viewSettings, r.status));
    const layout = ReportLayout.layout(input, new TextMeasure());
    const blocks = layout.pages.flatMap((p) => p.blocks);
    const pdfSections = blocks.flatMap((b) => (b.kind === "section" && !b.continued ? [b] : []));
    const groups = DashboardGroups.group(rows);
    expect(groups.map((g) => g.area)).toEqual(pdfSections.map((s) => s.area));
    expect(groups.map((g) => g.countText)).toEqual(pdfSections.map((s) => ReportLayout.sectionCountText(s.count, s.completedCount)));
    const pdfRowOrder = blocks.flatMap((b) => (b.kind === "row" ? [b.row.projectId] : []));
    expect(groups.flatMap((g) => g.rows.map((r) => r.projectId))).toEqual(pdfRowOrder);
  });

  it("departments in ServiceAreaInfo order with Unassigned last; empty departments are left out", () => {
    const rows = [
      g({ serviceArea: null, id: "u" }),
      g({ serviceArea: "IR" as const, id: "ir" }),
      g({ serviceArea: "CardioNeuro" as const, id: "cn" }),
      g({ serviceArea: "EP" as const, id: "ep" }),
      g({ serviceArea: "Cath" as const, id: "cath" }),
    ];
    const groups = DashboardGroups.group(rows);
    // The PDF order comes from ServiceAreaInfo.groups(): CardioNeuro before IR.
    expect(groups.map((g) => g.label)).toEqual(["Cath", "EP", "CardioNeuro", "IR", "Unassigned"]);
    expect(groups.map((g) => g.area)).toEqual(ServiceAreaInfo.groups().filter((a) => groups.some((g) => g.area === a)));
    expect(groups.find((g) => g.area === "Unassigned")?.muted).toBe(true);
    expect(groups.filter((g) => g.muted)).toHaveLength(1);
    expect(groups.some((g) => g.area === "Echo")).toBe(false);
  });

  it("Echo, CVSS and INU are real departments with their own headings, in ServiceAreaInfo order", () => {
    const rows = [
      g({ serviceArea: "INU" as const, id: "inu" }),
      g({ serviceArea: null, id: "none" }),
      g({ serviceArea: "Echo" as const, id: "echo" }),
      g({ serviceArea: "Cath" as const, id: "cath" }),
      g({ serviceArea: "CVSS" as const, id: "cvss" }),
    ];
    expect(DashboardGroups.group(rows).map((x) => x.label)).toEqual(["Cath", "Echo", "CVSS", "INU", "Unassigned"]);
  });

  it("a comparator sorts inside each group and never mixes groups", () => {
    const rows = [
      g({ serviceArea: "EP" as const, name: "b" }),
      g({ serviceArea: "Cath" as const, name: "z" }),
      g({ serviceArea: "EP" as const, name: "a" }),
      g({ serviceArea: "Cath" as const, name: "y" }),
    ];
    const groups = DashboardGroups.group(rows, (x, y) => x.name.localeCompare(y.name));
    expect(groups.map((g) => g.rows.map((r) => r.name))).toEqual([["y", "z"], ["a", "b"]]);
  });

  it("count text is the PDF section count text (no completed part)", () => {
    for (const n of [1, 2, 8]) expect(DashboardGroups.countText(n)).toBe(ReportLayout.sectionCountText(n, 0));
    expect(DashboardGroups.countText(8)).toBe("8 projects");
  });

});

describe("People cell display rules", () => {
  const texts = (row: Parameters<typeof PeopleStack.lines>[0], show = ALL) => PeopleStack.lines(row, show).map((l) => [l.kind, `${l.label} ${l.text}`, l.muted]);

  it("labeled Owner, Requester, Contracts lines in PDF order; blank reads To assign (muted)", () => {
    expect(texts({ owner: "Nick Leary", physicianChampion: "Dr. A", contractsLead: "Shea Waldron" })).toEqual([
      ["owner", "Owner: Nick Leary", false],
      ["requester", "Requester: Dr. A", false],
      ["contracts", "Contracts: Shea Waldron", false],
    ]);
    expect(texts({ owner: null, physicianChampion: " ", contractsLead: null })).toEqual([
      ["owner", "Owner: To assign", true],
      ["requester", "Requester: To assign", true],
      ["contracts", "Contracts: To assign", true],
    ]);
  });

  it("Not applicable drops the requester line; hidden fields drop their lines", () => {
    expect(texts({ owner: "O", physicianChampion: null, requesterNotApplicable: true, contractsLead: "C" }).map((t) => t[0])).toEqual(["owner", "contracts"]);
    expect(texts({ owner: "O", physicianChampion: "R", contractsLead: "C" }, { owner: false, requester: true, contracts: false }).map((t) => t[0])).toEqual(["requester"]);
    expect(PeopleStack.lines({ owner: "O", physicianChampion: "R" }, { owner: false, requester: false, contracts: false })).toEqual([]);
  });

  it("owner is primary (label 400, name 600); requester and contracts are 400 secondary; every line wraps at word boundaries, never truncated", () => {
    const html = renderToStaticMarkup(createElement(PeopleCell, { lines: PeopleStack.lines({ owner: "Owner A", physicianChampion: "Dr. Very Long Name", contractsLead: "Jeff Krause" }, ALL) }));
    expect(html).toContain('<span class="font-normal text-fg">Owner: </span>');
    expect(html).toContain('<span title="Owner A" class="font-semibold text-fg">Owner A</span>');
    expect(html).toContain('<span class="font-normal text-muted">Requester: </span>');
    expect(html).toContain('<span title="Dr. Very Long Name" class="font-normal text-muted">Dr. Very Long Name</span>');
    expect(html).toContain('<span class="font-normal text-muted">Contracts: </span>');
    expect(html).toContain('<span title="Jeff Krause" class="font-normal text-muted">Jeff Krause</span>');
    expect(html).not.toContain("font-medium");
    expect(html).not.toMatch(/truncate|ellipsis|whitespace-nowrap/);
    expect(html.match(/class="min-w-0 whitespace-normal break-words"/g)).toHaveLength(3);
  });

  it("an empty owner keeps the primary label with To assign in regular secondary gray, never amber", () => {
    const html = renderToStaticMarkup(createElement(PeopleCell, { lines: PeopleStack.lines({ owner: null, physicianChampion: null, contractsLead: null }, ALL) }));
    expect(html).toContain('<span class="font-normal text-fg">Owner: </span>');
    expect(html).toContain('<span title="To assign" class="font-normal text-muted">To assign</span>');
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
      { kind: "milestone", text: "Go live", progress: null, done: false },
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

  it("renders 13/18, milestone semibold primary 2-line clamp with a tooltip, update regular secondary unclamped with a 4px gap", () => {
    const html = renderToStaticMarkup(createElement(MilestoneUpdateCell, { lines: lines({ nextMilestone: "Go live", note: SampleReportData.LONG_NOTE, changed: false }) }));
    expect(html).toContain("text-[13px] leading-[18px]");
    expect(html).toContain("gap:4px");
    expect(html).toContain('data-line="milestone" title="Go live" class="line-clamp-2 break-words font-semibold text-fg"');
    expect(html).toContain('data-line="update" data-muted="true" class="break-words font-normal text-muted"');
    // A changed row's note is secondary too (milestone emphasis); only the prefix differs.
    const changed = renderToStaticMarkup(createElement(MilestoneUpdateCell, { lines: lines({ nextMilestone: "Go live", note: "Booked.", changed: true }) }));
    expect(changed).toContain('data-line="update" class="break-words font-normal text-muted">Booked.<');
    expect(MilestoneUpdateStack.MILESTONE_WEIGHT).toBe(600);
    expect(MilestoneUpdateStack.MILESTONE_WEIGHT).toBe(ReportGeometry.MILESTONE_WEIGHT);
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

  const COMBOS = Array.from({ length: 8 }, (_, i) => ({ changed: Boolean(i & 1), overdue: Boolean(i & 2), stale: Boolean(i & 4) }));
  const present = (c: ReturnType<typeof DueFlags.cell>) => (c.slots ?? []).filter((s) => s.flag).map((s) => s.flag!.kind);

  it("one shared canonical order: Changed, Overdue, Stale with the PDF labels", () => {
    expect(FlagSlots.ORDER).toEqual(["changed", "overdue", "stale"]);
    expect(FlagSlots.ORDER.map((k) => FlagSlots.label(k))).toEqual(["Changed", "! Overdue", "Stale"]);
    const c = DueFlags.cell(row({ changed: true, overdue: true, stale: true }), BOTH, TODAY);
    expect(c.slots!.map((s) => s.flag?.label)).toEqual(FlagSlots.ORDER.map((k) => ReportLayout.flag(new TextMeasure(), k).label));
  });

  it("dashboard grid: date and every flag keep their cell whichever flags apply (all 8 combinations)", () => {
    // Row 1: date | Overdue. Row 2: Changed | Stale. Slot index stays the canonical (PDF) order.
    const expected = { due: { row: 0, col: 0 }, overdue: { row: 0, col: 1 }, changed: { row: 1, col: 0 }, stale: { row: 1, col: 1 } };
    expect(DueFlags.GRID).toEqual(expected);
    for (const combo of COMBOS) {
      for (const dueDate of ["2026-09-30", null]) {
        const c = DueFlags.cell(row({ ...combo, dueDate }), BOTH, TODAY);
        expect(c.slots!.map((s) => [s.kind, s.slot, s.row, s.col])).toEqual(
          FlagSlots.ORDER.map((k) => [k, FlagSlots.index(k), expected[k].row, expected[k].col]),
        );
        for (const s of c.slots!) expect(s.flag?.kind ?? null).toBe(combo[s.kind] ? s.kind : null);
        expect(present(c)).toEqual(FlagSlots.present(combo));
        const html = renderToStaticMarkup(createElement(DueFlagsCellView, { cell: c }));
        // The date is always in row 1 column 1 (the muted en dash when blank).
        const dateText = dueDate ? "Sep 30" : "\u2013";
        expect(html).toMatch(new RegExp(`<span data-cell="due" class="flex" style="grid-row:1;grid-column:1"><span data-part="due"[^>]*>${dateText}</span></span>`));
        expect(html.match(/data-slot="/g)).toHaveLength(3);
        for (const k of FlagSlots.ORDER) {
          const p = expected[k];
          const slotHtml = html.match(
            new RegExp(`<span data-slot="${FlagSlots.index(k)}" data-slot-kind="${k}" class="flex" style="grid-row:${p.row + 1};grid-column:${p.col + 1}">(.*?)</span>(?=<span data-slot|</div>)`),
          );
          expect(slotHtml).not.toBeNull();
          expect(slotHtml![1].includes(`data-flag="${k}"`)).toBe(combo[k]);
        }
      }
    }
  });

  it("each part hides on its own", () => {
    const r = row({ changed: true });
    const flagsOnly = DueFlags.cell(r, { due: false, flags: true }, TODAY);
    expect(flagsOnly.due).toBeNull();
    expect(present(flagsOnly)).toEqual(["changed"]);
    expect(DueFlags.cell(r, { due: true, flags: false }, TODAY).slots).toBeNull();
    expect(DueFlags.cell(row(), { due: false, flags: true }, TODAY).slots).toHaveLength(3);
    expect(renderToStaticMarkup(createElement(DueFlagsCellView, { cell: { due: null, slots: null } }))).toBe("");
  });

  it("renders one fixed 2 x 2 grid (90px and 70px columns, 20px rows, 4px gaps); flags hidden leaves only the date", () => {
    const html = renderToStaticMarkup(createElement(DueFlagsCellView, { cell: DueFlags.cell(row({ overdue: true, changed: true }), BOTH, TODAY) }));
    expect(html).toContain('data-testid="due-flags" class="grid items-center text-[13px] leading-[18px]"');
    expect(html).toContain("grid-template-columns:90px 70px;grid-template-rows:repeat(2, 20px);column-gap:4px;row-gap:4px");
    expect(html).toContain('<span data-part="due" class="whitespace-nowrap font-semibold text-danger">Oct 2</span>');
    expect(html).toContain('class="flag fl-changed flex-none" data-flag="changed"');
    expect(html).toContain('class="flag fl-overdue flex-none" data-flag="overdue"');
    expect(html).not.toContain("flex-wrap");
    const blank = renderToStaticMarkup(createElement(DueFlagsCellView, { cell: DueFlags.cell(row({ dueDate: null }), BOTH, TODAY) }));
    expect(blank).toContain('class="whitespace-nowrap text-muted">\u2013<');
    expect(blank).not.toContain("data-flag");
    const dateOnly = renderToStaticMarkup(createElement(DueFlagsCellView, { cell: DueFlags.cell(row({ overdue: true }), { due: true, flags: false }, TODAY) }));
    expect(dateOnly).not.toContain("data-slot");
    expect(dateOnly).toContain(">Oct 2<");
  });

  it("the grid fits the Due / Flags column, the longest date and every pill; two 20px lines", () => {
    const spec = DashboardColumnModel.spec("dueFlags");
    expect(DueFlags.gridWidthPx()).toBe(164);
    expect(spec.width).toBe(188);
    expect(spec.minWidth - 24).toBeGreaterThanOrEqual(DueFlags.gridWidthPx());
    // Measured widths (px): dates at 13px weight 600, pills in the .flag style.
    const measured: Record<"due" | "changed" | "overdue" | "stale", number> = { due: 84.4, changed: 76.1, overdue: 65.8, stale: 54.8 };
    for (const k of ["due", "changed", "overdue", "stale"] as const) expect(DueFlags.COLUMN_WIDTHS_PX[DueFlags.position(k).col]).toBeGreaterThanOrEqual(measured[k]);
    expect(DueFlags.gridHeightPx()).toBe(44);
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
      if (flags?.kind === "flags") {
        const dash = (cell.slots ?? []).filter((x) => x.flag).map((x) => [x.flag!.kind, x.flag!.label, x.slot]);
        expect(dash).toEqual(flags.flags.map((f) => [f.kind, f.label, f.slot]));
      }
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
    expect(DashboardColumnModel.spec("dueFlags")).toMatchObject({ header: "Due / Flags", width: 188, minWidth: 188, flex: false });
    expect(DashboardColumnModel.spec("people")).toMatchObject({ header: "People", width: 200, minWidth: 160 });
    expect(DashboardColumnModel.spec("gutter")).toMatchObject({ width: 24, structural: true });
    expect(DashboardColumnModel.minTableWidth(cols)).toBe(24 + 256 + 200 + 112 + 280 + 188);
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
    expect(DashboardColumnModel.minTableWidth(cols)).toBe(24 + 256 + 160 + 112 + 188);
  });

  it("People keeps the role with any one person line shown", () => {
    expect(flexKey(hide(...BOTH_MU, "owner", "physicianChampion"))).toEqual(["people"]);
  });

  it("with People hidden too, Project becomes flexible", () => {
    const v = hide(...BOTH_MU, ...ALL_PEOPLE);
    expect(flexKey(v)).toEqual(["project"]);
    expect(keys(v)).toEqual(["gutter", "project", "status", "dueFlags"]);
    expect(DashboardColumnModel.minTableWidth(DashboardColumnModel.columns(v))).toBe(24 + 200 + 112 + 188);
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
  const render = (settings: ViewSettingsValue) =>
    renderToStaticMarkup(
      createElement(DashboardTable, {
        rows: dashRows(projects, settings),
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
    expect(html).toContain(">People</span></th>");
    expect(html).toContain(">Next milestone / Latest update</span></th>");
    expect(html).toContain(">Due / Flags</span></th>");
    expect(html).not.toContain(">Service area</span></th>");
    expect(html).toContain('data-col="milestoneUpdate" style="min-width:280px"');
    expect(html).toContain('data-col="dueFlags" style="width:188px"');
    expect(html).toContain('data-testid="milestone-update"');
    expect(html).toContain('data-testid="due-flags"');
    expect(html).toContain("py-[10px] align-top");
    expect(html.match(/data-testid="group-header"/g)).toHaveLength(3);
    expect(html).toContain(">1 project</span>");
  });

  it("hiding all three people fields removes the People column", () => {
    const html = render(dash({ hiddenColumns: ["owner", "physicianChampion", "contractsLead"] }));
    expect(html).not.toContain(">People</span></th>");
    expect(html).not.toContain('data-testid="people-cell"');
  });
});
