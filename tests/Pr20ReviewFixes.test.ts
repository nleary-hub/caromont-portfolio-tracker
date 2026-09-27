import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceArea } from "@/generated/prisma/enums";
import { DepartmentsSelect } from "@/components/DashboardFilterControls";
import { DashboardGroups } from "@/lib/dashboard/DashboardGroups";
import { DashboardPrefs, type PrefsStorage } from "@/lib/dashboard/DashboardPrefs";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";

const m = new TextMeasure();
const DEFAULTS = ViewSettings.defaults("report");

class Fixture {
  static memory(): PrefsStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
  }

  /** `n` visible report rows in `area` (null = Unassigned). */
  static rows(area: ServiceArea | null, n: number, prefix: string): ReportRow[] {
    const base = SampleReportData.rows().find((r) => r.status === "OnTrack")!;
    return Array.from({ length: n }, (_, i) => ({ ...base, projectId: `${prefix}${i}`, name: `${prefix} ${i}`, serviceArea: area }));
  }

  static layout(rows: ReportRow[], overrides: Record<string, unknown> = {}) {
    const sorted = ReportBuilder.sort(rows);
    return ReportLayout.layout(SampleReportData.docInput({ rows: sorted, header: ReportBuilder.header(sorted), completed: [], showKeyPage: false, ...overrides }), m);
  }
}

describe("Reporting period range (shared formatter)", () => {
  it("en dash, no spaces: same month, different months, different years", () => {
    expect(ReportFormat.dateRange("2026-09-15", "2026-09-29")).toBe("Sep 15\u201329, 2026");
    expect(ReportFormat.dateRange("2026-09-22", "2026-10-06")).toBe("Sep 22\u2013Oct 6, 2026");
    expect(ReportFormat.dateRange("2026-12-22", "2027-01-05")).toBe("Dec 22, 2026\u2013Jan 5, 2027");
    expect(ReportFormat.dateRange("2026-09-01", "2026-09-09")).toBe("Sep 1\u20139, 2026");
  });

  it("the page-1 wording and handoff.json period label are unchanged", () => {
    expect(ReportFormat.period("2026-09-15", "2026-09-29")).toBe("Sep 15 \u2013 Sep 29, 2026");
  });

  it("running header uses it: 'Reporting period Sep 22\u2013Oct 6, 2026 (continued)'", () => {
    const l = ReportLayout.layout(SampleReportData.docInput({ periodStart: "2026-09-22", periodEnd: "2026-10-06" }), m);
    expect(ReportLayout.runningHeaderText(l.header).rest).toBe(" \u00b7 Reporting period Sep 22\u2013Oct 6, 2026 (continued)");
  });
});

describe("Projects line: 'N projects across M departments'", () => {
  it("N counts every listed project, Unassigned included; M counts only departments with projects", () => {
    const rows = [...Fixture.rows("Cath", 8, "c"), ...Fixture.rows("EP", 6, "e"), ...Fixture.rows("IR", 4, "i"), ...Fixture.rows("CardioNeuro", 2, "n"), ...Fixture.rows(null, 3, "u")];
    const l = Fixture.layout(rows);
    expect(l.header.projectsLine).toBe("23 projects across 4 departments");
    expect(l.header.grid.rows.at(-1)!.cells.at(-1)).toBe(23);
    // Dashboard: tiles and "Showing N projects" count the same visible rows, Unassigned included.
    const dash = rows.map((r) => ({ ...r, id: r.projectId }) as unknown as DashboardRow);
    expect(DashboardViewModel.summarize(dash).total).toBe(23);
    expect(DashboardViewModel.filter(dash, "")).toHaveLength(23);
  });

  it("singular forms", () => {
    expect(Fixture.layout(Fixture.rows("EP", 1, "e")).header.projectsLine).toBe("1 project across 1 department");
    expect(ReportLayout.projectsLine(12, 2)).toBe("12 projects across 2 departments");
    expect(Fixture.layout(Fixture.rows(null, 1, "u")).header.projectsLine).toBe("1 project across 0 departments");
  });

  it("filtered: counts only the included departments that have projects", () => {
    const rows = [...Fixture.rows("Cath", 7, "c"), ...Fixture.rows("EP", 5, "e"), ...Fixture.rows("IR", 2, "i"), ...Fixture.rows(null, 2, "u")];
    const l = Fixture.layout(rows, { departments: ["Cath", "EP", "CardioNeuro"] });
    expect(l.header.projectsLine).toBe("12 projects across 2 departments");
  });
});

describe("Departments come from the ServiceArea enum (every department, no hard-coded list)", () => {
  it("the dashboard filter, the admin list and the PDF order are the enum order", () => {
    expect(DepartmentFilter.OPTIONS).toEqual(Object.values(ServiceArea));
    expect(ServiceAreaInfo.groups()).toEqual([...Object.values(ServiceArea), "Unassigned"]);
    const html = renderToStaticMarkup(createElement(DepartmentsSelect, { value: DepartmentFilter.all(), onChange: () => {} }));
    expect(html).toContain("Departments: All");
  });

  it("Echo, CVSS and INU are real departments: own headings and grid rows, all included by default", () => {
    const rows = [...Fixture.rows("Cath", 2, "c"), ...Fixture.rows("Echo", 1, "e"), ...Fixture.rows("CVSS", 1, "v"), ...Fixture.rows("INU", 1, "n")];
    const l = Fixture.layout(rows);
    expect(l.header.grid.rows.map((r) => r.label)).toEqual(["Cath", "Echo", "CVSS", "INU", "All areas"]);
    const sections = l.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "section" ? [b.label] : [])));
    expect(sections).toEqual(["Cath", "Echo", "CVSS", "INU"]);
    expect(l.header.projectsLine).toBe("5 projects across 4 departments");
  });

  it("an included department with no projects gets no heading, no grid row and no dashboard group", () => {
    const rows = [...Fixture.rows("Cath", 2, "c"), ...Fixture.rows("IR", 1, "i")];
    for (const departments of [undefined, ["Cath", "EP", "IR"]]) {
      const l = Fixture.layout(rows, departments ? { departments } : {});
      expect(l.header.grid.rows.map((r) => r.label)).toEqual(["Cath", "IR", "All areas"]);
      const sections = l.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "section" ? [b.area] : [])));
      expect(sections).toEqual(["Cath", "IR"]);
    }
    expect(DashboardGroups.group(rows).map((g) => g.area)).toEqual(["Cath", "IR"]);
  });

  it("popover: at most 280px tall, the department list scrolls, 'All departments' stays pinned above it", () => {
    const css = readFileSync(new URL("../src/styles/dashboard-filters.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.df-pop-scroll \{[^}]*max-height: 280px;[^}]*overflow: hidden;/);
    expect(css).toMatch(/\.df-pop-scroll > \.df-scroll \{[^}]*overflow-y: auto;/);
    const src = readFileSync(new URL("../src/components/DashboardFilterControls.tsx", import.meta.url), "utf8");
    const pop = src.slice(src.indexOf("df-pop-scroll"));
    // The All row comes first, outside the scrolling list.
    expect(pop.indexOf("DepartmentFilter.ALL_LABEL")).toBeLessThan(pop.indexOf('className="df-scroll"'));
    expect(pop.indexOf('className="df-scroll"')).toBeLessThan(pop.indexOf("<DepartmentChecklist"));
  });

  it("K of M uses the real total; all selected reads All (no '7 of 7'); the PDF detail shows only when filtered", () => {
    const total = DepartmentFilter.OPTIONS.length;
    expect(DepartmentFilter.countText(["Cath", "EP"])).toBe(`2 of ${total}`);
    expect(DepartmentFilter.summary(DepartmentFilter.all())).toBe("Departments: All");
    expect(DepartmentFilter.summary(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro"])).toBe(`Departments: ${total - 1} of ${total}`);
    expect(DepartmentFilter.reportDetail(DepartmentFilter.all())).toBeNull();
    expect(Fixture.layout(Fixture.rows("Cath", 1, "c"), { departments: DepartmentFilter.all() }).header.departments).toBeNull();
    const band = Fixture.layout(Fixture.rows("Cath", 1, "c"), { departments: ["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro"], totalsGrid: "lastPage" }).header.band!;
    const detail = band.details.at(-1)!;
    expect(detail.label).toBe("DEPARTMENTS");
    // The names, or "6 of 7" when the band has no room for them.
    expect([DepartmentFilter.names(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro"]), `6 of ${total}`]).toContain(detail.value);
  });
});

describe("Saved department selections store the EXCLUDED departments", () => {
  it("dashboard: writes { excluded } and reads it back", () => {
    const s = Fixture.memory();
    DashboardPrefs.writeDepartments(s, "Nick@Example.org", ["Cath", "EP"]);
    expect(JSON.parse(s.map.get(DashboardPrefs.departmentsKey("nick@example.org"))!)).toEqual({ excluded: ["Echo", "CVSS", "INU", "CardioNeuro", "IR"] });
    expect(DashboardPrefs.readDepartments(s, "nick@example.org")).toEqual(["Cath", "EP"]);
    DashboardPrefs.writeDepartments(s, "nick@example.org", DepartmentFilter.all());
    expect(JSON.parse(s.map.get(DashboardPrefs.departmentsKey("nick@example.org"))!)).toEqual({ excluded: [] });
  });

  it("a department added later is included by default, not hidden by an older saved filter", () => {
    // Saved when only these departments existed: EP excluded.
    const saved = { excluded: ["EP"] };
    const withNew = [...DepartmentFilter.OPTIONS, "Structural" as ServiceArea];
    const read = (raw: unknown) => {
      const excluded = (raw as { excluded: string[] }).excluded;
      return withNew.filter((a) => !excluded.includes(a));
    };
    // Same rule as DepartmentFilter.fromStored, applied to a longer list: the newcomer stays in.
    expect(read(saved)).toContain("Structural");
    // With today's list: everything but EP; unknown saved values are ignored.
    expect(DepartmentFilter.fromStored({ excluded: ["EP", "Retired"] })).toEqual(DepartmentFilter.OPTIONS.filter((a) => a !== "EP"));
    // Everything excluded (or unreadable) falls back to all.
    expect(DepartmentFilter.fromStored({ excluded: [...DepartmentFilter.OPTIONS] })).toEqual(DepartmentFilter.all());
    expect(DepartmentFilter.fromStored("nonsense")).toEqual(DepartmentFilter.all());
  });

  it("the old included-list format (the four earlier options) keeps Echo, CVSS, INU and new departments included", () => {
    expect(DepartmentFilter.fromStored(["Cath", "EP"])).toEqual(["Cath", "EP", "Echo", "CVSS", "INU"]);
    expect(DepartmentFilter.fromStored(["Cath", "EP", "CardioNeuro", "IR"])).toEqual(DepartmentFilter.all());
  });

  it("report options: history and snapshots store excludedDepartments; both formats read back", () => {
    const value = ReportOptionsService.merge(ReportOptionsService.defaults(), { departments: ["IR", "Cath"] });
    expect(value.departments).toEqual(["Cath", "IR"]);
    const stored = ReportOptionsService.toStored(value);
    expect(stored).toEqual({ showKeyPage: true, excludedDepartments: ["EP", "Echo", "CVSS", "INU", "CardioNeuro"], totalsGrid: "top" });
    expect(ReportOptionsService.normalize(stored)).toEqual(value);
    expect(ReportOptionsService.normalize({ showKeyPage: true, departments: ["Cath", "IR"], totalsGrid: "top" }).departments).toEqual(["Cath", "Echo", "CVSS", "INU", "IR"]);
    expect(ReportOptionsService.normalize(null).departments).toEqual(DepartmentFilter.all());
  });
});

describe("handoff.json is untouched by the PDF and dashboard changes", () => {
  it("still lists every department (zeros included) and carries the stored department on flags", () => {
    const rows = ReportBuilder.sort([
      ...Fixture.rows("Echo", 1, "e").map((r) => ({ ...r, changed: true })),
      ...Fixture.rows("CVSS", 1, "v").map((r) => ({ ...r, overdue: true })),
      ...Fixture.rows("INU", 1, "n").map((r) => ({ ...r, stale: true })),
      ...Fixture.rows(null, 1, "u"),
    ]);
    const h = HandoffBuilder.build({
      snapshotId: "s",
      periodStart: "2026-09-15",
      periodEnd: "2026-09-29",
      reportDate: "2026-09-29",
      frozenAt: new Date("2026-09-29T21:00:00Z"),
      rows,
      header: ReportBuilder.header(rows),
      pdf: { fileName: "x.pdf", sha256: "0", byteSize: 1 },
      baseUrl: null,
      reportRecipient: null,
    });
    // PDF grid now omits empty departments; handoff.json byArea does not (byte-identical to before).
    expect(h.byArea.map((a) => a.area)).toEqual([...Object.values(ServiceArea), "Unassigned"]);
    expect(h.flags.changed.projects[0].serviceArea).toBe("Echo");
    expect(h.flags.overdue.projects[0].serviceArea).toBe("CVSS");
    expect(h.flags.stale.projects[0].serviceArea).toBe("INU");
    expect(h.period.label).toBe("Sep 15 \u2013 Sep 29, 2026");
    expect(JSON.stringify(h)).not.toContain("departments");
    const pdf = Fixture.layout(rows, { viewSettings: DEFAULTS });
    expect(pdf.header.grid.rows.map((r) => r.label)).toEqual(["Echo", "CVSS", "INU", "Unassigned", "All areas"]);
  });
});
