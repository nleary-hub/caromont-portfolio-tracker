import { z } from "zod";
import { ProjectStatus, ViewContext } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

/** Column keys the show/hide picker knows about. Not every context offers every column. */
export type ViewColumn =
  | "project"
  | "serviceArea"
  | "owner"
  | "physicianChampion"
  | "status"
  | "nextMilestone"
  | "due"
  | "note"
  | "flags";

/** What is stored per context (view_settings row) and frozen into each report snapshot. */
export interface ViewSettingsValue {
  /** Every column of the context, in display order (hidden ones included). */
  columnOrder: ViewColumn[];
  /** Hidden columns. Never contains a locked column. */
  hiddenColumns: ViewColumn[];
  /** Hidden statuses, in canonical status order. Rows with these statuses are not listed but still counted. */
  hiddenStatuses: ProjectStatus[];
}

export type ViewSettingsByContext = Record<ViewContext, ViewSettingsValue>;

/** A hidden status and how many projects it hides. */
export interface HiddenStatusCount {
  status: ProjectStatus;
  label: string;
  count: number;
}

/** Pure show/hide rules shared by the dashboard, the report builder and the picker. No I/O. */
export class ViewSettings {
  static readonly CONTEXTS: readonly ViewContext[] = [ViewContext.dashboard, ViewContext.report];

  /** Always shown, cannot be hidden. */
  static readonly LOCKED_COLUMNS: ReadonlySet<ViewColumn> = new Set<ViewColumn>(["project", "status"]);

  /** Default order per context. The report groups by service area, so it has no area column. */
  private static readonly DEFAULT_ORDER: Record<ViewContext, readonly ViewColumn[]> = {
    dashboard: ["project", "serviceArea", "owner", "physicianChampion", "status", "nextMilestone", "due", "note", "flags"],
    report: ["project", "owner", "physicianChampion", "status", "nextMilestone", "due", "flags", "note"],
  };

  private static readonly LABELS: Record<ViewContext, Record<ViewColumn, string>> = {
    dashboard: {
      project: "Project",
      serviceArea: "Service area",
      owner: "Owner",
      physicianChampion: "Physician champion",
      status: "Status",
      nextMilestone: "Next milestone",
      due: "Due date",
      note: "Note",
      flags: "Flags",
    },
    report: {
      project: "Project",
      serviceArea: "Service area",
      owner: "Owner",
      physicianChampion: "Physician champion (under Owner)",
      status: "Status",
      nextMilestone: "Next milestone",
      due: "Due",
      note: "Note",
      flags: "Flags",
    },
  };

  static readonly DEFAULT_HIDDEN_STATUSES: readonly ProjectStatus[] = [ProjectStatus.Complete, ProjectStatus.Cancelled];

  private static readonly RAW_SCHEMA = z.object({
    columnOrder: z.array(z.string()).optional(),
    hiddenColumns: z.array(z.string()).optional(),
    hiddenStatuses: z.array(z.string()).optional(),
  });

  static isContext(value: unknown): value is ViewContext {
    return typeof value === "string" && (ViewSettings.CONTEXTS as readonly string[]).includes(value);
  }

  /** Columns offered in a context, in default order. */
  static columns(context: ViewContext): readonly ViewColumn[] {
    return ViewSettings.DEFAULT_ORDER[context];
  }

  static columnLabel(context: ViewContext, column: ViewColumn): string {
    return ViewSettings.LABELS[context][column];
  }

  static isLocked(column: ViewColumn): boolean {
    return ViewSettings.LOCKED_COLUMNS.has(column);
  }

  static defaults(context: ViewContext): ViewSettingsValue {
    return {
      columnOrder: [...ViewSettings.DEFAULT_ORDER[context]],
      hiddenColumns: [],
      hiddenStatuses: [...ViewSettings.DEFAULT_HIDDEN_STATUSES],
    };
  }

  static isDefaultHiddenStatus(status: ProjectStatus): boolean {
    return ViewSettings.DEFAULT_HIDDEN_STATUSES.includes(status);
  }

  /**
   * Coerce anything (DB row, JSON, client input) into a valid value for the context:
   * unknown keys dropped, duplicates removed, missing columns appended in default order,
   * locked columns never hidden, statuses in canonical order. Throws on a wrong shape.
   */
  static normalize(context: ViewContext, raw: unknown): ViewSettingsValue {
    const parsed = ViewSettings.RAW_SCHEMA.parse(raw ?? {});
    const offered = ViewSettings.DEFAULT_ORDER[context];
    const isOffered = (c: string): c is ViewColumn => (offered as readonly string[]).includes(c);

    const order: ViewColumn[] = [];
    for (const c of parsed.columnOrder ?? []) if (isOffered(c) && !order.includes(c)) order.push(c);
    for (const c of offered) if (!order.includes(c)) order.push(c);

    const hiddenSet = new Set((parsed.hiddenColumns ?? []).filter(isOffered).filter((c) => !ViewSettings.isLocked(c)));
    const hiddenColumns = order.filter((c) => hiddenSet.has(c));

    const statusSet = new Set(
      parsed.hiddenStatuses === undefined ? ViewSettings.DEFAULT_HIDDEN_STATUSES : parsed.hiddenStatuses,
    );
    const hiddenStatuses = ProjectStatusInfo.all().filter((s) => statusSet.has(s));

    return { columnOrder: order, hiddenColumns, hiddenStatuses };
  }

  static equals(a: ViewSettingsValue, b: ViewSettingsValue): boolean {
    const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
    return (
      same(a.columnOrder, b.columnOrder) && same(a.hiddenColumns, b.hiddenColumns) && same(a.hiddenStatuses, b.hiddenStatuses)
    );
  }

  static isColumnVisible(value: ViewSettingsValue, column: ViewColumn): boolean {
    return ViewSettings.isLocked(column) || !value.hiddenColumns.includes(column);
  }

  /** Visible columns in display order. */
  static visibleColumns(value: ViewSettingsValue): ViewColumn[] {
    return value.columnOrder.filter((c) => ViewSettings.isColumnVisible(value, c));
  }

  static isStatusVisible(value: ViewSettingsValue, status: ProjectStatus): boolean {
    return !value.hiddenStatuses.includes(status);
  }

  /** Rows whose status is visible. Counting must happen on the unfiltered rows. */
  static listedRows<T extends { status: ProjectStatus }>(value: ViewSettingsValue, rows: readonly T[]): T[] {
    return rows.filter((r) => ViewSettings.isStatusVisible(value, r.status));
  }

  /** Number of hidden columns plus hidden statuses (the "2 hidden" badge). */
  static hiddenCount(value: ViewSettingsValue): number {
    return value.hiddenColumns.length + value.hiddenStatuses.length;
  }

  static withColumnHidden(context: ViewContext, value: ViewSettingsValue, column: ViewColumn, hidden: boolean): ViewSettingsValue {
    const rest = value.hiddenColumns.filter((c) => c !== column);
    return ViewSettings.normalize(context, { ...value, hiddenColumns: hidden ? [...rest, column] : rest });
  }

  static withStatusHidden(context: ViewContext, value: ViewSettingsValue, status: ProjectStatus, hidden: boolean): ViewSettingsValue {
    const rest = value.hiddenStatuses.filter((s) => s !== status);
    return ViewSettings.normalize(context, { ...value, hiddenStatuses: hidden ? [...rest, status] : rest });
  }

  /** Move a column to a new index in the order (clamped). */
  static withColumnMoved(context: ViewContext, value: ViewSettingsValue, column: ViewColumn, toIndex: number): ViewSettingsValue {
    const order = value.columnOrder.filter((c) => c !== column);
    const i = Math.max(0, Math.min(order.length, toIndex));
    order.splice(i, 0, column);
    return ViewSettings.normalize(context, { ...value, columnOrder: order });
  }

  /**
   * Hidden statuses that actually hide at least one project, with their counts (from counts
   * that include hidden rows), in canonical order.
   */
  static hiddenStatusCounts(value: ViewSettingsValue, counts: Readonly<Record<ProjectStatus, number>>): HiddenStatusCount[] {
    return value.hiddenStatuses
      .map((s) => ({ status: s, label: ProjectStatusInfo.label(s), count: counts[s] ?? 0 }))
      .filter((h) => h.count > 0);
  }

  /**
   * "Hidden: Complete (3), Cancelled (1)". Only hidden statuses with at least one project are
   * listed; null when nothing is actually hidden (no hidden status, or all hidden counts are 0).
   */
  static hiddenStatusLine(value: ViewSettingsValue, counts: Readonly<Record<ProjectStatus, number>>): string | null {
    const parts = ViewSettings.hiddenStatusCounts(value, counts);
    if (parts.length === 0) return null;
    return `Hidden: ${parts.map((p) => `${p.label} (${p.count})`).join(", ")}`;
  }
}
