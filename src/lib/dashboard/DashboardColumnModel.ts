import type { ViewContext } from "@/generated/prisma/enums";
import { ViewSettings, type ViewColumn, type ViewSettingsValue } from "@/lib/domain/ViewSettings";

/** A column of the grouped dashboard table. "gutter" is the reserved row-grip column; "people" stacks three fields. */
export type DashboardColumnKey = "gutter" | "project" | "serviceArea" | "people" | "status" | "nextMilestone" | "due" | "latestUpdate" | "flags";

/** Everything a renderer needs for one column. All department groups share the same list (one colgroup). */
export interface DashboardColumn {
  key: DashboardColumnKey;
  header: string;
  /** Default width in px. For the flex column this is its minimum as well. */
  width: number;
  /** Narrowest width in px (for the later resize PR). */
  minWidth: number;
  /** Absorbs the leftover width (exactly one column: Latest update). */
  flex: boolean;
  /** Stays first and cannot be moved (Project; the gutter sits left of it and is not a data column). */
  pinned: boolean;
  /** Not a data column: no header text, not offered in show/hide, never resized or moved. */
  structural: boolean;
}

/** Which of the stacked People lines are shown. */
export interface PeopleVisibility {
  owner: boolean;
  requester: boolean;
  contracts: boolean;
}

/** One row of the show/hide list: a single column, or the People group with its three fields. */
export type PickerEntry =
  | { kind: "column"; column: ViewColumn }
  | { kind: "people"; label: string; columns: readonly ViewColumn[] };

/**
 * One column model for the grouped dashboard table, driven by the dashboard view settings. Every
 * department group renders from the same columns() list, so a later resize or reorder changes one
 * saved layout and every group stays aligned. Owner, requester and contracts lead are separate view
 * settings keys (show/hide each) but render as one People column placed where the first of them sits in
 * the saved order; the column disappears when all three are hidden. Latest update is the one flex column.
 *
 * Later layout PR (resize, reorder, row grip): store widths per DashboardColumnKey next to columnOrder
 * in the dashboard view settings (normalize drops unknown keys, so older rows keep loading), clamp to
 * minWidth, and keep `flex` columns unsized so they absorb the rest. Reorder edits columnOrder (People
 * moves as its block via moveEntry) and never moves `pinned` columns. The row grip renders in the
 * `structural` gutter cell; rows carry data-row-key (project id) and reorder only inside their tbody.
 */
export class DashboardColumnModel {
  /** Reserved left gutter for the later row drag grip (px). */
  static readonly GUTTER_WIDTH = 24;

  /** The view settings keys that stack in the People cell, in PDF order (Owner, Requester, Contracts). */
  static readonly PEOPLE_FIELDS: readonly ViewColumn[] = ["owner", "physicianChampion", "contractsLead"];

  static readonly PEOPLE_LABEL = "People";

  private static readonly SPECS: Record<DashboardColumnKey, Omit<DashboardColumn, "key">> = {
    gutter: { header: "", width: DashboardColumnModel.GUTTER_WIDTH, minWidth: DashboardColumnModel.GUTTER_WIDTH, flex: false, pinned: true, structural: true },
    project: { header: "Project", width: 256, minWidth: 200, flex: false, pinned: true, structural: false },
    serviceArea: { header: "Service area", width: 120, minWidth: 96, flex: false, pinned: false, structural: false },
    people: { header: "People", width: 200, minWidth: 160, flex: false, pinned: false, structural: false },
    status: { header: "Status", width: 112, minWidth: 104, flex: false, pinned: false, structural: false },
    nextMilestone: { header: "Next milestone", width: 170, minWidth: 120, flex: false, pinned: false, structural: false },
    due: { header: "Due date", width: 84, minWidth: 72, flex: false, pinned: false, structural: false },
    latestUpdate: { header: "Latest update", width: 240, minWidth: 240, flex: true, pinned: false, structural: false },
    flags: { header: "Flags", width: 176, minWidth: 120, flex: false, pinned: false, structural: false },
  };

  static spec(key: DashboardColumnKey): DashboardColumn {
    return { key, ...DashboardColumnModel.SPECS[key] };
  }

  static isPeopleField(column: ViewColumn): boolean {
    return DashboardColumnModel.PEOPLE_FIELDS.includes(column);
  }

  static peopleVisibility(settings: ViewSettingsValue): PeopleVisibility {
    return {
      owner: ViewSettings.isColumnVisible(settings, "owner"),
      requester: ViewSettings.isColumnVisible(settings, "physicianChampion"),
      contracts: ViewSettings.isColumnVisible(settings, "contractsLead"),
    };
  }

  /**
   * Table columns in display order: the gutter, Project (always first), then the visible columns in the
   * saved order. People replaces the three people keys at the first one's position. Inline keys (the Infor
   * number) render inside the Project cell and take no column.
   */
  static columns(settings: ViewSettingsValue): DashboardColumn[] {
    const people = DashboardColumnModel.peopleVisibility(settings);
    const showPeople = people.owner || people.requester || people.contracts;
    const keys: DashboardColumnKey[] = ["gutter", "project"];
    for (const c of settings.columnOrder) {
      if (DashboardColumnModel.isPeopleField(c)) {
        if (showPeople && !keys.includes("people")) keys.push("people");
        continue;
      }
      if (c === "project" || ViewSettings.isInline(c) || !ViewSettings.isColumnVisible(settings, c)) continue;
      const key = DashboardColumnModel.tableKey(c);
      if (key && !keys.includes(key)) keys.push(key);
    }
    return keys.map((k) => DashboardColumnModel.spec(k));
  }

  /** Smallest table width that honors every column's width (the flex column at its minimum). */
  static minTableWidth(columns: readonly DashboardColumn[]): number {
    return columns.reduce((sum, c) => sum + (c.flex ? c.minWidth : c.width), 0);
  }

  /** Show/hide list entries for a context. The dashboard groups its people keys under "People"; the report stays flat. */
  static pickerEntries(context: ViewContext, value: ViewSettingsValue): PickerEntry[] {
    const entries: PickerEntry[] = [];
    for (const c of value.columnOrder) {
      if (context === "dashboard" && DashboardColumnModel.isPeopleField(c)) {
        if (!entries.some((e) => e.kind === "people")) {
          entries.push({ kind: "people", label: DashboardColumnModel.PEOPLE_LABEL, columns: DashboardColumnModel.PEOPLE_FIELDS });
        }
        continue;
      }
      entries.push({ kind: "column", column: c });
    }
    return entries;
  }

  /**
   * Move one picker entry (a column, or the People group as a block) to `toIndex` in the entry list
   * without it. With only single-column entries this is ViewSettings.withColumnMoved.
   */
  static moveEntry(context: ViewContext, value: ViewSettingsValue, fromIndex: number, toIndex: number): ViewSettingsValue {
    const entries = DashboardColumnModel.pickerEntries(context, value);
    if (fromIndex < 0 || fromIndex >= entries.length) return value;
    const [moved] = entries.splice(fromIndex, 1);
    entries.splice(Math.max(0, Math.min(entries.length, toIndex)), 0, moved);
    const columnOrder = entries.flatMap((e) => (e.kind === "people" ? [...e.columns] : [e.column]));
    return ViewSettings.normalize(context, { ...value, columnOrder });
  }

  private static tableKey(column: ViewColumn): DashboardColumnKey | null {
    switch (column) {
      case "serviceArea":
      case "status":
      case "nextMilestone":
      case "due":
      case "latestUpdate":
      case "flags":
        return column;
      default:
        return null;
    }
  }
}
