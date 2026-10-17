import { BlockerSignals } from "@/lib/projects/BlockerSignals";
import type { ProjectStatus } from "@/generated/prisma/enums";
import type { DashboardRow, DashboardMilestone } from "@/lib/dashboard/DashboardViewModel";
import { InforNumber } from "@/lib/domain/InforNumber";
import { MilestoneOwner } from "@/lib/domain/MilestoneOwner";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { PrefsLine, PrefsStorage } from "@/lib/dashboard/DashboardPrefs";

/** Header sort keys (Option A spec): Flags is not sortable. */
export type DashboardSortKey = "name" | "updated" | "owner" | "status" | "nextMilestone" | "due" | "milestoneOwner";
export type SortDir = "asc" | "desc";
/** null = "Manual order" (the line's shared order; row grips show for admins). */
export type DashboardSortState = { key: DashboardSortKey; dir: SortDir } | null;

export type DueFilterKind = "any" | "overdue" | "thisWeek" | "next30" | "none" | "custom";
export interface DueFilter {
  kind: DueFilterKind;
  /** Custom range, inclusive "YYYY-MM-DD" (either end may be open). */
  from?: string | null;
  to?: string | null;
}

/** Filters, search and sort. Kept per user and line in localStorage (DashboardQuery.read/write). */
export interface DashboardQueryState {
  due: DueFilter;
  statuses: ProjectStatus[];
  /** Project owner names; DashboardQuery.UNASSIGNED for projects without an owner. */
  projectOwners: string[];
  /** Task owner = owner of the next open milestone; DashboardQuery.UNASSIGNED for an unassigned next step. */
  taskOwners: string[];
  search: string;
  sort: DashboardSortState;
  /** 1b "Blocked" chip: only rows with at least one open blocker or dependency. */
  blocked: boolean;
}

/** One search hit: where the text matched beyond what the row shows, and the milestones that matched. */
export interface SearchHit {
  /** Matched fields the row does not show ("Description", "Accomplishment"), for "⌕ Matched in: Description". */
  hiddenFields: string[];
  milestones: DashboardMilestone[];
}

export interface OwnerOption {
  value: string;
  label: string;
  count: number;
}

/**
 * The dashboard's filters, full-text search and header sort (Nick, Oct 12, 2026; Figma Bro's Option A). Pure, so
 * the rules are tested without a browser.
 * - Filters (Due, Status, Project owner, Task owner), search and sort combine. Departments is its own filter
 *   (DepartmentFilter) and is applied before these.
 * - HARD RULE: none of this ever changes the department grouping. Groups and their order come from DashboardGroups;
 *   the comparator here only reorders rows inside a department.
 * - Sort: ascending, descending, back to manual. Empty values sort last both ways; ties keep the manual order
 *   (Array.prototype.sort is stable).
 * - "This week" is Monday to Sunday in America/New_York (`today` is the ET date).
 */
export class DashboardQuery {
  static readonly VERSION = 1;
  static readonly UNASSIGNED = "__unassigned__";
  static readonly UNASSIGNED_LABEL = "Unassigned";
  static readonly SEARCH_DEBOUNCE_MS = 200;
  static readonly MILESTONE_MATCHES_SHOWN = 3;

  /** Project status order for sorting (spec): Not started → On track → At risk → Off track → On hold → Complete → Cancelled. */
  static readonly STATUS_ORDER: readonly ProjectStatus[] = ["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold", "Complete", "Cancelled"];

  static readonly SORT_LABELS: Readonly<Record<DashboardSortKey, string>> = {
    name: "Project",
    updated: "Updated",
    owner: "Project owner",
    status: "Status",
    nextMilestone: "Next milestone",
    due: "Due",
    milestoneOwner: "Milestone owner",
  };

  static readonly DUE_LABELS: Readonly<Record<DueFilterKind, string>> = {
    any: "Any",
    overdue: "Overdue",
    thisWeek: "This week",
    next30: "Next 30 days",
    none: "No due date",
    custom: "Custom range",
  };

  static empty(): DashboardQueryState {
    return { due: { kind: "any" }, statuses: [], projectOwners: [], taskOwners: [], search: "", sort: null, blocked: false };
  }

  /** Any filter or search set (sort does not count: "Clear all" leaves the sort alone). */
  static isFiltered(q: DashboardQueryState): boolean {
    return q.due.kind !== "any" || q.statuses.length > 0 || q.projectOwners.length > 0 || q.taskOwners.length > 0 || q.search.trim() !== "" || q.blocked;
  }

  /** "Clear all": filters and search, not the sort. */
  static clearAll(q: DashboardQueryState): DashboardQueryState {
    return { ...DashboardQuery.empty(), sort: q.sort };
  }

  // ---- Sort

  /** Header click: ascending, then descending, then back to manual order. A different column starts at ascending. */
  static nextSort(current: DashboardSortState, key: DashboardSortKey): DashboardSortState {
    if (!current || current.key !== key) return { key, dir: "asc" };
    return current.dir === "asc" ? { key, dir: "desc" } : null;
  }

  static ariaSort(current: DashboardSortState, key: DashboardSortKey): "ascending" | "descending" | "none" {
    if (!current || current.key !== key) return "none";
    return current.dir === "asc" ? "ascending" : "descending";
  }

  /** "Sorted: Due ↑" chip text, or null in manual order. */
  static sortChip(current: DashboardSortState): string | null {
    return current ? `Sorted: ${DashboardQuery.SORT_LABELS[current.key]} ${current.dir === "asc" ? "↑" : "↓"}` : null;
  }

  private static text(v: string | null | undefined): string | null {
    const t = v?.trim();
    return t ? t : null;
  }

  /** The value a key sorts by; null = empty (always last). */
  static sortValue(row: DashboardRow, key: DashboardSortKey): string | number | null {
    switch (key) {
      case "name":
        return DashboardQuery.text(row.name);
      case "updated":
        return row.updatedOn ?? null;
      case "owner":
        return DashboardQuery.text(row.owner);
      case "status":
        return DashboardQuery.STATUS_ORDER.indexOf(row.status);
      case "nextMilestone":
        return MilestoneOwner.cell(row).kind === "none" && !row.nextMilestone ? null : DashboardQuery.text(row.nextMilestone);
      case "due":
        return row.dueDate ?? null;
      case "milestoneOwner": {
        const c = MilestoneOwner.cell(row);
        // Named owners, then Unassigned; rows with no open milestone count as empty.
        return c.kind === "owner" ? `0${c.name}` : c.kind === "unassigned" ? "1" : null;
      }
    }
  }

  private static cmp(a: string | number, b: string | number): number {
    if (typeof a === "number" && typeof b === "number") return a - b;
    return String(a).localeCompare(String(b), "en", { sensitivity: "base", numeric: true });
  }

  /** Comparator for DashboardGroups.group (sorts inside each department only). Undefined = manual order. */
  static comparator(sort: DashboardSortState): ((a: DashboardRow, b: DashboardRow) => number) | undefined {
    if (!sort) return undefined;
    const sign = sort.dir === "asc" ? 1 : -1;
    return (a, b) => {
      const va = DashboardQuery.sortValue(a, sort.key);
      const vb = DashboardQuery.sortValue(b, sort.key);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return sign * DashboardQuery.cmp(va, vb);
    };
  }

  // ---- Filters

  static addDays(iso: string, days: number): string {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** Monday to Sunday (America/New_York) of the week holding `today` (an ET "YYYY-MM-DD"). */
  static weekRange(today: string): { from: string; to: string } {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    const from = DashboardQuery.addDays(today, -((dow + 6) % 7));
    return { from, to: DashboardQuery.addDays(from, 6) };
  }

  static matchesDue(row: DashboardRow, due: DueFilter, today: string): boolean {
    const d = row.dueDate;
    const within = (from: string | null | undefined, to: string | null | undefined) => d !== null && (!from || d >= from) && (!to || d <= to);
    switch (due.kind) {
      case "any":
        return true;
      case "overdue":
        return row.overdue;
      case "thisWeek": {
        const w = DashboardQuery.weekRange(today);
        return within(w.from, w.to);
      }
      case "next30":
        return within(today, DashboardQuery.addDays(today, 30));
      case "none":
        return d === null;
      case "custom":
        return !due.from && !due.to ? true : within(due.from, due.to);
    }
  }

  static projectOwnerValue(row: DashboardRow): string {
    return DashboardQuery.text(row.owner) ?? DashboardQuery.UNASSIGNED;
  }

  /** The next open milestone's owner, UNASSIGNED, or null when there is no open milestone. */
  static taskOwnerValue(row: DashboardRow): string | null {
    const c = MilestoneOwner.cell(row);
    return c.kind === "owner" ? c.name : c.kind === "unassigned" ? DashboardQuery.UNASSIGNED : null;
  }

  static matchesFilters(row: DashboardRow, q: DashboardQueryState, today: string): boolean {
    if (!DashboardQuery.matchesDue(row, q.due, today)) return false;
    if (q.statuses.length && !q.statuses.includes(row.status)) return false;
    if (q.blocked && !BlockerSignals.isBlocked(row.blockers)) return false;
    if (q.projectOwners.length && !q.projectOwners.includes(DashboardQuery.projectOwnerValue(row))) return false;
    if (q.taskOwners.length) {
      const v = DashboardQuery.taskOwnerValue(row);
      if (v === null || !q.taskOwners.includes(v)) return false;
    }
    return true;
  }

  // ---- Search

  /**
   * Full-text search (case-insensitive substring): name, Infor number, department, project owner, requester,
   * contracts lead, latest update, accomplishment, description, every milestone name and owner. Null = no match.
   */
  static search(row: DashboardRow, query: string, departments: DepartmentList = ServiceAreaInfo.LEGACY): SearchHit | null {
    const q = query.trim().toLowerCase();
    if (!q) return { hiddenFields: [], milestones: [] };
    const has = (v: string | null | undefined) => Boolean(v && v.toLowerCase().includes(q));
    const visible = [
      row.name,
      InforNumber.format(row.inforRequestNumber),
      ServiceAreaInfo.fullName(ServiceAreaInfo.groupOf(row.serviceArea), departments),
      ServiceAreaInfo.label(ServiceAreaInfo.groupOf(row.serviceArea), departments),
      row.owner,
      row.physicianChampion,
      row.contractsLead,
      row.note,
      row.nextMilestone,
      row.nextMilestoneOwner,
    ].some(has);
    const hiddenFields = [
      ["Description", row.description],
      ["Accomplishment", row.accomplishment],
    ]
      .filter(([, v]) => has(v))
      .map(([label]) => label as string);
    const milestones = (row.milestones ?? []).filter((m) => has(m.name) || has(m.owner));
    if (!visible && hiddenFields.length === 0 && milestones.length === 0) return null;
    return { hiddenFields, milestones };
  }

  /** Filters then search. Order is kept (grouping and sort happen in the table). */
  static apply<R extends DashboardRow>(rows: readonly R[], q: DashboardQueryState, today: string, departments?: DepartmentList): R[] {
    return rows.filter((r) => DashboardQuery.matchesFilters(r, q, today) && DashboardQuery.search(r, q.search, departments) !== null);
  }

  // ---- Owner options (multi-select lists with counts; Unassigned pinned first)

  static ownerOptions(rows: readonly DashboardRow[], kind: "project" | "task"): OwnerOption[] {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = kind === "project" ? DashboardQuery.projectOwnerValue(r) : DashboardQuery.taskOwnerValue(r);
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const named = [...counts.entries()]
      .filter(([v]) => v !== DashboardQuery.UNASSIGNED)
      .sort(([a], [b]) => a.localeCompare(b, "en", { sensitivity: "base" }))
      .map(([v, count]) => ({ value: v, label: kind === "task" ? MilestoneOwner.short(v) : v, count }));
    const un = counts.get(DashboardQuery.UNASSIGNED);
    return un ? [{ value: DashboardQuery.UNASSIGNED, label: DashboardQuery.UNASSIGNED_LABEL, count: un }, ...named] : named;
  }

  static statusLabel(s: ProjectStatus): string {
    return ProjectStatusInfo.label(s);
  }

  /** "Showing 12 of 33 projects" (· matching "x" when searching). */
  static countLine(shown: number, total: number, search: string): string {
    const base = `Showing ${shown} of ${total} project${total === 1 ? "" : "s"}`;
    const q = search.trim();
    return q ? `${base} · matching "${q}"` : base;
  }

  /** Group heading count while filtering: "3 of 5". */
  static groupCount(shown: number, total: number): string {
    return `${shown} of ${total}`;
  }

  // ---- Persistence (localStorage, per user and line, like Departments)

  static key(email: string, line?: PrefsLine): string {
    const suffix = !line || line.isDefault ? "" : `:sl:${line.id}`;
    return `pt:v${DashboardQuery.VERSION}:dashboard:query:${email.trim().toLowerCase()}${suffix}`;
  }

  static read(storage: PrefsStorage | null, email: string, line?: PrefsLine): DashboardQueryState {
    let raw: unknown = null;
    try {
      raw = storage ? JSON.parse(storage.getItem(DashboardQuery.key(email, line)) ?? "null") : null;
    } catch {
      raw = null;
    }
    return DashboardQuery.normalize(raw);
  }

  static write(storage: PrefsStorage | null, email: string, q: DashboardQueryState, line?: PrefsLine): void {
    storage?.setItem(DashboardQuery.key(email, line), JSON.stringify(q));
  }

  static normalize(raw: unknown): DashboardQueryState {
    const out = DashboardQuery.empty();
    if (!raw || typeof raw !== "object") return out;
    const r = raw as Record<string, unknown>;
    const strings = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))] : []);
    const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const due = r.due as Record<string, unknown> | undefined;
    if (due && typeof due.kind === "string" && due.kind in DashboardQuery.DUE_LABELS) {
      out.due = due.kind === "custom" ? { kind: "custom", from: date(due.from), to: date(due.to) } : { kind: due.kind as DueFilterKind };
    }
    out.statuses = strings(r.statuses).filter((s): s is ProjectStatus => (DashboardQuery.STATUS_ORDER as readonly string[]).includes(s));
    out.projectOwners = strings(r.projectOwners);
    out.taskOwners = strings(r.taskOwners);
    out.search = typeof r.search === "string" ? r.search.slice(0, 200) : "";
    out.blocked = r.blocked === true;
    const sort = r.sort as Record<string, unknown> | null | undefined;
    if (sort && typeof sort.key === "string" && sort.key in DashboardQuery.SORT_LABELS && (sort.dir === "asc" || sort.dir === "desc")) {
      out.sort = { key: sort.key as DashboardSortKey, dir: sort.dir };
    }
    return out;
  }
}
