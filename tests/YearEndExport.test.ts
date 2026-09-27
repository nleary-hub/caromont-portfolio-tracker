import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { CompletedBlockStyle, ReportGeometry } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { YearEndLayout, type YearEndBlock } from "@/lib/report/pdf/YearEndLayout";
import { YearEndRenderer } from "@/lib/report/YearEndRenderer";
import { YearEndCategories, YearEndCopy, YearEndReportData, type YearEndCategory, type YearEndData } from "@/lib/report/YearEndReportData";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ClosedProjects } from "@/lib/report/ClosedProjects";
import { YearEndReportService } from "@/lib/services/YearEndReportService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Year-end export: wider Final update column that wraps in full, completed rows tinted like the weekly report, and
// the summary grid and header totals (Carried in from FY N-1, Completed FY N, Carried into FY N+1 or Still in
// progress), all relative to the report's FY.
type P = ProjectRecord & { createdAt: Date; accomplishment?: string | null };
const CVPSL = ServiceAreaInfo.CVPSL;
const AT = new Date("2026-09-27T16:00:00Z");
const p = (o: Omit<Partial<P>, "completedOn"> & { completedOn?: string } = {}): P => {
  const { completedOn, ...rest } = o;
  return { ...Factory.project(), createdAt: new Date("2025-03-01T15:00:00Z"), ...rest, completedOn: completedOn ? Factory.date(completedOn) : null } as P;
};
const status = (projectId: string, iso: string, oldValue: string, newValue: string): HistoryEntryRecord => ({ projectId, changedAt: new Date(iso), field: "status", oldValue, newValue });
const build = (projects: P[], history: HistoryEntryRecord[], fiscalYear: string, today = "2026-09-27", categories?: YearEndCategory[]) =>
  YearEndReportData.build({ projects, history, fiscalYear, today, departments: CVPSL, serviceLineName: "Cardiovascular & Pulmonary Service Line", categories });
const IN = "Carried in includes projects later closed without being completed.";
const OTHER = (fy: string) => `The other columns include projects started in ${fy}.`;
const THESE = (fy: string) => `These totals include projects started in ${fy}.`;
const BOTH = (fy: string) => `${IN} ${OTHER(fy)}`;
const OVERLAP = "A project can be counted in more than one column.";
const MERGED = "Tracking started Sep 26, 2026, so Carried in from FY25 and Carried into FY27 aren't available.";
const LONG = "Go-live finished on schedule across all four cath labs. Hemodynamic monitoring now feeds Epic directly, which removed the double charting step for nurses. Staff trained on every shift before cutover.";

describe("summary grid and header totals: the same columns in the same order", () => {
  const D = ServiceAreaInfo.CVPSL_IDS;
  /** Data tracked since Mar 2025, so both FY26 boundaries (Jun 30, 2025 and Jun 30, 2026) can be rebuilt. */
  const world = () => {
    const openAll = p({ name: "Open all along", serviceArea: D.Cath, status: "OnTrack" });
    const doneFy26 = p({ name: "Done in FY26", serviceArea: D.Cath, status: "Complete", completedOn: "2026-02-01" });
    const doneFy27 = p({ name: "Done in FY27", serviceArea: D.Echo, status: "Complete", completedOn: "2026-08-15" });
    const newFy26 = p({ name: "Started in FY26", serviceArea: D.IR, status: "AtRisk", createdAt: new Date("2025-10-01T15:00:00Z") });
    const cancelledFy26 = p({ name: "Cancelled in FY26", serviceArea: D.EP, status: "Cancelled" });
    const closedFy25 = p({ name: "Done in FY25", serviceArea: D.Cath, status: "Complete", completedOn: "2025-05-01" });
    // Reopened: Complete on Jun 1, 2026, back to OnTrack in Aug 2026: closed at the FY26 end, open now.
    const reopened = p({ name: "Reopened", serviceArea: D.Echo, status: "OnTrack" });
    const newFy27 = p({ name: "Started in FY27", serviceArea: D.IR, status: "NotStarted", createdAt: new Date("2026-09-10T15:00:00Z") });
    // A status change in FY27 (openAll to OnHold) doesn't change the closed FY26 figures.
    const history = [
      status(cancelledFy26.id, "2026-01-10T15:00:00Z", "OnHold", "Cancelled"),
      status(doneFy27.id, "2026-08-15T15:00:00Z", "OnTrack", "Complete"),
      status(reopened.id, "2026-06-01T15:00:00Z", "OnTrack", "Complete"),
      status(reopened.id, "2026-08-02T15:00:00Z", "Complete", "OnTrack"),
      status(openAll.id, "2026-09-01T15:00:00Z", "OnTrack", "OnHold"),
    ];
    return { list: [openAll, doneFy26, doneFy27, newFy26, cancelledFy26, closedFy25, reopened, newFy27], history };
  };
  const bandLabels = (l: ReturnType<typeof YearEndLayout.layout>) => l.band.details.map((x) => [x.label.toUpperCase(), x.value]);
  const grid = (d: YearEndData) => d.summary.map((r) => [r.label, ...d.columns.map((k) => r[k])]);
  /** Header totals after Period must be the grid's heads and Total row, in the same order. */
  const kindOf = { carriedIn: "carriedIn", completed: "completed", openAtEnd: "carried" } as const;
  // Sections are the selected categories in column order; each section's rows per department equal its grid column
  // (a project in two categories is listed in both); rows match the all-three report's section of the same kind.
  const sectionsMatchGrid = (d: YearEndData, c: YearEndCategory[], all: YearEndData, list: P[]) => {
    expect(d.sections.map((s) => s.kind)).toEqual(c.map((x) => kindOf[x]));
    expect(d.columns).toEqual(c);
    for (const [i, x] of c.entries()) {
      const s = d.sections[i];
      // Same rows as the all-three report; only the update text of a carried Complete row depends on the selection.
      const bare = (x: YearEndData["sections"][number]) => ({ ...x, groups: x.groups.map((g) => ({ ...g, rows: g.rows.map((r) => ({ ...r, finalUpdate: null })) })) });
      expect(bare(s)).toEqual(bare(all.sections.find((a) => a.kind === s.kind)!));
      // Pointer only when Completed is included and the project is listed there; otherwise the full final update.
      const done = new Map((d.sections.find((a) => a.kind === "completed")?.groups ?? []).flatMap((g) => g.rows.map((r) => [r.projectId, r.date!] as const)));
      if (s.kind !== "completed") for (const r of s.groups.flatMap((g) => g.rows)) if (r.status === "Complete" && !r.statusUnknown) {
        const heading = YearEndCopy.completedIn(d.fiscalYear);
        expect(r.finalUpdate).toBe(done.has(r.projectId) ? YearEndCopy.seeCompleted(done.get(r.projectId)!, heading) : ClosedProjects.finalUpdate({ ...list.find((x) => x.id === r.projectId)!, status: "Complete" }));
      }
      for (const r of d.summary) {
        const n = r.area === "total" ? s.groups.reduce((t, g) => t + g.rows.length, 0) : (s.groups.find((g) => g.label === r.label)?.rows.length ?? 0);
        expect(r[x], `${d.title} ${c.join("+")} ${x} ${r.label}`).toBe(n);
      }
      // Every listed department has a grid row.
      for (const g of s.groups) expect(d.summary.map((r) => r.label)).toContain(g.label);
    }
  };
  const aligned = (d: YearEndData) => {
    const l = YearEndLayout.layout(d, AT, "Nick Leary");
    const total = d.summary.at(-1)!;
    expect(bandLabels(l).slice(1)).toEqual(l.summaryKeys.map((k, i) => [l.summaryHeads[i].toUpperCase(), total[k] === null ? YearEndCopy.EMPTY_VALUE : String(total[k])]));
    return l;
  };

  it("closed year (FY26): Carried in from FY25 | Completed FY26 | Carried into FY27, header aligned, values as of Jun 30, 2025 and Jun 30, 2026", () => {
    const { list, history } = world();
    const d = build(list, history, "FY26");
    const layout = aligned(d);
    expect(d.title).toBe("FY26 Year-End Report");
    expect(layout.summaryHeads).toEqual(["Carried in from FY25", "Completed FY26", "Carried into FY27"]);
    // In (open at the end of Jun 30, 2025): Open all along, Done in FY26, Done in FY27, Cancelled in FY26, Reopened.
    // Into FY27 (open at the end of Jun 30, 2026): Open all along, Done in FY27, Started in FY26 (Reopened was Complete then).
    expect(grid(d)).toEqual([
      ["Cath", 2, 1, 1],
      ["EP", 1, 0, 0],
      ["Echo", 2, 0, 1],
      ["IR", 0, 0, 1],
      ["Total", 5, 1, 3],
    ]);
    expect(bandLabels(layout)[0]).toEqual(["PERIOD", d.periodText]);
    expect([d.carriedInNote, d.openAtEndNote]).toEqual([null, null]);
    expect(layout.summaryNotes).toEqual([BOTH("FY26"), OVERLAP]);
    expect(d.sections.map((s) => s.heading)).toEqual(["Carried in from FY25", "Completed in FY26", "Carried into FY27"]);
    expect(d.sections[2].groups.flatMap((g) => g.rows.map((r) => [r.name, r.status, r.statusUnknown ?? false]))).toEqual([
      ["Open all along", "OnTrack", false],
      ["Done in FY27", "OnTrack", false],
      ["Started in FY26", "AtRisk", false],
    ]);
    expect(JSON.stringify(layout)).not.toMatch(/FY28/i);
    // No Cancelled section or column. Carried in lists the projects open on Jun 30, 2025 with their status on Jun 30,
    // 2026, so the one later cancelled shows that status there (it's in the Carried in count).
    expect(JSON.stringify([layout.summaryHeads, layout.summaryNotes, d.sections.slice(1)])).not.toMatch(/cancel/i);
    expect(d.sections[0].groups.flatMap((g) => g.rows.map((r) => [r.name, r.status, r.statusUnknown ?? false]))).toEqual([
      ["Done in FY26", "Complete", false],
      ["Open all along", "OnTrack", false],
      ["Cancelled in FY26", "Cancelled", false],
      ["Done in FY27", "OnTrack", false],
      ["Reopened", "Complete", false],
    ]);
    // A closed year is a snapshot: the same figures whenever it's run.
    expect(build(list, history, "FY26", "2027-03-01").totals).toMatchObject({ carriedIn: 5, openAtEnd: 3, completed: 1 });
  });

  it("current year (FY27, a Mid-Year Report): Carried in from FY26 | Completed FY27 | Still in progress, header aligned, no FY28 text", () => {
    const { list, history } = world();
    const d = build(list, history, "FY27");
    const layout = aligned(d);
    expect(d.title).toBe("FY27 Mid-Year Report");
    expect(layout.footerLeft).toBe("Generated Sep 27, 2026 by Nick Leary \u00b7 FY27 Mid-Year Report");
    expect(layout.summaryHeads).toEqual(["Carried in from FY26", "Completed FY27", "Still in progress"]);
    // Still in progress = open today: Open all along (OnHold), Started in FY26, Reopened, Started in FY27.
    expect(grid(d)).toEqual([
      ["Cath", 1, 0, 1],
      ["Echo", 1, 1, 1],
      ["IR", 1, 0, 2],
      ["Total", 3, 1, 4],
    ]);
    expect(d.sections.map((s) => s.heading)).toEqual(["Carried in from FY26", "Completed in FY27", "Still in progress"]);
    // Carried in from FY26 (open at the end of Jun 30, 2026) shows each project's status today: Done in FY27 is
    // Complete (and also listed under Completed); Reopened is back to OnTrack.
    expect(d.sections[0].groups.flatMap((g) => g.rows.map((r) => [r.name, r.status]))).toEqual([
      ["Open all along", "OnHold"],
      ["Done in FY27", "Complete"],
      ["Started in FY26", "AtRisk"],
    ]);
    // Overlap: Done in FY27 is in both Carried in and Completed; only the Completed row is shaded.
    const shaded = layout.pages.flatMap((pg) => pg.blocks).filter((b): b is Extract<YearEndBlock, { kind: "row" }> => b.kind === "row" && b.row.name[0] === "Done in FY27").map((b) => b.row.shaded);
    expect(shaded).toEqual([false, true]);
    expect(layout.summaryNotes).toEqual([BOTH("FY27"), OVERLAP]);
    expect(JSON.stringify(layout)).not.toMatch(/cancel|FY28/i);
    expect(build([p({ name: "Done", status: "Complete", completedOn: "2026-08-01" })], [], "FY27").sections[2].emptyText).toBe("No projects are still in progress.");
    expect(build([], [], "FY27").sections[1].emptyText).toBe("No projects completed in FY27 so far.");
    expect(build([p({ name: "Old", status: "OnTrack", createdAt: new Date("2024-01-01T12:00:00Z") })], [], "FY25").sections[2].emptyText).toBe("No projects carried into FY26.");
  });

  it("FY N 'Carried into FY N+1' equals FY N+1 'Carried in from FY N', in total and per department (one shared computation)", () => {
    const { list, history } = world();
    // Extra cases around the Jul 1 boundary: closed on Jun 30 (not carried), closed on Jul 1 (carried), cancelled
    // on Jul 2 (carried: open at the end of Jun 30), created on Jul 1 (not carried), unknown status then.
    const edge = [
      p({ name: "Done Jun 30", serviceArea: D.EP, status: "Complete", completedOn: "2026-06-30" }),
      p({ name: "Done Jul 1", serviceArea: D.EP, status: "Complete", completedOn: "2026-07-01" }),
      p({ name: "Cancelled Jul 2", serviceArea: D.INU, status: "Cancelled" }),
      p({ name: "Created Jul 1", serviceArea: D.CVSS, status: "OnTrack", createdAt: new Date("2026-07-01T14:00:00Z") }),
      p({ name: "Unassigned open", serviceArea: null, status: "OnTrack" }),
    ];
    const h = [...history, status(edge[2].id, "2026-07-02T15:00:00Z", "OnTrack", "Cancelled")];
    const all = [...list, ...edge];
    for (const [fy, next] of [["FY26", "FY27"], ["FY25", "FY26"]] as const) {
      const a = build(all, h, fy);
      const b = build(all, h, next);
      const out = Object.fromEntries(a.summary.map((r) => [r.label, r.openAtEnd]));
      const inn = Object.fromEntries(b.summary.map((r) => [r.label, r.carriedIn]));
      for (const label of new Set([...Object.keys(out), ...Object.keys(inn)])) expect([label, out[label] ?? 0]).toEqual([label, inn[label] ?? 0]);
      expect(a.totals.openAtEnd).toBe(b.totals.carriedIn);
    }
    expect(build(all, h, "FY26").summary.map((r) => [r.label, r.openAtEnd])).toEqual([
      ["Cath", 1],
      ["EP", 1],
      ["Echo", 1],
      ["INU", 1],
      ["IR", 1],
      ["Unassigned", 1],
      ["Total", 6],
    ]);
  });

  it("department order is the weekly report's (the line's department list): Cath, EP, Echo, CVSS, INU, CardioNeuro, IR, Unassigned last; empty departments are left out, as in the weekly", () => {
    expect(CVPSL.map((x) => x.shortName)).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    const keys = ["IR", "CardioNeuro", "INU", "CVSS", "Echo", "EP", "Cath"];
    const list = [p({ name: "No dept", serviceArea: null, status: "OnTrack" }), ...keys.flatMap((k) => [p({ name: `${k} done`, serviceArea: D[k], status: "Complete", completedOn: "2026-08-01" }), p({ name: `${k} open`, serviceArea: D[k], status: "OnTrack" })])];
    const d = build(list, [], "FY27");
    const order = ["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"];
    expect(d.summary.map((r) => r.label)).toEqual([...order, "Unassigned", "Total"]);
    expect(d.sections[1].groups.map((g) => g.label)).toEqual(order);
    expect(d.sections[2].groups.map((g) => g.label)).toEqual([...order, "Unassigned"]);
    const few = build([p({ name: "IR only", serviceArea: D.IR, status: "OnTrack" }), p({ name: "Cath only", serviceArea: D.Cath, status: "Complete", completedOn: "2026-08-01" })], [], "FY27");
    expect(few.summary.map((r) => r.label)).toEqual(["Cath", "IR", "Total"]);
  });

  it("a boundary before tracking began is a dash (header and grid) with 'Tracking started …' under the Total row, never a false 0", () => {
    // Production today: every project was created (imported) on Sep 26, 2026, and history starts then.
    const imported = new Date("2026-09-26T14:00:00Z");
    const list = [p({ name: "Imported open", serviceArea: D.Cath, status: "OnTrack", createdAt: imported }), p({ name: "Imported done", serviceArea: D.Echo, status: "Complete", completedOn: "2026-08-01", createdAt: imported })];
    const fy27 = build(list, [], "FY27");
    expect(fy27.summary.at(-1)).toMatchObject({ carriedIn: null, completed: 1, openAtEnd: 1 });
    expect(fy27.carriedInNote).toBe("Tracking started Sep 26, 2026, so Carried in from FY26 isn't available.");
    expect(fy27.openAtEndNote).toBeNull();
    expect(bandLabels(aligned(fy27)).slice(1)).toEqual([["CARRIED IN FROM FY26", YearEndCopy.EMPTY_VALUE], ["COMPLETED FY27", "1"], ["STILL IN PROGRESS", "1"]]);
    const fy26 = build(list, [], "FY26");
    expect(fy26.summary.at(-1)).toMatchObject({ carriedIn: null, completed: 0, openAtEnd: null });
    expect(fy26.openAtEndNote).toBe("Tracking started Sep 26, 2026, so Carried into FY27 isn't available.");
    expect(fy26.sections[2].emptyText).toBe("Tracking started Sep 26, 2026, so this list isn't available.");
    // The Carried in section follows its dashed total: no rows, the same tracking text (both years).
    for (const d of [fy26, fy27]) expect([d.sections[0].kind, d.sections[0].count, d.sections[0].groups, d.sections[0].emptyText]).toEqual(["carriedIn", 0, [], "Tracking started Sep 26, 2026, so this list isn't available."]);
    const layout = aligned(fy26);
    // Both carried columns dashed: one merged tracking line; no Carried in sentence (no real number).
    expect(layout.summaryNotes).toEqual([MERGED, OTHER("FY26"), OVERLAP]);
    const summary = layout.pages[0].blocks[0];
    expect(summary.height).toBe(YearEndLayout.SUMMARY_LABEL_H + YearEndLayout.GRID.headH + layout.summary.length * YearEndLayout.GRID.rowH + 3 + 3 * YearEndLayout.SUMMARY_NOTE_H);
    // FY26's Carried in from FY25 (boundary Jun 30, 2025) is a dash whenever tracking started after it.
    const tracked2025 = build([p({ name: "Old", serviceArea: D.Cath, status: "OnTrack", createdAt: new Date("2025-08-01T12:00:00Z") })], [], "FY26");
    expect(tracked2025.summary.at(-1)!.carriedIn).toBeNull();
    expect(tracked2025.carriedInNote).toBe("Tracking started Aug 1, 2025, so Carried in from FY25 isn't available.");
  });

  it("production-like data (everything created Sep 26, 2026, no earlier history): both reports read the same real tracking start", () => {
    const imported = new Date("2026-09-26T14:00:00Z");
    const list = [
      p({ name: "Imported open", serviceArea: D.Cath, status: "OnTrack", createdAt: imported }),
      p({ name: "Imported at risk", serviceArea: D.EP, status: "AtRisk", createdAt: imported }),
      p({ name: "Imported done FY27", serviceArea: D.Echo, status: "Complete", completedOn: "2026-08-01", createdAt: imported }),
      p({ name: "Imported done FY26", serviceArea: D.Cath, status: "Complete", completedOn: "2026-03-01", createdAt: imported }),
    ];
    // The import's history ("created" entries) is stamped on the import day too.
    const history = list.map((x) => ({ projectId: x.id, changedAt: new Date("2026-09-26T14:00:05Z"), field: "created", oldValue: null, newValue: x.status }));
    expect(YearEndReportData.trackedSince(list, history)).toBe("2026-09-26");
    const fy26 = build(list, history, "FY26");
    expect(fy26.summary.at(-1)).toMatchObject({ carriedIn: null, completed: 1, openAtEnd: null });
    const l26 = aligned(fy26);
    expect(bandLabels(l26).slice(1)).toEqual([["CARRIED IN FROM FY25", YearEndCopy.EMPTY_VALUE], ["COMPLETED FY26", "1"], ["CARRIED INTO FY27", YearEndCopy.EMPTY_VALUE]]);
    expect(l26.summaryNotes).toEqual([MERGED, OTHER("FY26"), OVERLAP]);
    expect(fy26.sections[2].emptyText).toBe("Tracking started Sep 26, 2026, so this list isn't available.");
    const fy27 = build(list, history, "FY27");
    expect(fy27.summary.at(-1)).toMatchObject({ carriedIn: null, completed: 1, openAtEnd: 2 });
    const l27 = aligned(fy27);
    expect(bandLabels(l27).slice(1)).toEqual([["CARRIED IN FROM FY26", YearEndCopy.EMPTY_VALUE], ["COMPLETED FY27", "1"], ["STILL IN PROGRESS", "2"]]);
    expect(l27.summaryNotes).toEqual(["Tracking started Sep 26, 2026, so Carried in from FY26 isn't available.", OTHER("FY27"), OVERLAP]);
    // One source for both: build() computes the tracking start once from the same inputs the service loads.
    const src = readFileSync("src/lib/report/YearEndReportData.ts", "utf8");
    expect(src.match(/YearEndReportData\.trackedSince\(/g)).toHaveLength(1);
  });

  it("current-year categories: every one of the 7 combinations shows exactly the selected sections and totals, in order; each section's rows per department equal its grid column", () => {
    const { list, history } = world();
    const all = build(list, history, "FY27");
    const label = { carriedIn: "Carried in from FY26", completed: "Completed FY27", openAtEnd: "Still in progress" } as const;
    const key = { carriedIn: "carriedIn", completed: "completed", openAtEnd: "openAtEnd" } as const;
    const combos: YearEndCategory[][] = [["carriedIn"], ["completed"], ["openAtEnd"], ["carriedIn", "completed"], ["carriedIn", "openAtEnd"], ["completed", "openAtEnd"], ["carriedIn", "completed", "openAtEnd"]];
    const notes = new Map<string, string>();
    for (const c of combos) {
      const d = build(list, history, "FY27", undefined, [...c].reverse());
      const l = aligned(d);
      expect(l.summaryHeads).toEqual(c.map((x) => label[x]));
      expect(bandLabels(l).length).toBe(1 + c.length);
      // Per-department values are the same numbers as the all-three report, only for the selected columns;
      // the Total row sums each selected column (no cross-column sum: the categories overlap).
      // Rows: departments with a project in a shown column.
      expect(d.summary.map((r) => [r.label, ...c.map((x) => r[key[x]])])).toEqual(all.summary.filter((r) => r.area === "total" || c.some((x) => (r[key[x]] ?? 0) > 0)).map((r) => [r.label, ...c.map((x) => r[key[x]])]));
      expect(l.summary.at(-1)).toMatchObject({ label: "Total" });
      // One section per selected category, in column order; each lists the same rows as in the all-three report,
      // and its row count per department equals its grid column. The grid note has only the shown columns' sentences.
      sectionsMatchGrid(d, c, all, list);
      const expected = [c.includes("carriedIn") ? IN : null, c.some((x) => x !== "carriedIn") ? (c.includes("carriedIn") ? OTHER("FY27") : THESE("FY27")) : null].filter(Boolean).join(" ");
      // The overlap line comes last, only with two or more columns.
      expect(l.summaryNotes).toEqual(c.length >= 2 ? [expected, OVERLAP] : [expected]);
      notes.set(c.join("+"), l.summaryNotes.join(" | "));
    }
    expect(Object.fromEntries(notes)).toEqual({
      carriedIn: IN,
      completed: THESE("FY27"),
      openAtEnd: THESE("FY27"),
      "carriedIn+completed": `${BOTH("FY27")} | ${OVERLAP}`,
      "carriedIn+openAtEnd": `${BOTH("FY27")} | ${OVERLAP}`,
      "completed+openAtEnd": `${THESE("FY27")} | ${OVERLAP}`,
      "carriedIn+completed+openAtEnd": `${BOTH("FY27")} | ${OVERLAP}`,
    });
    expect(grid(build(list, history, "FY27", undefined, ["completed"]))).toEqual([["Echo", 1], ["Total", 1]]);
    expect(grid(build(list, history, "FY27", undefined, ["carriedIn", "openAtEnd"]))).toEqual([["Cath", 1, 1], ["Echo", 1, 1], ["IR", 1, 2], ["Total", 3, 4]]);
    // Default (missing) = all three.
    expect(all.columns).toEqual(["carriedIn", "completed", "openAtEnd"]);
    // A dash note appears only when its column is shown.
    const imported = [p({ name: "Imported", serviceArea: D.Cath, status: "OnTrack", createdAt: new Date("2026-09-26T14:00:00Z") })];
    expect(YearEndLayout.layout(build(imported, [], "FY27", undefined, ["completed"]), AT, "N").summaryNotes).toEqual([THESE("FY27")]);
    // Carried in shown but dashed: the tracking line only (no Carried in sentence, no other column).
    expect(YearEndLayout.layout(build(imported, [], "FY27", undefined, ["carriedIn"]), AT, "N").summaryNotes).toEqual(["Tracking started Sep 26, 2026, so Carried in from FY26 isn't available."]);
    expect(YearEndLayout.layout(build(imported, [], "FY27", undefined, ["carriedIn", "completed"]), AT, "N").summaryNotes).toEqual(["Tracking started Sep 26, 2026, so Carried in from FY26 isn't available.", OTHER("FY27"), OVERLAP]);
  });

  it("closed-year categories (FY26): every one of the 7 combinations shows exactly the selected sections and totals, in order; each section's rows per department equal its grid column; no Cancelled", () => {
    const { list, history } = world();
    const all = build(list, history, "FY26");
    const label = { carriedIn: "Carried in from FY25", completed: "Completed FY26", openAtEnd: "Carried into FY27" } as const;
    const combos: YearEndCategory[][] = [["carriedIn"], ["completed"], ["openAtEnd"], ["carriedIn", "completed"], ["carriedIn", "openAtEnd"], ["completed", "openAtEnd"], ["carriedIn", "completed", "openAtEnd"]];
    const notes = new Map<string, string>();
    for (const c of combos) {
      const d = build(list, history, "FY26", undefined, [...c].reverse());
      const l = aligned(d);
      expect(d.title).toBe("FY26 Year-End Report");
      expect(l.summaryHeads).toEqual(c.map((x) => label[x]));
      expect(bandLabels(l).length).toBe(1 + c.length);
      // Same per-department numbers as the all-three report; rows are departments with a project in a shown column;
      // Total sums each shown column (no cross-column sum).
      expect(d.summary.map((r) => [r.label, ...c.map((x) => r[x])])).toEqual(all.summary.filter((r) => r.area === "total" || c.some((x) => (r[x] ?? 0) > 0)).map((r) => [r.label, ...c.map((x) => r[x])]));
      sectionsMatchGrid(d, c, all, list);
      expect(d.sections.map((s) => s.heading)).toEqual(c.map((x) => ({ carriedIn: "Carried in from FY25", completed: "Completed in FY26", openAtEnd: "Carried into FY27" })[x]));
      // No Cancelled section, column or total. (A Carried in row can show a Cancelled status: the Carried in count
      // includes projects later closed without being completed, and its section lists the same projects.)
      expect(JSON.stringify([l.summaryHeads, l.summaryNotes, l.band, d.sections.map((s) => s.heading)])).not.toMatch(/cancel/i);
      for (const sec of d.sections.filter((x) => x.kind !== "carriedIn")) expect(JSON.stringify(sec)).not.toMatch(/cancel/i);
      notes.set(c.join("+"), l.summaryNotes.join(" | "));
    }
    expect(Object.fromEntries(notes)).toEqual({
      carriedIn: IN,
      completed: THESE("FY26"),
      openAtEnd: THESE("FY26"),
      "carriedIn+completed": `${BOTH("FY26")} | ${OVERLAP}`,
      "carriedIn+openAtEnd": `${BOTH("FY26")} | ${OVERLAP}`,
      "completed+openAtEnd": `${THESE("FY26")} | ${OVERLAP}`,
      "carriedIn+completed+openAtEnd": `${BOTH("FY26")} | ${OVERLAP}`,
    });
    expect(grid(build(list, history, "FY26", undefined, ["completed"]))).toEqual([["Cath", 1], ["Total", 1]]);
    expect(grid(build(list, history, "FY26", undefined, ["carriedIn", "openAtEnd"]))).toEqual([["Cath", 2, 1], ["EP", 1, 0], ["Echo", 2, 1], ["IR", 0, 1], ["Total", 5, 3]]);
    // Default (missing) = all three.
    expect(all.columns).toEqual(["carriedIn", "completed", "openAtEnd"]);
    // Dash notes stay, only for shown columns.
    const imported = [p({ name: "Imported", serviceArea: D.Cath, status: "OnTrack", createdAt: new Date("2026-09-26T14:00:00Z") })];
    expect(YearEndLayout.layout(build(imported, [], "FY26", undefined, ["completed"]), AT, "N").summaryNotes).toEqual([THESE("FY26")]);
    expect(YearEndLayout.layout(build(imported, [], "FY26", undefined, ["openAtEnd"]), AT, "N").summaryNotes).toEqual(["Tracking started Sep 26, 2026, so Carried into FY27 isn't available.", THESE("FY26")]);
    // Both dashed: one merged line; Carried in dashed, so no Carried in sentence; Carried in on the page: "The other columns".
    expect(YearEndLayout.layout(build(imported, [], "FY26", undefined, ["carriedIn", "openAtEnd"]), AT, "N").summaryNotes).toEqual([MERGED, OTHER("FY26"), OVERLAP]);
    expect(YearEndLayout.layout(build(imported, [], "FY26", undefined, ["carriedIn"]), AT, "N").summaryNotes).toEqual(["Tracking started Sep 26, 2026, so Carried in from FY25 isn't available."]);
    expect(YearEndLayout.layout(build(imported, [], "FY26", undefined, ["carriedIn", "completed"]), AT, "N").summaryNotes).toEqual(["Tracking started Sep 26, 2026, so Carried in from FY25 isn't available.", OTHER("FY26"), OVERLAP]);
    // Both boundaries tracked: no tracking line, both sentences. (Carried into dashed with Carried in real cannot happen:
    // its boundary is a year later.)
    const mixed = [p({ name: "Old open", serviceArea: D.Cath, status: "OnTrack", createdAt: new Date("2025-03-01T12:00:00Z") })];
    expect(YearEndReportData.trackedSince(mixed, [])).toBe("2025-03-01");
    expect(YearEndLayout.layout(build(mixed, [], "FY26"), AT, "N").summaryNotes).toEqual([BOTH("FY26"), OVERLAP]);
  });

  it("the category option is validated: missing = all three; empty, unknown, repeated or non-list values are refused", () => {
    expect(YearEndCategories.parse(undefined)).toEqual(["carriedIn", "completed", "openAtEnd"]);
    expect(YearEndCategories.parse(null)).toEqual(["carriedIn", "completed", "openAtEnd"]);
    expect(YearEndCategories.parse(["openAtEnd", "carriedIn"])).toEqual(["carriedIn", "openAtEnd"]);
    for (const bad of [[], ["cancelled"], ["completed", "completed"], "completed", 3, [1], ["carriedIn", "completed", "openAtEnd", "carriedIn"]]) expect(YearEndCategories.parse(bad)).toBeNull();
    expect([YearEndCopy.CATEGORIES_LABEL, ...YearEndCategories.ALL.map((c) => YearEndCopy.categoryLabel(c, "FY27", true)), YearEndCopy.CATEGORIES_NONE]).toEqual(["Include in report", "Carried in from FY26", "Completed FY27", "Still in progress", "Pick at least one."]);
    expect(YearEndCategories.ALL.map((c) => YearEndCopy.categoryLabel(c, "FY26", false))).toEqual(["Carried in from FY25", "Completed FY26", "Carried into FY27"]);
    for (const bad of [["inProgress"], ["carriedOut"], ["cancelled", "completed"]]) expect(YearEndCategories.parse(bad)).toBeNull();
  });

  it("no Cancelled column; plain labels, no em dashes; completed matches 'Completed FY27 to date' (no hidden, no reopened)", () => {
    const { list, history } = world();
    const hidden = p({ name: "Hidden", serviceArea: D.Cath, status: "Complete", completedOn: "2026-08-20", hiddenFromReport: true });
    const d = build([...list, hidden], history, "FY27");
    expect(Object.keys(d.summary[0]).sort()).toEqual(["area", "carriedIn", "completed", "label", "muted", "openAtEnd"]);
    expect(d.sections[1].groups.flatMap((g) => g.rows.map((r) => r.name))).toEqual(["Done in FY27"]);
    for (const fy of ["FY26", "FY27"]) {
      const l = YearEndLayout.layout(build(list, history, fy), AT, "Nick Leary");
      expect(l.summaryHeads).toHaveLength(3);
      for (const t of [...l.summaryHeads, ...l.summaryNotes]) expect(t).not.toMatch(/\u2014|Cancelled/);
    }
    expect(YearEndReportData.previousLabel("FY27")).toBe("FY26");
    expect(YearEndReportData.previousLabel("FY00")).toBe("FY99");
    expect(YearEndReportData.dayBefore("2026-07-01")).toBe("2026-06-30");
  });

  it("the year-end export is download-only: never a handoff.json, Drive upload, artifact or email (the Wednesday email only reads weekly files)", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    fake.state.projects.push({ ...p({ name: "Done", status: "Complete", completedOn: "2026-08-01" }), serviceLineId: ServiceLine.DEFAULT_ID });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const fy of ["FY27", "FY26"]) await YearEndReportService.generate({ ...Factory.ADMIN, name: "Nick Leary" }, fy, ServiceLine.defaultScope(), db, AT);
    // No network call at all (the PDF engine loads its layout module from an inline data: URL).
    expect(fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith("data:"))).toEqual([]);
    fetchSpy.mockRestore();
    expect(fake.writes.map((w) => w.model)).toEqual(["yearEndReport", "yearEndReport"]);
    expect(fake.state.artifacts).toHaveLength(0);
    expect(fake.state.yearEndReports.map((r) => r.fileName)).toEqual(["mid-year-fy27-2026-09-27.pdf", "year-end-fy26-2026-09-27.pdf"]);
    const files = ["src/lib/services/YearEndReportService.ts", "src/lib/report/YearEndReportData.ts", "src/lib/report/YearEndRenderer.ts", "src/lib/report/pdf/YearEndLayout.ts", "src/lib/report/pdf/YearEndDocument.tsx", "src/app/reports/year-end/[id]/route.ts"];
    // No Drive, handoff, delivery, archive or mail code is imported or called (comments aside).
    for (const f of files) {
      const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect([f, code.match(/GoogleDriveClient|HandoffBuilder|handoff\.json|ReportDeliveryService|ReportArchiveService|reportArtifact|sendMail|Mailer/g)]).toEqual([f, null]);
    }
    const action = readFileSync("src/app/actions/reports.ts", "utf8");
    const gen = action.slice(action.indexOf("export async function generateYearEndReport"));
    expect(gen.slice(0, gen.indexOf("\n}\n"))).not.toMatch(/Drive|Handoff|handoff|Delivery|Archive/);
  }, 30000);
});

describe("table: wider Final update that wraps in full, and completed rows tinted like the weekly report", () => {
  it("column widths: Final update 206 to 268; the others trimmed; still the 720 pt content width", () => {
    const C = YearEndLayout.COLUMNS;
    expect(Object.fromEntries(Object.entries(C).map(([k, v]) => [k, v.w]))).toEqual({ project: 184, owner: 100, requester: 100, date: 68, update: 268 });
    let x = 0;
    for (const c of [C.project, C.owner, C.requester, C.date, C.update]) {
      expect(c.x).toBe(x);
      x += c.w;
    }
    expect(x).toBe(ReportGeometry.CONTENT_W);
    // The date column still fits the widest date, header and status chip.
    const m = new TextMeasure();
    const room = C.date.w - ReportGeometry.CELL_PAD_R;
    expect(m.width("Sep 30, 2026", 8, 400)).toBeLessThan(room);
    expect(m.width("COMPLETED", 7, 600)).toBeLessThan(room);
  });

  it("the whole final update shows (no 2-line cap): a 200-character update wraps onto every line it needs, no ellipsis", () => {
    const m = new TextMeasure();
    const row = YearEndLayout.row(m, { projectId: "x", name: "Hemodynamic monitoring integration", owner: "Nicole Smith", requester: null, date: "2026-08-12", status: "Complete", finalUpdate: LONG }, true);
    expect(row.update.length).toBeGreaterThan(2);
    expect(row.update.join(" ")).toBe(LONG);
    expect(row.update.join("")).not.toContain(TextMeasure.ELLIPSIS);
    expect(row.height).toBe(ReportGeometry.ROW_PAD * 2 + row.update.length * ReportGeometry.TABLE_LH + ReportGeometry.ROW_BORDER);
    for (const line of row.update) expect(m.width(line, 8, 400)).toBeLessThanOrEqual(YearEndLayout.COLUMNS.update.w - ReportGeometry.CELL_PAD_R);
  });

  it("only text too long for a whole page is clipped (with an ellipsis), so a row always fits on one page", () => {
    const m = new TextMeasure();
    const huge = "word ".repeat(3000).trim();
    const row = YearEndLayout.row(m, { projectId: "x", name: "N", owner: null, requester: null, date: "2026-08-12", status: "Complete", finalUpdate: huge });
    expect(row.update.length).toBe(YearEndLayout.updateLineLimit());
    expect(row.update.at(-1)!.endsWith(TextMeasure.ELLIPSIS)).toBe(true);
    const d = build([p({ name: "N", status: "Complete", completedOn: "2026-08-12", accomplishment: huge })], [], "FY27");
    const layout = YearEndLayout.layout(d, AT, "Nick Leary");
    const bottom = ReportGeometry.CONTENT_H - ReportGeometry.FOOTER_H - ReportGeometry.FOOTER_GAP;
    for (const pg of layout.pages) for (const b of pg.blocks) expect(pg.bodyTop + b.y + b.height).toBeLessThanOrEqual(bottom + 0.001);
  });

  it("completed rows are shaded with the weekly CompletedBlockStyle; carried rows are not; cancelled projects aren't listed; long rows move whole to the next page", async () => {
    const many = Array.from({ length: 40 }, (_, i) => p({ name: `Done ${String(i).padStart(2, "0")}`, serviceArea: "Cath", status: "Complete", completedOn: "2026-08-12", accomplishment: LONG }));
    const stopped = p({ name: "Stopped", status: "Cancelled", note: LONG });
    const d = build([...many, stopped, p({ name: "Still open", status: "OnTrack", note: LONG })], [status(stopped.id, "2026-08-01T15:00:00Z", "OnHold", "Cancelled")], "FY27", undefined, ["completed", "openAtEnd"]);
    const layout = YearEndLayout.layout(d, AT, "Nick Leary");
    const rows = layout.pages.flatMap((pg) => pg.blocks).filter((b): b is Extract<YearEndBlock, { kind: "row" }> => b.kind === "row");
    expect(rows.filter((r) => r.row.shaded)).toHaveLength(40);
    expect(rows.filter((r) => !r.row.shaded).map((r) => r.row.name[0])).toEqual(["Still open"]);
    expect(layout.pages.length).toBeGreaterThan(1);
    // The PDF uses the weekly style's own values (no copied colors).
    const pdf = await YearEndRenderer.render(d, AT, "Nick Leary");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const src = (await import("node:fs")).readFileSync("src/lib/report/pdf/YearEndDocument.tsx", "utf8");
    expect(src).toContain("backgroundColor: st.FILL");
    expect(src).toContain("borderLeftColor: st.ACCENT");
    expect(src).not.toMatch(/#F4FBFA|#0E6961|#D9EEEB/i);
    expect(CompletedBlockStyle.FILL).toBe("#F4FBFA");
  }, 30000);

  it("a project completed later by an entered date, with no status on record, counts as open at the earlier boundary and prints 'Open' (no guessed chip)", () => {
    const later = p({ name: "Completed later by date", serviceArea: "Cath", status: "Complete", completedOn: "2026-09-10" });
    const tracked = p({ name: "Tracked", serviceArea: "Cath", status: "OnTrack", createdAt: new Date("2025-01-01T12:00:00Z") });
    const d = build([later, tracked], [], "FY26");
    const row = d.sections[2].groups[0].rows.find((r) => r.name === "Completed later by date")!;
    expect(row.statusUnknown).toBe(true);
    const laid = YearEndLayout.row(new TextMeasure(), row);
    expect([laid.pill, laid.statusText]).toEqual([null, "Open"]);
    expect(d.totals).toMatchObject({ openAtEnd: 2 });
    // Carried in from FY25 lists it too, with its status at the FY26 end: unknown, so the same gray "Open".
    const inRow = d.sections[0].groups[0].rows.find((r) => r.name === "Completed later by date")!;
    expect([inRow.status, inRow.statusUnknown]).toEqual(["Complete", true]);
    expect(YearEndLayout.row(new TextMeasure(), inRow).statusText).toBe("Open");
    expect(d.sections[0].count).toBe(d.totals.carriedIn);
  });
});

describe("Carried in / Carried into rows that were Complete by the section's day show the final update", () => {
  const D = ServiceAreaInfo.CVPSL_IDS;
  const old = new Date("2025-03-01T12:00:00Z");
  const rowsOf = (d: YearEndData, kind: string) => Object.fromEntries(d.sections.find((s) => s.kind === kind)!.groups.flatMap((g) => g.rows.map((r) => [r.name, [r.status, r.statusUnknown ?? false, r.finalUpdate]])));

  it("current year: a carried-in project completed since shows the full final update without Completed, and a pointer to the Completed section with it; open and cancelled rows keep the latest update", () => {
    const done = p({ name: "Done", serviceArea: D.Cath, status: "Complete", completedOn: "2026-08-15", accomplishment: "Shipped to all labs.", note: "Old weekly note.", createdAt: old });
    const doneNoText = p({ name: "Done no text", serviceArea: D.Cath, status: "Complete", completedOn: "2026-08-20", accomplishment: null, note: "Only a note.", createdAt: old });
    const open = p({ name: "Open", serviceArea: D.EP, status: "AtRisk", accomplishment: "Not used.", note: "Waiting on vendor.", createdAt: old });
    const stopped = p({ name: "Stopped", serviceArea: D.IR, status: "Cancelled", accomplishment: "Not used.", note: "Vendor withdrew.", createdAt: old });
    const history = [status(stopped.id, "2026-08-01T15:00:00Z", "OnHold", "Cancelled"), status(done.id, "2026-08-15T15:00:00Z", "OnTrack", "Complete"), status(doneNoText.id, "2026-08-20T15:00:00Z", "OnTrack", "Complete")];
    const list = [done, doneNoText, open, stopped];
    // Completed unchecked: the full final update (the Completed section's source text).
    for (const cats of [["carriedIn"], ["carriedIn", "openAtEnd"]] as YearEndCategory[][]) {
      expect(rowsOf(build(list, history, "FY27", undefined, cats), "carriedIn")).toEqual({
        Done: ["Complete", false, "Shipped to all labs."],
        "Done no text": ["Complete", false, "Only a note."],
        Open: ["AtRisk", false, "Waiting on vendor."],
        // The Cancelled chip stays (the row count must match the column); its text is the latest update.
        Stopped: ["Cancelled", false, "Vendor withdrew."],
      });
    }
    // Carried in and Completed both checked: a short pointer; the heading part is the Completed section's own heading.
    for (const cats of [undefined, ["carriedIn", "completed"]] as (YearEndCategory[] | undefined)[]) {
      const d = build(list, history, "FY27", undefined, cats);
      const heading = d.sections.find((s) => s.kind === "completed")!.heading;
      expect(heading).toBe("Completed in FY27");
      expect(heading).toBe(YearEndCopy.completedIn("FY27"));
      expect(rowsOf(d, "carriedIn")).toEqual({
        Done: ["Complete", false, `Completed Aug 15, 2026. Its final update is under ${heading}.`],
        "Done no text": ["Complete", false, `Completed Aug 20, 2026. Its final update is under ${heading}.`],
        Open: ["AtRisk", false, "Waiting on vendor."],
        Stopped: ["Cancelled", false, "Vendor withdrew."],
      });
      expect(YearEndCopy.seeCompleted("2026-08-15", heading)).toBe("Completed Aug 15, 2026. Its final update is under Completed in FY27.");
      // The Completed section keeps the full text.
      expect(rowsOf(d, "completed")).toEqual({ Done: ["Complete", false, "Shipped to all labs."], "Done no text": ["Complete", false, "Only a note."] });
      // Same Complete chip and row style (plain update text, not shaded) in the Carried in section.
      const laid = YearEndLayout.layout(d, AT, "Nick Leary").pages.flatMap((pg) => pg.blocks).filter((b): b is Extract<YearEndBlock, { kind: "row" }> => b.kind === "row" && b.row.name[0] === "Done");
      expect(laid.map((b) => [b.row.shaded, b.row.pill?.status ?? null, b.row.update.join(" ")])).toEqual([
        [false, "Complete", `Completed Aug 15, 2026. Its final update is under ${heading}.`],
        [true, null, "Shipped to all labs."],
      ]);
    }
    // Headers unchanged: Status and Latest update.
    expect(YearEndLayout.columnLabels("carriedIn")).toEqual(["Project", "Owner", "Requester", "Status", "Latest update"]);
  });

  it("closed year: Complete as of Jun 30 (even if reopened since) shows the final update; a gray 'Open' (status not on record) keeps the latest update", () => {
    const reopened = p({ name: "Reopened", serviceArea: D.Cath, status: "OnTrack", accomplishment: "Phase one live.", note: "Phase two started.", createdAt: old });
    const later = p({ name: "Completed later", serviceArea: D.Echo, status: "Complete", completedOn: "2026-09-10", accomplishment: "Done in September.", note: "Still testing.", createdAt: old });
    const history = [status(reopened.id, "2026-06-01T15:00:00Z", "OnTrack", "Complete"), status(reopened.id, "2026-08-02T15:00:00Z", "Complete", "OnTrack")];
    const d = build([reopened, later], history, "FY26");
    expect(rowsOf(d, "carriedIn")).toEqual({
      Reopened: ["Complete", false, "Phase one live."],
      "Completed later": ["Complete", true, "Still testing."],
    });
    // Reopened was Complete on Jun 30 but isn't Complete now, so it isn't in the Completed section: full text even with
    // Completed checked (the default here). Carried into rows are open at Jun 30 by definition; the unknown one keeps
    // its latest update too.
    expect(rowsOf(d, "carried")).toEqual({ "Completed later": ["Complete", true, "Still testing."] });
  });
});

describe("overlap note under the grid", () => {
  it("'A project can be counted in more than one column.' shows only with two or more boxes checked, after the other notes", () => {
    const base = { fy: "FY27", carriedIn: 3, trackedSince: "2025-03-01", inLabel: "Carried in from FY26", outLabel: "Still in progress", inDashed: false, outDashed: false };
    for (const c of YearEndCategories.ALL) expect(YearEndCopy.gridNotes({ ...base, columns: [c] })).not.toContain(OVERLAP);
    expect(YearEndCopy.gridNotes({ ...base, columns: ["completed", "openAtEnd"] })).toEqual([THESE("FY27"), OVERLAP]);
    expect(YearEndCopy.gridNotes({ ...base, columns: ["carriedIn", "completed", "openAtEnd"] })).toEqual([BOTH("FY27"), OVERLAP]);
    // After the tracking line and the column note.
    const notes = YearEndCopy.gridNotes({ ...base, fy: "FY26", carriedIn: null, inLabel: "Carried in from FY25", outLabel: "Carried into FY27", trackedSince: "2026-09-26", inDashed: true, outDashed: true, columns: ["carriedIn", "openAtEnd"] });
    expect(notes).toEqual([MERGED, OTHER("FY26"), OVERLAP]);
    expect(YearEndCopy.GRID_NOTE_OVERLAP).toBe(OVERLAP);
  });
});
