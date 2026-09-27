import { ServiceAreaInfo, type AreaGroup, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";

/** One department section of the grouped dashboard. */
export interface DashboardGroup<R, C> {
  area: AreaGroup;
  /** Heading (the short name, as in the PDF: "Cath"). */
  label: string;
  /** Full name for announcements ("Moved to position 3 of 6 in Cath Lab"). */
  name: string;
  /** Unassigned renders in the secondary gray, as in the PDF. */
  muted: boolean;
  rows: R[];
  /** This department's "Completed this period" rows (block at the end of the group). */
  completed: C[];
  /** "8 projects", or "8 projects · 2 completed this period" (same text as the PDF section head). */
  countText: string;
}

type Grouped = { serviceArea: DepartmentKey | null };

/**
 * Groups dashboard rows by department exactly like the PDF body (ReportLayout.layout): departments in
 * ServiceAreaInfo.groups() order with Unassigned last, projects assigned with ServiceAreaInfo.groupOf, a
 * department with neither rows nor completed rows left out, and the completed rows as a block at the end
 * of their own group. Rows keep their incoming order (report order from ReportBuilder.sortProjects)
 * unless a comparator is given; a comparator sorts within each group and never mixes groups.
 */
export class DashboardGroups {
  static group<R extends Grouped, C extends Grouped>(
    rows: readonly R[],
    completed: readonly C[] = [],
    compare?: (a: R, b: R) => number,
    list: DepartmentList = ServiceAreaInfo.LEGACY,
  ): DashboardGroup<R, C>[] {
    const groups: DashboardGroup<R, C>[] = [];
    for (const area of ServiceAreaInfo.groups(list, [...rows, ...completed].map((r) => r.serviceArea))) {
      const inArea = rows.filter((r) => ServiceAreaInfo.groupOf(r.serviceArea) === area);
      const done = completed.filter((c) => ServiceAreaInfo.groupOf(c.serviceArea) === area);
      if (inArea.length === 0 && done.length === 0) continue;
      groups.push({
        area,
        label: ServiceAreaInfo.label(area, list),
        name: ServiceAreaInfo.fullName(area, list),
        muted: area === ServiceAreaInfo.UNASSIGNED,
        rows: compare ? [...inArea].sort(compare) : inArea,
        completed: done,
        countText: DashboardGroups.countText(inArea.length, done.length),
      });
    }
    return groups;
  }

  /**
   * Section count text. Same output as ReportLayout.sectionCountText (tests assert they agree); that one
   * lives in the PDF layout module, which loads font files and cannot ship to the browser.
   */
  static countText(count: number, completedCount: number): string {
    const projects = `${count} project${count === 1 ? "" : "s"}`;
    if (completedCount === 0) return projects;
    const completed = `${completedCount} completed this period`;
    return count === 0 ? completed : `${projects} \u00b7 ${completed}`;
  }
}

/**
 * Copy and limits of the "Completed this period" block, matching CompletedBlockStyle in the PDF layout
 * (tests assert they agree; that module loads font files and cannot ship to the browser).
 */
export class CompletedBlockCopy {
  static readonly HEADING = "COMPLETED THIS PERIOD";
  static readonly NOTE = "Shown once, then moves to the Completed section";
  static readonly ACCOMPLISHMENT_MAX_LINES = 2;
}
