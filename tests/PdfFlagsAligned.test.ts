import { describe, expect, it } from "vitest";
import { FlagSlots, type FlagKind, type FlagState } from "@/lib/domain/FlagSlots";
import type { ReportRow } from "@/lib/domain/types";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type PlacedFlag } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";

const m = new TextMeasure();

class Fx {
  /** The sample rows with their flags replaced (row i gets states[i % states.length]). */
  static rows(states: FlagState[]): ReportRow[] {
    return SampleReportData.rows().map((r, i) => {
      const s = states[i % states.length];
      return { ...r, changed: s.changed, overdue: s.overdue, stale: s.stale ? (SampleReportData.rows().find((x) => x.stale)!.stale) : undefined };
    });
  }

  /** Every placed flag in the laid-out default-layout report. */
  static placed(rows: ReportRow[]): PlacedFlag[] {
    const doc = ReportLayout.layout(SampleReportData.docInput({ rows, completed: [] }), m);
    return doc.pages.flatMap((p) =>
      p.kind === "report" ? p.blocks.flatMap((b) => (b.kind === "row" ? b.row.cells.flatMap((c) => (c.kind === "flags" ? c.flags : [])) : [])) : [],
    );
  }

  static xs(placed: PlacedFlag[]): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const f of placed) (out[f.kind] ??= []).push(f.dx);
    return out;
  }
}

const NONE: FlagState = { changed: false, overdue: false, stale: false };
const STALE: FlagState = { ...NONE, stale: true };
const CHANGED: FlagState = { ...NONE, changed: true };
const OVERDUE_STALE: FlagState = { ...NONE, overdue: true, stale: true };

describe("PDF flags line up under the FLAGS header (default layout, fixed slots per report)", () => {
  it("FlagSlots.used lists the kinds any row has, in canonical order", () => {
    expect(FlagSlots.used([])).toEqual([]);
    expect(FlagSlots.used([STALE, NONE])).toEqual(["stale"]);
    expect(FlagSlots.used([STALE, CHANGED])).toEqual(["changed", "stale"]);
    expect(FlagSlots.used([OVERDUE_STALE, CHANGED])).toEqual(["changed", "overdue", "stale"]);
  });

  it("a report whose rows are only Stale puts every Stale chip at the column x, under FLAGS (was the third slot)", () => {
    const placed = Fx.placed(Fx.rows([STALE, NONE]));
    expect(placed.length).toBeGreaterThan(0);
    expect(new Set(placed.map((f) => f.dx))).toEqual(new Set([0]));
    // Before: Stale sat after the empty Changed and Overdue slots.
    expect(ReportLayout.flagSlots(m)[2].dx).toBeGreaterThan(80);
  });

  it("fixed positions: each kind has one x on every row of the report, whichever other flags the row has", () => {
    const placed = Fx.placed(Fx.rows([STALE, CHANGED, NONE, { ...CHANGED, stale: true }]));
    const xs = Fx.xs(placed);
    expect(Object.keys(xs).sort()).toEqual(["changed", "stale"]);
    for (const k of Object.keys(xs)) expect(new Set(xs[k]).size, k).toBe(1);
    const slots = ReportLayout.flagSlots(m, ["changed", "stale"]);
    expect(xs.changed[0]).toBe(0);
    expect(xs.stale[0]).toBe(slots[1].dx);
    // A Stale-only row keeps Stale in its slot (Changed's slot stays blank), it does not slide left.
    expect(xs.stale.every((x) => x === slots[1].dx)).toBe(true);
  });

  it("when all three kinds appear, the slots are exactly the previous fixed slots (unchanged layout)", () => {
    const placed = Fx.placed(Fx.rows([OVERDUE_STALE, CHANGED, NONE]));
    const all = ReportLayout.flagSlots(m);
    for (const f of placed) {
      expect(f.slot).toBe(FlagSlots.index(f.kind));
      expect(f.dx).toBe(all[FlagSlots.index(f.kind)].dx);
    }
  });

  it("only the chips' x changes: row heights, cells and pagination are the same as with the old slots", () => {
    const rows = Fx.rows([STALE, NONE]);
    const kinds: FlagKind[] = FlagSlots.used(rows.map((r) => ({ changed: r.changed, overdue: r.overdue, stale: Boolean(r.stale) })));
    for (const r of rows) {
      const now = ReportLayout.rowLayout(m, r, SampleReportData.docInput().viewSettings, SampleReportData.REPORT_DATE, kinds);
      const old = ReportLayout.rowLayout(m, r, SampleReportData.docInput().viewSettings, SampleReportData.REPORT_DATE);
      expect(now.height).toBe(old.height);
      const strip = (l: typeof now) => l.cells.map((c) => (c.kind === "flags" ? { ...c, flags: c.flags.map((f) => ({ ...f, dx: 0 })) } : c));
      expect(strip(now)).toEqual(strip(old));
    }
  });
});
