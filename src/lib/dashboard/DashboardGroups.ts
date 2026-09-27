import { ServiceAreaInfo, type AreaGroup, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";

/** One department section of the grouped dashboard. */
export interface DashboardGroup<R> {
  area: AreaGroup;
  /** Heading (the short name, as in the PDF: "Cath"). */
  label: string;
  /** Full name for announcements ("Moved to position 3 of 6 in Cath Lab"). */
  name: string;
  /** Unassigned renders in the secondary gray, as in the PDF. */
  muted: boolean;
  rows: R[];
  /** "8 projects" (same text as the PDF section head when it has no completed block). */
  countText: string;
}

type Grouped = { serviceArea: DepartmentKey | null };

/**
 * Groups dashboard rows by department exactly like the PDF body (ReportLayout.layout): departments in
 * ServiceAreaInfo.groups() order with Unassigned last, projects assigned with ServiceAreaInfo.groupOf, and a
 * department without rows left out. Rows keep their incoming order (report order from ReportBuilder.sortProjects)
 * unless a comparator is given; a comparator sorts within each group and never mixes groups. Neither the dashboard
 * nor the PDF has a separate "Completed this period" block: completed projects are rows in their group. The
 * Completed and Cancelled pages group their rows with this too.
 */
export class DashboardGroups {
  static group<R extends Grouped>(
    rows: readonly R[],
    compare?: (a: R, b: R) => number,
    list: DepartmentList = ServiceAreaInfo.LEGACY,
  ): DashboardGroup<R>[] {
    const groups: DashboardGroup<R>[] = [];
    for (const area of ServiceAreaInfo.groups(list, rows.map((r) => r.serviceArea))) {
      const inArea = rows.filter((r) => ServiceAreaInfo.groupOf(r.serviceArea) === area);
      if (inArea.length === 0) continue;
      groups.push({
        area,
        label: ServiceAreaInfo.label(area, list),
        name: ServiceAreaInfo.fullName(area, list),
        muted: area === ServiceAreaInfo.UNASSIGNED,
        rows: compare ? [...inArea].sort(compare) : inArea,
        countText: DashboardGroups.countText(inArea.length),
      });
    }
    return groups;
  }

  /**
   * Section count text: "1 project", "8 projects". Same output as ReportLayout.sectionCountText(count, 0) (tests
   * assert they agree); that one lives in the PDF layout module, which loads font files and cannot ship to the browser.
   */
  static countText(count: number): string {
    return `${count} project${count === 1 ? "" : "s"}`;
  }
}
