import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ServiceArea } from "@/generated/prisma/enums";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DepartmentsSelect, TileVisibilityButton, DepartmentChecklist } from "@/components/DashboardFilterControls";
import { ProjectDashboard } from "@/components/ProjectDashboard";
import { DashboardPrefs, type PrefsStorage } from "@/lib/dashboard/DashboardPrefs";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import { DashboardGroups } from "@/lib/dashboard/DashboardGroups";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportOptionsForm } from "@/lib/services/ReportOptionsForm";
import { Factory } from "./helpers/factories";

vi.mock("next/dynamic", () => ({ default: () => () => null }));

class MemoryStorage implements PrefsStorage {
  readonly map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const TODAY = "2026-09-26";
const rows = DashboardViewModel.rows(
  [
    Factory.project({ id: "c1", name: "Cath one", serviceArea: "Cath", status: "OnTrack" }),
    Factory.project({ id: "e1", name: "EP one", serviceArea: "EP", status: "AtRisk" }),
    Factory.project({ id: "i1", name: "IR one", serviceArea: "IR", status: "OnTrack" }),
    Factory.project({ id: "n1", name: "Neuro one", serviceArea: "CardioNeuro", status: "OffTrack" }),
    Factory.project({ id: "u1", name: "No department", serviceArea: null, status: "NotStarted" }),
  ],
  ViewSettings.defaults("dashboard"),
  [],
  null,
  TODAY,
);

describe("DepartmentFilter", () => {
  it("offers every department from the ServiceArea enum in report order (same as the PDF); default and empty mean all", () => {
    expect(DepartmentFilter.OPTIONS).toEqual(Object.values(ServiceArea));
    expect(DepartmentFilter.OPTIONS).toEqual(ServiceAreaInfo.all());
    expect(DepartmentFilter.OPTIONS.map((a) => DepartmentFilter.optionLabel(a))).toEqual(["Cath Lab", "EP Lab", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    expect(DepartmentFilter.normalize(undefined)).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    expect(DepartmentFilter.normalize([])).toEqual(DepartmentFilter.all());
    expect(DepartmentFilter.normalize(["IR", "bogus", "Cath"])).toEqual(["Cath", "IR"]);
  });

  it("never lets the last checked department be cleared", () => {
    expect(DepartmentFilter.toggle(["EP"], "EP")).toEqual(["EP"]);
    expect(DepartmentFilter.lockedOption(["EP"])).toBe("EP");
    expect(DepartmentFilter.lockedOption(["EP", "IR"])).toBeNull();
    expect(DepartmentFilter.toggle(["EP", "IR"], "Cath")).toEqual(["Cath", "EP", "IR"]);
  });

  it("closed box reads All, the short names, or K of M (M = every department) when the names do not fit", () => {
    expect(DepartmentFilter.summary(DepartmentFilter.all())).toBe("Departments: All");
    expect(DepartmentFilter.summary(["Cath", "EP"])).toBe("Departments: Cath, EP");
    expect(DepartmentFilter.summary(["Cath", "EP", "CardioNeuro"])).toBe(`Departments: 3 of ${ServiceAreaInfo.all().length}`);
    expect(DepartmentFilter.summary(["Cath", "EP", "CardioNeuro"])).toBe("Departments: 3 of 7");
    expect(DepartmentFilter.reportDetail(DepartmentFilter.all())).toBeNull();
    expect(DepartmentFilter.summary(["Cath", "EP", "IR"])).toBe("Departments: Cath, EP, IR");
  });

  it("Unassigned shows only when every department is selected; tiles count only the filtered departments", () => {
    const all = DepartmentFilter.apply(rows, DepartmentFilter.all());
    expect(DashboardGroups.group(all).map((g) => g.area)).toContain("Unassigned");
    const some = DepartmentFilter.apply(rows, ["Cath", "IR"]);
    expect(DashboardGroups.group(some).map((g) => g.area)).toEqual(["Cath", "IR"]);
    const s = DashboardViewModel.summarize(some);
    expect(s.total).toBe(2);
    expect(s.byStatus.OnTrack).toBe(2);
    expect(s.byStatus.AtRisk + s.byStatus.OffTrack + s.byStatus.NotStarted).toBe(0);
  });
});

describe("DashboardPrefs (localStorage, per user)", () => {
  it("defaults to all departments and every tile shown, and keeps each user separate", () => {
    const st = new MemoryStorage();
    expect(DashboardPrefs.readDepartments(st, "a@x.org")).toEqual(DepartmentFilter.all());
    expect(DashboardPrefs.readHiddenTiles(st, "a@x.org")).toEqual([]);
    DashboardPrefs.writeDepartments(st, "A@x.org", ["EP"]);
    DashboardPrefs.writeHiddenTiles(st, "a@x.org", ["OnHold", "completedFy"]);
    expect(DashboardPrefs.readDepartments(st, "a@x.org")).toEqual(["EP"]);
    expect(DashboardPrefs.readHiddenTiles(st, "a@x.org")).toEqual(["OnHold", "completedFy"]);
    expect(DashboardPrefs.readDepartments(st, "b@x.org")).toEqual(DepartmentFilter.all());
    expect(DashboardPrefs.readHiddenTiles(st, "b@x.org")).toEqual([]);
    st.setItem(DashboardPrefs.departmentsKey("c@x.org"), "{not json");
    expect(DashboardPrefs.readDepartments(st, "c@x.org")).toEqual(DepartmentFilter.all());
    expect(DashboardPrefs.readDepartments(null, "c@x.org")).toEqual(DepartmentFilter.all());
  });

  it("has no Cancelled tile; remaining tiles share the row equally, and no row when every tile is off", () => {
    expect(DashboardPrefs.TILES).not.toContain("Cancelled");
    expect(DashboardPrefs.availableTiles(true)).toEqual(["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold", "Complete", "completedFy"]);
    expect(DashboardPrefs.availableTiles(false)).not.toContain("completedFy");
    const visible = DashboardPrefs.visibleTiles(["AtRisk"], true);
    expect(visible).toEqual(["NotStarted", "OnTrack", "OffTrack", "OnHold", "Complete", "completedFy"]);
    expect(DashboardPrefs.gridTemplate(visible)).toBe("repeat(6, minmax(0, 1fr))");
    expect(DashboardPrefs.gridTemplate(DashboardPrefs.visibleTiles(DashboardPrefs.TILES, true))).toBeNull();
    expect(DashboardPrefs.toggleTile(["AtRisk", "OnHold"], "AtRisk", true)).toEqual(["OnHold"]);
  });
});

describe("dashboard filter row", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectDashboard, {
      rows,
      columns: ViewSettings.visibleColumns(ViewSettings.defaults("dashboard")),
      today: TODAY,
      userEmail: "member@example.org",
      userName: "Member",
      latestReport: null,
      completedFiscalYear: { label: "FY27", start: "2026-07-01", count: 4 },
      loadError: null,
      serviceLine: ServiceLine.defaults(),
      signOutAction: async () => {},
    }),
  );

  it("shows the Departments select (All by default) and the tile button, and no Cancelled tile", () => {
    expect(html).toContain("Departments: All");
    expect(html).toContain('title="Show or hide tiles"');
    const summary = html.slice(html.indexOf('aria-label="Status summary"'), html.indexOf('aria-label="Department filter"'));
    expect(html).toContain("grid-template-columns:repeat(7, minmax(0, 1fr))");
    expect(summary).not.toContain("Cancelled");
    expect((summary.match(/data-tile=/g) ?? []).length).toBe(6);
    expect(summary).toContain("Completed FY27 to date");
    // The select sits before the tile button (far right).
    expect(html.indexOf("Departments: All")).toBeLessThan(html.indexOf("Show or hide tiles"));
  });

  it("the closed select and checklist render with the shared select style", () => {
    const sel = renderToStaticMarkup(createElement(DepartmentsSelect, { value: ["Cath", "EP"], onChange: () => {} }));
    expect(sel).toContain("Departments: Cath, EP");
    expect(sel).toContain("appearance-none");
    const list = renderToStaticMarkup(createElement(DepartmentChecklist, { value: ["IR"], onChange: () => {}, name: "departments" }));
    expect(list.indexOf("Cath Lab")).toBeLessThan(list.indexOf("EP Lab"));
    expect(list.indexOf("EP Lab")).toBeLessThan(list.indexOf("CardioNeuro"));
    expect((list.match(/disabled=""/g) ?? []).length).toBe(1);
    const tiles = renderToStaticMarkup(createElement(TileVisibilityButton, { tiles: DashboardPrefs.TILES, hidden: [], labelOf: (t) => t, onChange: () => {} }));
    expect(tiles).toContain('aria-label="Show or hide tiles"');
  });
});

describe("admin Report contents form", () => {
  it("parses the checked departments (at least one) and the totals grid mode", () => {
    expect(ReportOptionsForm.parse({ departments: ["EP", "Cath"], totalsGrid: "hidden" })).toEqual({ departments: ["Cath", "EP"], totalsGrid: "hidden" });
    expect(ReportOptionsForm.parse({ departments: [], totalsGrid: "nope" })).toEqual({ departments: DepartmentFilter.all(), totalsGrid: "top" });
  });

  it("is admin-only", async () => {
    expect(await ReportOptionsForm.submit(Factory.MEMBER, { departments: ["EP"], totalsGrid: "top" }, {} as never)).toEqual({ ok: false, message: "Not authorized." });
    expect(await ReportOptionsForm.submit(null, { departments: ["EP"], totalsGrid: "top" }, {} as never)).toEqual({ ok: false, message: "Not authorized." });
  });
});
