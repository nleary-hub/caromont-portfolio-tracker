import type { ViewContext } from "@/generated/prisma/enums";
import { ViewSettings, type ViewColumn, type ViewSettingsValue } from "@/lib/domain/ViewSettings";

/**
 * A column of the grouped dashboard table. "gutter" is the reserved row-grip column; the three stacked
 * columns ("people", "milestoneUpdate", "dueFlags") each render several view settings keys in one cell.
 */
export type DashboardColumnKey = "gutter" | "project" | "people" | "status" | "milestoneUpdate" | "dueFlags";

/** A stacked column and the view settings keys it renders, in stacking order. */
export type StackKey = "people" | "milestoneUpdate" | "dueFlags";

/** Everything a renderer needs for one column. All department groups share the same list (one colgroup). */
export interface DashboardColumn {
  key: DashboardColumnKey;
  header: string;
  /** Default width in px. For the flex column this is its minimum as well. */
  width: number;
  /** Narrowest width in px (for the later resize PR). */
  minWidth: number;
  /** Absorbs the leftover width. Exactly one column per layout (see columns()). */
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

/** Which lines of the Next milestone / Latest update cell are shown. */
export interface MilestoneUpdateVisibility {
  milestone: boolean;
  update: boolean;
}

/** Which parts of the Due / Flags cell are shown. */
export interface DueFlagsVisibility {
  due: boolean;
  flags: boolean;
}

/** One row of the show/hide list: a single column, or a stacked group with its fields under a subheading. */
export type PickerEntry =
  | { kind: "column"; column: ViewColumn }
  | { kind: "group"; stack: StackKey; label: string; columns: readonly ViewColumn[] };

/**
 * One column model for the grouped dashboard table, driven by the dashboard view settings. Every
 * department group renders from the same columns() list, so a later resize or reorder changes one saved
 * layout and every group stays aligned.
 *
 * Like the PDF, several view settings keys share a cell: People (owner, requester, contracts lead),
 * Next milestone / Latest update, and Due / Flags. Each key still hides on its own (its line or part
 * drops); a stacked column appears where the first of its keys sits in the saved order and disappears
 * when all of its keys are hidden. Next milestone / Latest update is the flexible column; when it is gone
 * the flexible role moves to People, else to Project.
 *
 * Later layout PR (resize, reorder, row grip): store widths per DashboardColumnKey next to columnOrder
 * in the dashboard view settings (normalize drops unknown keys, so older rows keep loading), clamp to
 * minWidth, and leave the `flex` column unsized so it absorbs the rest (FLEX_PREFERENCE decides which).
 * Reorder edits columnOrder: a stacked group moves as one block via moveEntry, and `pinned` columns never
 * move. The row grip renders in the `structural` gutter cell; rows carry data-row-key (project id) and
 * reorder only inside their department tbody.
 */
export class DashboardColumnModel {
  /** Reserved left gutter for the later row drag grip (px). */
  static readonly GUTTER_WIDTH = 24;

  /** Stacked columns and their keys, in the PDF's stacking order. */
  static readonly STACKS: Readonly<Record<StackKey, readonly ViewColumn[]>> = {
    people: ["owner", "physicianChampion", "contractsLead"],
    milestoneUpdate: ["nextMilestone", "latestUpdate"],
    dueFlags: ["due", "flags"],
  };

  /** Show/hide subheadings for the stacked groups. */
  static readonly STACK_LABELS: Readonly<Record<StackKey, string>> = {
    people: "People",
    milestoneUpdate: "Next milestone / Latest update",
    dueFlags: "Due / Flags",
  };

  /** The People keys, in PDF order (Owner, Requester, Contracts). */
  static readonly PEOPLE_FIELDS: readonly ViewColumn[] = DashboardColumnModel.STACKS.people;

  static readonly PEOPLE_LABEL = DashboardColumnModel.STACK_LABELS.people;

  /** Which visible column absorbs the leftover width, first match wins (Project is always visible). */
  static readonly FLEX_PREFERENCE: readonly DashboardColumnKey[] = ["milestoneUpdate", "people", "project"];

  private static readonly SPECS: Record<DashboardColumnKey, Omit<DashboardColumn, "key" | "flex">> = {
    gutter: { header: "", width: DashboardColumnModel.GUTTER_WIDTH, minWidth: DashboardColumnModel.GUTTER_WIDTH, pinned: true, structural: true },
    project: { header: "Project", width: 256, minWidth: 200, pinned: true, structural: false },
    people: { header: "People", width: 200, minWidth: 160, pinned: false, structural: false },
    status: { header: "Status", width: 112, minWidth: 104, pinned: false, structural: false },
    milestoneUpdate: { header: "Next milestone / Latest update", width: 280, minWidth: 280, pinned: false, structural: false },
    dueFlags: { header: "Due / Flags", width: 150, minWidth: 120, pinned: false, structural: false },
  };

  /** Column spec with its default flex role (only Next milestone / Latest update). */
  static spec(key: DashboardColumnKey): DashboardColumn {
    return { key, ...DashboardColumnModel.SPECS[key], flex: key === DashboardColumnModel.FLEX_PREFERENCE[0] };
  }

  static stackOf(column: ViewColumn): StackKey | null {
    for (const [stack, keys] of Object.entries(DashboardColumnModel.STACKS) as [StackKey, readonly ViewColumn[]][]) {
      if (keys.includes(column)) return stack;
    }
    return null;
  }

  static isPeopleField(column: ViewColumn): boolean {
    return DashboardColumnModel.stackOf(column) === "people";
  }

  static peopleVisibility(settings: ViewSettingsValue): PeopleVisibility {
    return {
      owner: ViewSettings.isColumnVisible(settings, "owner"),
      requester: ViewSettings.isColumnVisible(settings, "physicianChampion"),
      contracts: ViewSettings.isColumnVisible(settings, "contractsLead"),
    };
  }

  static milestoneUpdateVisibility(settings: ViewSettingsValue): MilestoneUpdateVisibility {
    return { milestone: ViewSettings.isColumnVisible(settings, "nextMilestone"), update: ViewSettings.isColumnVisible(settings, "latestUpdate") };
  }

  static dueFlagsVisibility(settings: ViewSettingsValue): DueFlagsVisibility {
    return { due: ViewSettings.isColumnVisible(settings, "due"), flags: ViewSettings.isColumnVisible(settings, "flags") };
  }

  /**
   * Table columns in display order: the gutter, Project (always first), then the visible columns in the
   * saved order. A stacked column takes the first of its keys' positions and is left out when all of its
   * keys are hidden. Inline keys (the Infor number) render inside the Project cell and take no column.
   * Keys the dashboard no longer offers never reach here (normalize drops them).
   */
  static columns(settings: ViewSettingsValue): DashboardColumn[] {
    const keys: DashboardColumnKey[] = ["gutter", "project"];
    for (const c of settings.columnOrder) {
      const stack = DashboardColumnModel.stackOf(c);
      if (stack) {
        const anyVisible = DashboardColumnModel.STACKS[stack].some((k) => ViewSettings.isColumnVisible(settings, k));
        if (anyVisible && !keys.includes(stack)) keys.push(stack);
        continue;
      }
      if (c === "status" && ViewSettings.isColumnVisible(settings, c) && !keys.includes("status")) keys.push("status");
    }
    const flexKey = DashboardColumnModel.FLEX_PREFERENCE.find((k) => keys.includes(k));
    return keys.map((k) => ({ ...DashboardColumnModel.spec(k), flex: k === flexKey }));
  }

  /** Smallest table width that honors every column's width (the flex column at its minimum). */
  static minTableWidth(columns: readonly DashboardColumn[]): number {
    return columns.reduce((sum, c) => sum + (c.flex ? c.minWidth : c.width), 0);
  }

  /** Show/hide list entries for a context. The dashboard groups its stacked keys under subheadings; the report stays flat. */
  static pickerEntries(context: ViewContext, value: ViewSettingsValue): PickerEntry[] {
    const entries: PickerEntry[] = [];
    for (const c of value.columnOrder) {
      const stack = context === "dashboard" ? DashboardColumnModel.stackOf(c) : null;
      if (stack) {
        if (!entries.some((e) => e.kind === "group" && e.stack === stack)) {
          entries.push({ kind: "group", stack, label: DashboardColumnModel.STACK_LABELS[stack], columns: DashboardColumnModel.STACKS[stack] });
        }
        continue;
      }
      entries.push({ kind: "column", column: c });
    }
    return entries;
  }

  /**
   * Move one picker entry (a column, or a stacked group as a block) to `toIndex` in the entry list
   * without it. With only single-column entries this is ViewSettings.withColumnMoved.
   */
  static moveEntry(context: ViewContext, value: ViewSettingsValue, fromIndex: number, toIndex: number): ViewSettingsValue {
    const entries = DashboardColumnModel.pickerEntries(context, value);
    if (fromIndex < 0 || fromIndex >= entries.length) return value;
    const [moved] = entries.splice(fromIndex, 1);
    entries.splice(Math.max(0, Math.min(entries.length, toIndex)), 0, moved);
    const columnOrder = entries.flatMap((e) => (e.kind === "group" ? [...e.columns] : [e.column]));
    return ViewSettings.normalize(context, { ...value, columnOrder });
  }
}
