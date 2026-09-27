import type { ViewContext } from "@/generated/prisma/enums";
import { ServiceAreaInfo, type AreaGroup } from "@/lib/domain/ServiceAreaInfo";
import type { ViewColumn, ViewSettingsValue } from "@/lib/domain/ViewSettings";

/** A resizable, movable table column (the dashboard's data columns; the PDF maps each onto its own columns). */
export type LayoutKey = "project" | "people" | "status" | "milestoneUpdate" | "dueFlags";

/** Column order and widths of one line. Shares are fractions of the table width (never pixels). */
export interface ColumnLayoutValue {
  /** Every LayoutKey once, Project first. */
  order: LayoutKey[];
  /** Share of the table width per column (sum 1), or null for the default widths (order-only change). */
  shares: Record<LayoutKey, number> | null;
}

/** Manual row order per department group: project ids, top to bottom. A department without a list keeps the report order. */
export type RowOrderValue = Partial<Record<AreaGroup, string[]>>;

/** What is stored per service line (line_layout) and frozen into each snapshot (layoutJson). */
export interface LineLayoutValue {
  /** Null = default widths and order (today's dashboard and PDF columns). */
  columns: ColumnLayoutValue | null;
  rows: RowOrderValue;
}

/**
 * Pure rules for the per-line layout. No I/O, safe in the browser. The default value (no row, or a snapshot from
 * before migration 0017) means today's columns and today's report order, and every renderer takes its old code
 * path for it, so the default dashboard and PDF are unchanged.
 */
export class LineLayout {
  static readonly KEYS: readonly LayoutKey[] = ["project", "people", "status", "milestoneUpdate", "dueFlags"];
  static readonly PINNED: LayoutKey = "project";

  /** Header names (the announcement text: "Next milestone moved to column 3 of 6."). */
  static readonly LABELS: Readonly<Record<LayoutKey, string>> = {
    project: "Project",
    people: "People",
    status: "Status",
    milestoneUpdate: "Next milestone",
    dueFlags: "Due / Flags",
  };

  /** View settings keys each layout column stands for, per context (a column moves with all of its keys). */
  static readonly MEMBERS: Readonly<Record<ViewContext, Readonly<Record<LayoutKey, readonly ViewColumn[]>>>> = {
    dashboard: {
      project: ["project"],
      people: ["owner", "physicianChampion", "contractsLead"],
      status: ["status"],
      milestoneUpdate: ["nextMilestone", "latestUpdate", "note"],
      dueFlags: ["due", "flags"],
    },
    report: {
      project: ["project"],
      people: ["owner", "physicianChampion", "contractsLead"],
      status: ["status"],
      milestoneUpdate: ["nextMilestone", "note"],
      dueFlags: ["due", "flags"],
    },
  };

  static defaults(): LineLayoutValue {
    return { columns: null, rows: {} };
  }

  static isKey(k: unknown): k is LayoutKey {
    return typeof k === "string" && (LineLayout.KEYS as readonly string[]).includes(k);
  }

  /** Any order to a valid one: known keys once, missing keys appended in default order, Project first. */
  static normalizeOrder(raw: unknown): LayoutKey[] {
    const seen: LayoutKey[] = [];
    if (Array.isArray(raw)) for (const k of raw) if (LineLayout.isKey(k) && !seen.includes(k)) seen.push(k);
    for (const k of LineLayout.KEYS) if (!seen.includes(k)) seen.push(k);
    return [LineLayout.PINNED, ...seen.filter((k) => k !== LineLayout.PINNED)];
  }

  /** Positive finite shares for every key, scaled to sum 1; anything else is null (default widths). */
  static normalizeShares(raw: unknown): Record<LayoutKey, number> | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const values = LineLayout.KEYS.map((k) => r[k]);
    if (!values.every((v) => typeof v === "number" && Number.isFinite(v) && v > 0)) return null;
    const sum = (values as number[]).reduce((a, b) => a + b, 0);
    return Object.fromEntries(LineLayout.KEYS.map((k, i) => [k, (values[i] as number) / sum])) as Record<LayoutKey, number>;
  }

  static normalizeColumns(raw: unknown): ColumnLayoutValue | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as { order?: unknown; shares?: unknown };
    return { order: LineLayout.normalizeOrder(r.order), shares: LineLayout.normalizeShares(r.shares) };
  }

  static normalizeRows(raw: unknown): RowOrderValue {
    const out: RowOrderValue = {};
    if (!raw || typeof raw !== "object") return out;
    const groups = ServiceAreaInfo.groups() as readonly string[];
    for (const [area, ids] of Object.entries(raw as Record<string, unknown>)) {
      if (!groups.includes(area) || !Array.isArray(ids)) continue;
      const list = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
      if (list.length) out[area as AreaGroup] = list;
    }
    return out;
  }

  /** Anything (DB row, frozen JSON, null) to a full value. */
  static normalize(raw: unknown): LineLayoutValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as { columns?: unknown; rows?: unknown };
    // Default columns (default order, no shares) read as null: one canonical form for "today's columns".
    const columns = LineLayout.normalizeColumns(r.columns);
    return { columns: LineLayout.isDefaultColumns(columns) ? null : columns, rows: LineLayout.normalizeRows(r.rows) };
  }

  static isDefaultOrder(order: readonly LayoutKey[]): boolean {
    return order.every((k, i) => k === LineLayout.KEYS[i]);
  }

  /** Columns that render exactly like today (no layout, or the default order with default widths). */
  static isDefaultColumns(columns: ColumnLayoutValue | null): boolean {
    return !columns || (columns.shares === null && LineLayout.isDefaultOrder(columns.order));
  }

  static isDefault(value: LineLayoutValue | null | undefined): boolean {
    return !value || (LineLayout.isDefaultColumns(value.columns) && Object.keys(value.rows).length === 0);
  }

  static equalColumns(a: ColumnLayoutValue | null, b: ColumnLayoutValue | null): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Move a column to `toIndex` (0-based in `order`). Project never moves and nothing goes before it.
   * Returns the order unchanged when the move is not allowed.
   */
  static moveColumn(order: readonly LayoutKey[], key: LayoutKey, toIndex: number): LayoutKey[] {
    if (key === LineLayout.PINNED) return [...order];
    const rest = order.filter((k) => k !== key);
    const at = Math.max(1, Math.min(rest.length, toIndex));
    rest.splice(at, 0, key);
    return rest;
  }

  /**
   * Move `key` to position `toIndex` among the shown columns (`visible`, in display order; hidden columns keep
   * their places in `order`). Project stays first. Returns the full new order.
   */
  static moveVisible(order: readonly LayoutKey[], visible: readonly LayoutKey[], key: LayoutKey, toIndex: number): LayoutKey[] {
    if (key === LineLayout.PINNED || !visible.includes(key)) return [...order];
    const others = visible.filter((k) => k !== key);
    const at = Math.max(1, Math.min(others.length, toIndex));
    const before = others[at] ?? null;
    const rest = order.filter((k) => k !== key);
    const i = before ? rest.indexOf(before) : rest.indexOf(others[others.length - 1]) + 1;
    rest.splice(i, 0, key);
    return LineLayout.normalizeOrder(rest);
  }

  /**
   * View settings with columnOrder rearranged so the table columns follow `order` (each layout column's keys
   * stay together in their saved relative order). Keys no layout column owns (the inline Infor number) keep
   * their relative order at the end. Visibility is untouched.
   */
  static orderedSettings(context: ViewContext, settings: ViewSettingsValue, order: readonly LayoutKey[]): ViewSettingsValue {
    const members = LineLayout.MEMBERS[context];
    const placed = new Set<ViewColumn>();
    const columnOrder: ViewColumn[] = [];
    for (const key of order) {
      for (const c of settings.columnOrder) {
        if (members[key].includes(c) && !placed.has(c)) {
          columnOrder.push(c);
          placed.add(c);
        }
      }
    }
    for (const c of settings.columnOrder) if (!placed.has(c)) columnOrder.push(c);
    return { ...settings, columnOrder };
  }

  /** The layout order a view settings column order implies (a layout column sits where its first key is). */
  static orderFromSettings(context: ViewContext, settings: ViewSettingsValue): LayoutKey[] {
    const members = LineLayout.MEMBERS[context];
    const order: LayoutKey[] = [];
    for (const c of settings.columnOrder) {
      const key = LineLayout.KEYS.find((k) => members[k].includes(c));
      if (key && !order.includes(key)) order.push(key);
    }
    return LineLayout.normalizeOrder(order);
  }
}

/** One column for width math: its current width and its minimum, in any unit (px on screen, inches in the PDF). */
export interface WidthItem<K extends string = string> {
  key: K;
  width: number;
  min: number;
}

/**
 * Minimum enforcement shared by the dashboard and the PDF: columns below their minimum are raised to it and the
 * width is taken back from the widest column first (water fill: the widest shrinks until it meets the next widest,
 * then both shrink together, never below their own minimums). The total stays the same.
 */
export class WidthFit {
  static readonly EPS = 1e-9;

  static enforce<K extends string>(items: readonly WidthItem<K>[], total: number): WidthItem<K>[] {
    if (items.length === 0) return [];
    const minSum = items.reduce((s, i) => s + i.min, 0);
    if (minSum >= total - WidthFit.EPS) return items.map((i) => ({ ...i, width: i.min }));
    const sum = items.reduce((s, i) => s + i.width, 0);
    const scale = sum > 0 ? total / sum : 0;
    const out = items.map((i) => ({ ...i, width: sum > 0 ? i.width * scale : total / items.length }));
    let deficit = 0;
    for (const i of out) {
      if (i.width < i.min) {
        deficit += i.min - i.width;
        i.width = i.min;
      }
    }
    WidthFit.takeWidestFirst(out, deficit);
    return out;
  }

  /** Take `amount` from the widest columns first, never below their minimums. Mutates `items`; returns what could not be taken. */
  static takeWidestFirst<K extends string>(items: WidthItem<K>[], amount: number, exclude: ReadonlySet<K> = new Set()): number {
    let left = amount;
    while (left > WidthFit.EPS) {
      const donors = items.filter((i) => !exclude.has(i.key) && i.width - i.min > WidthFit.EPS);
      if (donors.length === 0) break;
      const maxW = Math.max(...donors.map((d) => d.width));
      const top = donors.filter((d) => maxW - d.width <= WidthFit.EPS);
      const lower = donors.filter((d) => maxW - d.width > WidthFit.EPS).map((d) => d.width);
      const nextW = lower.length ? Math.max(...lower) : Number.NEGATIVE_INFINITY;
      const cut = Math.min(maxW - nextW, ...top.map((t) => t.width - t.min), left / top.length);
      for (const t of top) t.width -= cut;
      left -= cut * top.length;
    }
    return Math.max(0, left);
  }
}

/**
 * Share math of the dashboard table: shares of the table width in, pixel widths out, and the two admin gestures
 * (drag a header edge, double-click to fit). Pixel widths exist only on screen; what is saved is always shares.
 */
export class ColumnShares {
  /** Dashboard minimums in px (Due / Flags keeps today's width so the 2x2 grid and the three chip slots fit). */
  static readonly MIN_PX: Readonly<Record<LayoutKey, number>> = {
    project: 200,
    people: 140,
    status: 110,
    milestoneUpdate: 240,
    dueFlags: 188,
  };

  /** Which visible column takes spare width when a fit makes a column narrower (same preference as the flex column). */
  static readonly SPARE_PREFERENCE: readonly LayoutKey[] = ["milestoneUpdate", "people", "project"];

  /** Pixel widths to shares (sum 1) for the given columns; columns not listed keep `previous` shares, scaled. */
  static toShares(widths: Partial<Record<LayoutKey, number>>, previous: Record<LayoutKey, number> | null = null): Record<LayoutKey, number> {
    const listed = LineLayout.KEYS.filter((k) => typeof widths[k] === "number" && (widths[k] as number) > 0);
    const listedSum = listed.reduce((s, k) => s + (widths[k] as number), 0);
    const unlisted = LineLayout.KEYS.filter((k) => !listed.includes(k));
    // Hidden columns keep their old share relative to the visible ones (or the default px ratio when there is none).
    const base = previous ?? ColumnShares.defaultShares();
    const visibleBase = listed.reduce((s, k) => s + base[k], 0) || 1;
    const raw: Record<string, number> = {};
    for (const k of listed) raw[k] = (widths[k] as number) / listedSum;
    for (const k of unlisted) raw[k] = base[k] / visibleBase;
    const sum = Object.values(raw).reduce((a, b) => a + b, 0);
    return Object.fromEntries(LineLayout.KEYS.map((k) => [k, raw[k] / sum])) as Record<LayoutKey, number>;
  }

  /** Default widths as shares (Next milestone / Latest update at its 280px minimum), for hidden columns without a saved share. */
  static defaultShares(): Record<LayoutKey, number> {
    const px: Record<LayoutKey, number> = { project: 256, people: 200, status: 112, milestoneUpdate: 280, dueFlags: 188 };
    const sum = Object.values(px).reduce((a, b) => a + b, 0);
    return Object.fromEntries(LineLayout.KEYS.map((k) => [k, px[k] / sum])) as Record<LayoutKey, number>;
  }

  /** Shares to pixel widths for the visible columns (shares renormalized over them), minimums enforced widest first. */
  static toPixels(visible: readonly LayoutKey[], shares: Record<LayoutKey, number>, total: number): Record<LayoutKey, number> {
    const sum = visible.reduce((s, k) => s + shares[k], 0) || 1;
    const fitted = WidthFit.enforce(
      visible.map((k) => ({ key: k, width: (shares[k] / sum) * total, min: ColumnShares.MIN_PX[k] })),
      total,
    );
    return Object.fromEntries(fitted.map((i) => [i.key, i.width])) as Record<LayoutKey, number>;
  }

  /**
   * Drag the right edge of `key` by `delta` px: the column grows or shrinks and its right neighbor (the left one
   * for the last column) gives or takes the same amount, so the table width stays put. Neither goes below its minimum.
   */
  static resize(visible: readonly LayoutKey[], widths: Record<LayoutKey, number>, key: LayoutKey, delta: number): Record<LayoutKey, number> {
    const i = visible.indexOf(key);
    if (i < 0) return { ...widths };
    const nb = visible[i + 1] ?? visible[i - 1];
    if (!nb) return { ...widths };
    const min = ColumnShares.MIN_PX;
    const lo = min[key] - widths[key];
    const hi = widths[nb] - min[nb];
    const d = Math.max(Math.min(delta, hi), Math.min(lo, 0));
    return { ...widths, [key]: widths[key] + d, [nb]: widths[nb] - d };
  }

  /**
   * Double-click: fit `key` to its widest cell (`content` px, padding included), never below its minimum. Width
   * it gains is taken widest first from the others (down to their minimums); width it frees goes to the column
   * that absorbs spare width (Next milestone / Latest update, else People, else Project).
   */
  static fit(visible: readonly LayoutKey[], widths: Record<LayoutKey, number>, key: LayoutKey, content: number): Record<LayoutKey, number> {
    const items: WidthItem<LayoutKey>[] = visible.map((k) => ({ key: k, width: widths[k], min: ColumnShares.MIN_PX[k] }));
    const self = items.find((it) => it.key === key);
    if (!self) return { ...widths };
    const target = Math.max(ColumnShares.MIN_PX[key], content);
    const diff = target - self.width;
    if (diff > 0) {
      const short = WidthFit.takeWidestFirst(items, diff, new Set([key]));
      self.width = target - short;
    } else if (diff < 0) {
      self.width = target;
      const spare = ColumnShares.SPARE_PREFERENCE.find((k) => k !== key && visible.includes(k)) ?? visible.find((k) => k !== key);
      const to = items.find((it) => it.key === spare);
      if (to) to.width += -diff;
      else self.width -= diff;
    }
    return Object.fromEntries(items.map((it) => [it.key, it.width])) as Record<LayoutKey, number>;
  }
}

/** Manual row order within departments. */
export class RowOrder {
  /**
   * Rows in manual order within each department: listed ids first in list order, then rows the list does not
   * name (new projects, projects moved in from another department) in their incoming (report) order at the
   * bottom. Departments without a list, and the interleaving of departments, are untouched. Pure and stable.
   */
  static apply<R extends { serviceArea: string | null }>(
    rows: readonly R[],
    order: RowOrderValue | null | undefined,
    idOf: (r: R) => string = (r) => (r as unknown as { id: string }).id,
  ): R[] {
    if (!order || Object.keys(order).length === 0) return [...rows];
    const queues = new Map<AreaGroup, R[]>();
    for (const area of Object.keys(order) as AreaGroup[]) {
      const list = order[area] ?? [];
      const rank = new Map(list.map((id, i) => [id, i]));
      const inArea = rows.filter((r) => ServiceAreaInfo.groupOf(r.serviceArea as never) === area);
      const listed = inArea.filter((r) => rank.has(idOf(r))).sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!);
      const rest = inArea.filter((r) => !rank.has(idOf(r)));
      queues.set(area, [...listed, ...rest]);
    }
    return rows.map((r) => {
      const q = queues.get(ServiceAreaInfo.groupOf(r.serviceArea as never));
      return q ? q.shift()! : r;
    });
  }

  /**
   * The department's new stored list after moving `id` so it sits directly before `beforeId` (null = after the
   * last shown row). `stored` is the saved list (may name rows this viewer does not see, which keep their
   * places); `shown` is the department's rows as displayed, top to bottom.
   */
  static move(stored: readonly string[], shown: readonly string[], id: string, beforeId: string | null): string[] {
    const list = [...stored];
    for (const s of shown) if (!list.includes(s)) list.push(s);
    const without = list.filter((x) => x !== id);
    let at: number;
    if (beforeId && beforeId !== id && without.includes(beforeId)) at = without.indexOf(beforeId);
    else {
      const lastShown = [...shown].reverse().find((s) => s !== id);
      at = lastShown ? without.indexOf(lastShown) + 1 : without.length;
    }
    without.splice(at, 0, id);
    return without;
  }

  /** A new project: appended to its department's list when that department has a manual order. */
  static placeNew(order: RowOrderValue, id: string, area: AreaGroup): RowOrderValue {
    const list = order[area];
    if (!list) return order;
    return { ...order, [area]: [...list.filter((x) => x !== id), id] };
  }

  /** A project moved to another department: dropped from every other list, appended to the new department's list if it has one. */
  static placeMoved(order: RowOrderValue, id: string, to: AreaGroup): RowOrderValue {
    const out: RowOrderValue = {};
    for (const [area, list] of Object.entries(order) as [AreaGroup, string[]][]) {
      if (area === to) continue;
      const kept = list.filter((x) => x !== id);
      if (kept.length) out[area] = kept;
    }
    const target = order[to];
    if (target) out[to] = [...target.filter((x) => x !== id), id];
    return out;
  }
}

/** UI copy for the layout controls (Writing Bot). */
export class LayoutCopy {
  static readonly RESIZE_TOOLTIP = "Drag to resize. Double-click to fit.";
  static readonly GRIP_TOOLTIP = "Drag to reorder.";
  static readonly ROW_MOVED = "Row moved";
  static readonly ROW_MOVED_BACK = "Row moved back";
  static readonly UNDO = "Undo";
  static readonly MANUAL_ORDER = "Manual order";
  static readonly RESET_COLUMNS = "Reset columns";
  static readonly RESET_ROWS = "Reset row order";
  static readonly UNDO_MS = 5000;
  static readonly MOVED_BACK_MS = 2000;

  static columnMoved(label: string, position: number, count: number): string {
    return `${label} moved to column ${position} of ${count}.`;
  }

  static rowMoved(position: number, count: number, department: string): string {
    return `Moved to position ${position} of ${count} in ${department}`;
  }

  static rowPickedUp(position: number, count: number, department: string): string {
    return `Picked up. Position ${position} of ${count} in ${department}.`;
  }

  static moveCancelled(position: number): string {
    return `Move cancelled. Back at position ${position}.`;
  }

  static resetColumnsTitle(short: string): string {
    return `Reset columns for ${short}?`;
  }

  static readonly RESET_COLUMNS_BODY = "This restores the default widths and order for everyone on this service line, including the next PDF.";

  static resetRowsTitle(short: string): string {
    return `Reset row order for ${short}?`;
  }

  static readonly RESET_ROWS_BODY = "This restores the default order in every department for everyone on this service line, including the next PDF.";
}
