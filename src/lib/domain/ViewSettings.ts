import { z } from "zod";
import { ProjectStatus, ViewContext } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

/** Column keys the show/hide picker knows about. Not every context offers every column. */
export type ViewColumn =
  | "project"
  | "inforNumber"
  | "serviceArea"
  | "owner"
  | "physicianChampion"
  | "contractsLead"
  | "status"
  | "nextMilestone"
  | "due"
  | "note"
  | "latestUpdate"
  | "flags";

/** What is stored per context (view_settings row) and frozen into each report snapshot. */
export interface ViewSettingsValue {
  /** Every column of the context, in display order (hidden ones included). */
  columnOrder: ViewColumn[];
  /** Hidden columns. Never contains a locked column. */
  hiddenColumns: ViewColumn[];
  /** Hidden statuses, in canonical status order. Projects with these statuses are invisible in the context and excluded from all counts (see VisibilityPolicy). */
  hiddenStatuses: ProjectStatus[];
}

export type ViewSettingsByContext = Record<ViewContext, ViewSettingsValue>;

/** Pure show/hide rules shared by the dashboard, the report builder and the picker. No I/O. */
export class ViewSettings {
  static readonly CONTEXTS: readonly ViewContext[] = [ViewContext.dashboard, ViewContext.report];

  /** Always shown, cannot be hidden. */
  static readonly LOCKED_COLUMNS: ReadonlySet<ViewColumn> = new Set<ViewColumn>(["project", "status"]);

  /**
   * Inline columns render inside another cell instead of taking a table column of their own:
   * the Infor request number sits in a fixed slot on the small meta line under the project name ("REQ-5081  Updated Sep 24").
   * the Contracts lead is a small line under owner and requester ("Contracts Shea Waldron").
   * Hiding one removes only that piece; its position in the order has no effect.
   */
  static readonly INLINE_COLUMNS: ReadonlySet<ViewColumn> = new Set<ViewColumn>(["inforNumber", "contractsLead"]);

  /** Default order per context. The report groups by service area, so it has no area column. */
  private static readonly DEFAULT_ORDER: Record<ViewContext, readonly ViewColumn[]> = {
    // inforNumber is inline (meta line under Project), so its place in the order does not matter. It is
    // last so saved settings from before it existed (normalize appends missing columns) match the defaults.
    // The dashboard shows the note as "Latest update" (key latestUpdate; saved views that still say
    // "note" are read as latestUpdate, see LEGACY_COLUMNS). Like the PDF it stacks fields into shared
    // cells placed where the first of their keys sits in the order (DashboardColumnModel): People (owner,
    // requester, contracts lead), Next milestone / Latest update, and Due / Flags. It has no department
    // column (the group header names the department), so a saved "serviceArea" is dropped on read.
    dashboard: ["project", "owner", "physicianChampion", "status", "nextMilestone", "due", "latestUpdate", "flags", "inforNumber", "contractsLead"],
    report: ["project", "owner", "physicianChampion", "status", "nextMilestone", "due", "flags", "note", "inforNumber", "contractsLead"],
  };

  private static readonly LABELS: Record<ViewContext, Record<ViewColumn, string>> = {
    dashboard: {
      project: "Project",
      inforNumber: "Infor request # (REQ-, under Project)",
      serviceArea: "Service area",
      owner: "Owner",
      physicianChampion: "Requester",
      contractsLead: "Contracts lead",
      status: "Status",
      nextMilestone: "Next milestone",
      due: "Due date",
      note: "Note",
      latestUpdate: "Latest update",
      flags: "Flags",
    },
    report: {
      project: "Project",
      inforNumber: "Infor request # (REQ-, under Project)",
      serviceArea: "Service area",
      owner: "Owner",
      physicianChampion: "Requester (under Owner)",
      contractsLead: "Contracts lead (under Owner and Requester)",
      status: "Status",
      nextMilestone: "Next milestone",
      due: "Due",
      note: "Note",
      latestUpdate: "Latest update",
      flags: "Flags",
    },
  };

  /**
   * Keys renamed in a context, read from saved settings as their new key (no migration: stored rows are
   * rewritten in the new shape the next time they are saved). The dashboard "note" column became
   * "latestUpdate", so a saved view that hid the note hides Latest update and keeps its position.
   * Keys a context no longer offers (the dashboard "serviceArea") are simply dropped by normalize.
   */
  private static readonly LEGACY_COLUMNS: Record<ViewContext, Readonly<Record<string, ViewColumn>>> = {
    dashboard: { note: "latestUpdate" },
    report: {},
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

  static isInline(column: ViewColumn): boolean {
    return ViewSettings.INLINE_COLUMNS.has(column);
  }

  /** Visible columns that take a table column of their own (inline columns excluded), in display order. */
  static tableColumns(value: ViewSettingsValue): ViewColumn[] {
    return ViewSettings.visibleColumns(value).filter((c) => !ViewSettings.isInline(c));
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
    const legacy = ViewSettings.LEGACY_COLUMNS[context];
    const current = (c: string): string => legacy[c] ?? c;

    const order: ViewColumn[] = [];
    for (const raw of parsed.columnOrder ?? []) {
      const c = current(raw);
      if (isOffered(c) && !order.includes(c)) order.push(c);
    }
    for (const c of offered) if (!order.includes(c)) order.push(c);

    const hiddenSet = new Set((parsed.hiddenColumns ?? []).map(current).filter(isOffered).filter((c) => !ViewSettings.isLocked(c)));
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

  /** Rows whose status is visible. Prefer VisibilityPolicy.visibleProjects, which applies every rule. */
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
}
