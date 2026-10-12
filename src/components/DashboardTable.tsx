"use client";

import { LatestUpdate } from "@/lib/dashboard/LatestUpdate";
import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  DashboardColumnModel,
  type DashboardColumn,
  type DueFlagsVisibility,
  type MilestoneUpdateVisibility,
  type PeopleVisibility,
} from "@/lib/dashboard/DashboardColumnModel";
import { DashboardGroups, type DashboardGroup } from "@/lib/dashboard/DashboardGroups";
import { DashboardQuery, type DashboardSortKey, type DashboardSortState, type SearchHit } from "@/lib/dashboard/DashboardQuery";
import { MilestoneOwner } from "@/lib/domain/MilestoneOwner";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { Highlight, QueryCopy } from "./DashboardQueryControls";
import type { AreaGroup, DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import { ColumnShares, LayoutCopy, LineLayout, RowOrder, type ColumnLayoutValue, type LayoutKey, type LineLayoutValue } from "@/lib/layout/LineLayout";
import type { DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { PeopleStack, type PeopleLine } from "@/lib/dashboard/PeopleStack";
import { DueFlags, MilestoneUpdateStack, type DueFlagKind, type DueFlagsCell, type MilestoneUpdateLine } from "@/lib/dashboard/StackedCells";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { StatusPill } from "./StatusPill";
import { StatusShape } from "./StatusShape";

export interface DashboardTableProps {
  /** Filtered regular rows, in report order. */
  rows: readonly DashboardRow[];
  /** Dashboard view settings (drives the one column model shared by every group). */
  settings: ViewSettingsValue;
  selectedId: string | null;
  /** A just-created project's row, highlighted like the selected row for a moment (NewRowFlash). */
  flashId?: string | null;
  onSelect: (id: string | null) => void;
  today: string;
  /** Shown when there is nothing to list. */
  emptyText: string;
  /** Meta line under the project name ("REQ-5081  Updated Sep 24"). */
  renderMeta: (row: DashboardRow) => ReactNode;
  /** The line's shared layout and, for admins, the controls that change it. Absent = default layout, read only. */
  layout?: DashboardLayoutControl;
  /** The line's departments (headings, order, announcement names). Absent = ServiceAreaInfo.LEGACY. */
  departments?: DepartmentList;
  /** Header sort (ascending, descending, manual). Absent = no sort buttons. */
  onSort?: (key: DashboardSortKey) => void;
  /** Search text: highlights, "Matched in" hints and the milestone matches sub-row. */
  search?: string;
  /** While filtering: each department's row count before the filters ("IR · 3 of 5"). */
  groupTotals?: Partial<Record<AreaGroup, number>>;
  /** Present when the viewer may mark rows reviewed (per row: row.editable). */
  onReview?: (row: DashboardRow) => void;
  /** Rendered instead of the plain empty text (filters: "No projects match these filters" + Clear all filters). */
  empty?: ReactNode;
}

/** Layout input of the table: the line's layout, who may change it, the active sort, and where changes go. */
export interface DashboardLayoutControl {
  value: LineLayoutValue;
  /** Admins only: resize handles, header drag, row grips. */
  canEdit: boolean;
  /** Header sort; null = manual order (grips show). Sorting only ever reorders rows inside a department. */
  sort: DashboardSortState;
  onColumns: (next: ColumnLayoutValue) => void;
  /** One department's new manual order (an empty list restores the report order there). */
  onRowOrder: (area: AreaGroup, ids: string[]) => void;
}

/** Dark-theme styling of the grouped table (Figma spec; dark versions of the PDF tokens). */
export class GroupedTableStyle {
  /** Department header row: PDF section head. The PDF fill (#F4F5F7) has no dark token; --dark-input is the closest. */
  static readonly GROUP_HEADER_BG = "var(--dark-input)";
  /** PDF section edge: primary text color, Unassigned in the secondary gray. */
  static readonly GROUP_EDGE = "var(--dark-text-primary)";
  static readonly GROUP_EDGE_MUTED = "var(--dark-text-secondary)";
  static readonly HEADER_H = 36;
  /** Layout controls: the 2px accent guide (resize edge, header and row drop spot). */
  static readonly ACCENT = "var(--color-accent)";
  static readonly LIFT_SHADOW = "drop-shadow(0 6px 14px rgba(0, 0, 0, 0.5))";
}

/** Drag thresholds and timings of the layout controls. */
class LayoutGesture {
  /** A header starts moving after this much pointer travel (px). */
  static readonly HEADER_DRAG_START = 4;
  /** Resize hit area on each header's right edge, inside the header (px). */
  static readonly HANDLE_W = 8;
}

/** Column drag in progress: the key, pointer travel and target position among the shown columns. */
interface ColumnDrag {
  key: LayoutKey;
  dx: number;
  to: number;
}

/** Row move in progress (pointer or keyboard): the department's shown ids, original geometry and target index. */
interface RowDrag {
  id: string;
  area: AreaGroup;
  label: string;
  ids: string[];
  tops: number[];
  heights: number[];
  from: number;
  to: number;
  /** Pointer travel (px); null for a keyboard move (the row sits in its target slot). */
  dy: number | null;
}

interface ToastState {
  text: string;
  undo?: () => void;
  id: number;
}

/** DOM measurement for the layout gestures (widths, fit to content, row geometry). */
class TableMeasure {
  /** Rendered width of every shown data column, from its header cell. */
  static widths(table: HTMLTableElement | null, keys: readonly LayoutKey[]): Record<LayoutKey, number> {
    const out = {} as Record<LayoutKey, number>;
    for (const k of keys) {
      const th = table?.querySelector<HTMLElement>(`th[data-col="${k}"]`);
      out[k] = th ? th.getBoundingClientRect().width : ColumnShares.MIN_PX[k];
    }
    return out;
  }

  /** Width the column needs to show its widest cell in full (text that wraps counts at its current width). */
  static contentWidth(table: HTMLTableElement | null, key: LayoutKey): number {
    let widest = 0;
    table?.querySelectorAll<HTMLElement>(`[data-col="${key}"]`).forEach((cell) => {
      if (cell.tagName === "COL") return;
      const box = cell.getBoundingClientRect();
      const padR = parseFloat(getComputedStyle(cell).paddingRight) || 0;
      cell.querySelectorAll<HTMLElement>("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        widest = Math.max(widest, r.left - box.left + el.scrollWidth + padR);
      });
    });
    return Math.ceil(widest);
  }

  /** x of each shown column's right edge, relative to the table's left edge. */
  static edges(keys: readonly LayoutKey[], widths: Record<LayoutKey, number>): Record<LayoutKey, number> {
    const out = {} as Record<LayoutKey, number>;
    let x = DashboardColumnModel.GUTTER_WIDTH;
    for (const k of keys) {
      x += widths[k];
      out[k] = x;
    }
    return out;
  }
}

/**
 * The grouped dashboard table: one <table> with one <colgroup> from DashboardColumnModel, one sticky
 * column header, then one <tbody> per department (DashboardGroups, PDF order) with a sticky 36px group
 * header and the rows (keyed by project id). A project completed since the latest freeze keeps its row here (Complete
 * chip, Changed flag only, never Overdue or Stale); older completed projects and every cancelled one are on the Completed and Cancelled pages.
 * The first column is the 24px gutter with the row drag grip (admins, manual order only).
 *
 * Layout (one per service line, LineLayout): columns follow the saved order; with saved width shares every
 * column is its share of the table width (minimums enforced widest first), otherwise today's widths with the
 * flexible column. Admins resize from each header's right edge, drag headers (Project stays first) and drag
 * rows within their department; everyone else sees the same layout with no handles or grips.
 */
export function DashboardTable({ rows, settings, selectedId, flashId = null, onSelect, today, emptyText, renderMeta, layout, departments, onSort, search = "", groupTotals, onReview, empty }: DashboardTableProps) {
  const value = layout?.value ?? LineLayout.defaults();
  const effective = value.columns ? LineLayout.orderedSettings("dashboard", settings, value.columns.order) : settings;
  const columns = DashboardColumnModel.columns(effective);
  const dataKeys = columns.filter((c) => !c.structural).map((c) => c.key as LayoutKey);
  const baseOrder = value.columns?.order ?? LineLayout.orderFromSettings("dashboard", settings);
  const shares = value.columns?.shares ?? null;
  const editable = Boolean(layout?.canEdit);
  const sort = layout?.sort ?? null;
  const manual = sort === null;
  const showGrips = editable && manual;
  const people = DashboardColumnModel.peopleVisibility(settings);
  const stack = DashboardColumnModel.milestoneUpdateVisibility(settings);
  const dueFlags = DashboardColumnModel.dueFlagsVisibility(settings);
  const chips = ViewSettings.chipsShown(settings) && dueFlags.flags;
  // Manual order first, so ties under a header sort keep it (stable sort). Groups and their order never change.
  const ordered = RowOrder.apply(rows, value.rows);
  const groups = DashboardGroups.group(ordered, DashboardQuery.comparator(sort), departments);
  const span = columns.length;

  const wrapRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [avail, setAvail] = useState<number | null>(null);
  const [draft, setDraft] = useState<Record<LayoutKey, number> | null>(null);
  const draftRef = useRef<Record<LayoutKey, number> | null>(null);
  const [guideX, setGuideX] = useState<number | null>(null);
  const [resizing, setResizing] = useState<LayoutKey | null>(null);
  const [colDrag, setColDrag] = useState<ColumnDrag | null>(null);
  const colDragRef = useRef<{ key: LayoutKey; x0: number; started: boolean; mids: number[]; lefts: number[]; rights: number[] } | null>(null);
  const [rowDrag, setRowDrag] = useState<RowDrag | null>(null);
  const rowDragRef = useRef<{ y0: number } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastSeq = useRef(0);

  // Table width for share-based columns: the scroll container's inner width.
  useEffect(() => {
    const host = wrapRef.current?.parentElement;
    if (!host || typeof ResizeObserver === "undefined") return;
    const update = () => setAvail(host.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.undo ? LayoutCopy.UNDO_MS : LayoutCopy.MOVED_BACK_MS);
    return () => window.clearTimeout(t);
  }, [toast]);

  const dataWidth = avail !== null ? Math.max(0, avail - DashboardColumnModel.GUTTER_WIDTH) : null;
  const px: Record<LayoutKey, number> | null = draft ?? (shares && dataWidth !== null ? ColumnShares.toPixels(dataKeys, shares, dataWidth) : null);
  const tableWidth = px ? DashboardColumnModel.GUTTER_WIDTH + dataKeys.reduce((s, k) => s + px[k], 0) : null;
  const announce = (text: string) => setAnnouncement((prev) => (prev === text ? `${text}\u00a0` : text));
  const currentWidths = () => px ?? TableMeasure.widths(tableRef.current, dataKeys);

  // ---- Column resize (admins): drag the right edge, double-click to fit.
  const showEdge = (key: LayoutKey, widths: Record<LayoutKey, number>) => setGuideX(TableMeasure.edges(dataKeys, widths)[key]);
  const onResizeDown = (e: ReactPointerEvent<HTMLElement>, key: LayoutKey) => {
    if (!layout || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = currentWidths();
    const x0 = e.clientX;
    draftRef.current = start;
    setResizing(key);
    setDraft(start);
    showEdge(key, start);
    const target = e.currentTarget;
    const move = (ev: PointerEvent) => {
      const next = ColumnShares.resize(dataKeys, start, key, ev.clientX - x0);
      draftRef.current = next;
      setDraft(next);
      showEdge(key, next);
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      const final = draftRef.current;
      draftRef.current = null;
      setResizing(null);
      setGuideX(null);
      if (final && dataKeys.some((k) => Math.abs(final[k] - start[k]) >= 1)) {
        layout.onColumns({ order: baseOrder, shares: ColumnShares.toShares(final, shares) });
      }
      setDraft(null);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  };
  const onResizeFit = (key: LayoutKey) => {
    if (!layout) return;
    const start = currentWidths();
    const next = ColumnShares.fit(dataKeys, start, key, TableMeasure.contentWidth(tableRef.current, key));
    if (dataKeys.some((k) => Math.abs(next[k] - start[k]) >= 1)) layout.onColumns({ order: baseOrder, shares: ColumnShares.toShares(next, shares) });
  };

  // ---- Column reorder (admins): drag a header after 4px, or Alt+Left / Alt+Right on a focused header.
  const moveColumn = (key: LayoutKey, to: number) => {
    if (!layout) return;
    const next = LineLayout.moveVisible(baseOrder, dataKeys, key, to);
    if (next.join() === baseOrder.join()) return;
    layout.onColumns({ order: next, shares });
    const shown = next.filter((k) => dataKeys.includes(k));
    announce(LayoutCopy.columnMoved(LineLayout.LABELS[key], shown.indexOf(key) + 1, shown.length));
  };
  const onHeaderDown = (e: ReactPointerEvent<HTMLElement>, key: LayoutKey) => {
    if (!editable || key === LineLayout.PINNED || e.button !== 0) return;
    const wrap = wrapRef.current?.getBoundingClientRect();
    const cells = dataKeys.map((k) => tableRef.current?.querySelector<HTMLElement>(`th[data-col="${k}"]`)?.getBoundingClientRect());
    if (!wrap || cells.some((c) => !c)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    colDragRef.current = {
      key,
      x0: e.clientX,
      started: false,
      mids: cells.map((c) => c!.left + c!.width / 2),
      lefts: cells.map((c) => c!.left - wrap.left),
      rights: cells.map((c) => c!.right - wrap.left),
    };
  };
  const onHeaderMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = colDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.started && Math.abs(dx) < LayoutGesture.HEADER_DRAG_START) return;
    d.started = true;
    const others = dataKeys.map((k, i) => ({ k, i })).filter((o) => o.k !== d.key);
    const to = Math.max(1, others.filter((o) => d.mids[o.i] < e.clientX).length);
    setColDrag({ key: d.key, dx, to });
    const before = others[to];
    setGuideX(before ? d.lefts[before.i] : d.rights[others[others.length - 1].i]);
  };
  const onHeaderUp = () => {
    const d = colDragRef.current;
    colDragRef.current = null;
    if (!d?.started) return;
    const drag = colDrag;
    setColDrag(null);
    setGuideX(null);
    if (drag) moveColumn(drag.key, drag.to);
  };
  const onHeaderKey = (e: ReactKeyboardEvent<HTMLElement>, key: LayoutKey) => {
    if (!editable || key === LineLayout.PINNED || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const i = dataKeys.indexOf(key);
    const to = e.key === "ArrowLeft" ? i - 1 : i + 1;
    if (to < 1 || to >= dataKeys.length) return;
    moveColumn(key, to);
  };

  // ---- Row reorder (admins, manual order): pointer drag on the grip, or Space / arrows / Space / Esc.
  const rowGeometry = (area: AreaGroup): { ids: string[]; tops: number[]; heights: number[] } | null => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const trs = tableRef.current?.querySelectorAll<HTMLElement>(`tbody[data-area="${area}"] tr[data-row-key]`);
    if (!wrap || !trs) return null;
    const list = [...trs];
    return {
      ids: list.map((tr) => tr.dataset.rowKey!),
      tops: list.map((tr) => tr.getBoundingClientRect().top - wrap.top),
      heights: list.map((tr) => tr.getBoundingClientRect().height),
    };
  };
  const startRow = (id: string, area: AreaGroup, label: string, pointerY: number | null): RowDrag | null => {
    const g = rowGeometry(area);
    if (!g) return null;
    const from = g.ids.indexOf(id);
    if (from < 0) return null;
    const drag: RowDrag = { id, area, label, ...g, from, to: from, dy: pointerY === null ? null : 0 };
    setRowDrag(drag);
    return drag;
  };
  const commitRow = (drag: RowDrag) => {
    setRowDrag(null);
    if (!layout || drag.to === drag.from) return false;
    const others = drag.ids.filter((x) => x !== drag.id);
    const beforeId = others[drag.to] ?? null;
    const prev = value.rows[drag.area];
    const next = RowOrder.move(prev ?? [], drag.ids, drag.id, beforeId);
    layout.onRowOrder(drag.area, next);
    announce(LayoutCopy.rowMoved(drag.to + 1, drag.ids.length, drag.label));
    setToast({
      id: ++toastSeq.current,
      text: LayoutCopy.ROW_MOVED,
      undo: () => {
        layout.onRowOrder(drag.area, prev ?? []);
        setToast({ id: ++toastSeq.current, text: LayoutCopy.ROW_MOVED_BACK });
      },
    });
    return true;
  };
  const onGripDown = (e: ReactPointerEvent<HTMLElement>, id: string, area: AreaGroup, label: string) => {
    if (!showGrips || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!startRow(id, area, label, e.clientY)) return;
    rowDragRef.current = { y0: e.clientY };
  };
  const onGripMove = (e: ReactPointerEvent<HTMLElement>) => {
    const r = rowDragRef.current;
    if (!r || !rowDrag || rowDrag.dy === null) return;
    const dy = e.clientY - r.y0;
    const center = rowDrag.tops[rowDrag.from] + rowDrag.heights[rowDrag.from] / 2 + dy;
    const to = rowDrag.ids.filter((x, i) => x !== rowDrag.id && rowDrag.tops[i] + rowDrag.heights[i] / 2 < center).length;
    setRowDrag({ ...rowDrag, dy, to });
  };
  const onGripUp = () => {
    if (!rowDragRef.current) return;
    rowDragRef.current = null;
    if (rowDrag && rowDrag.dy !== null) commitRow(rowDrag);
  };
  const onGripKey = (e: ReactKeyboardEvent<HTMLElement>, id: string, area: AreaGroup, label: string) => {
    if (!showGrips) return;
    const active = rowDrag && rowDrag.dy === null && rowDrag.id === id ? rowDrag : null;
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      e.stopPropagation();
      if (!active) {
        const d = startRow(id, area, label, null);
        if (d) announce(LayoutCopy.rowPickedUp(d.from + 1, d.ids.length, label));
      } else if (!commitRow(active)) {
        announce(LayoutCopy.rowMoved(active.to + 1, active.ids.length, active.label));
      }
      return;
    }
    if (!active) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = Math.max(0, Math.min(active.ids.length - 1, active.to + (e.key === "ArrowUp" ? -1 : 1)));
      setRowDrag({ ...active, to });
      announce(LayoutCopy.rowMoved(to + 1, active.ids.length, active.label));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setRowDrag(null);
      announce(LayoutCopy.moveCancelled(active.from + 1));
    }
  };
  const rowStyle = (id: string, area: AreaGroup): { style?: CSSProperties; lifted: boolean } => {
    const d = rowDrag;
    if (!d || d.area !== area) return { lifted: false };
    const j = d.ids.indexOf(id);
    if (j < 0) return { lifted: false };
    const h = d.heights[d.from];
    if (id === d.id) {
      const slotTop = d.to <= d.from ? d.tops[d.to] : d.tops[d.to] + d.heights[d.to] - h;
      const y = d.dy ?? slotTop - d.tops[d.from];
      return { lifted: true, style: { transform: `translateY(${y}px)`, filter: GroupedTableStyle.LIFT_SHADOW, position: "relative", zIndex: 4 } };
    }
    let shift = 0;
    if (d.from < d.to && j > d.from && j <= d.to) shift = -h;
    if (d.to < d.from && j >= d.to && j < d.from) shift = h;
    return { lifted: false, style: { transform: shift ? `translateY(${shift}px)` : undefined } };
  };
  const rowDropY = rowDrag ? (rowDrag.to <= rowDrag.from ? rowDrag.tops[rowDrag.to] : rowDrag.tops[rowDrag.to] + rowDrag.heights[rowDrag.to]) : null;

  return (
    <div ref={wrapRef} className="relative" style={tableWidth !== null ? { width: tableWidth } : undefined} data-testid="dashboard-table-wrap">
      <table
        ref={tableRef}
        className="w-full table-fixed border-separate border-spacing-0 type-table"
        style={tableWidth !== null ? { width: tableWidth } : { minWidth: DashboardColumnModel.minTableWidth(columns) }}
        data-testid="dashboard-table"
        data-layout={value.columns ? "custom" : "default"}
      >
        <colgroup>
          {columns.map((c) => (
            <col
              key={c.key}
              data-col={c.key}
              style={px && !c.structural ? { width: px[c.key as LayoutKey] } : c.flex && !px ? { minWidth: c.minWidth } : { width: c.width }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => {
              if (c.structural) return <td key={c.key} aria-hidden="true" className="sticky top-0 z-[3] h-9 border-b border-line bg-card p-0" />;
              const key = c.key as LayoutKey;
              const movable = editable && key !== LineLayout.PINNED;
              const dragging = colDrag?.key === key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  data-col={c.key}
                  aria-sort={onSort && HeaderSort.keysOf(c.key).length ? HeaderSort.ariaSort(c.key, sort) : undefined}
                  tabIndex={movable ? 0 : undefined}
                  aria-keyshortcuts={movable ? "Alt+ArrowLeft Alt+ArrowRight" : undefined}
                  onPointerDown={movable ? (e) => onHeaderDown(e, key) : undefined}
                  onPointerMove={movable ? onHeaderMove : undefined}
                  onPointerUp={movable ? onHeaderUp : undefined}
                  onPointerCancel={movable ? onHeaderUp : undefined}
                  onKeyDown={movable ? (e) => onHeaderKey(e, key) : undefined}
                  style={dragging ? { opacity: 0.9, transform: `translateX(${colDrag.dx}px)`, filter: GroupedTableStyle.LIFT_SHADOW, zIndex: 6 } : undefined}
                  className={`sticky top-0 z-[3] h-9 border-b border-line bg-card px-3 text-left uppercase tracking-[.04em] text-muted type-label ${movable ? "cursor-grab select-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-(--color-accent)" : ""} ${dragging ? "cursor-grabbing" : ""}`}
                >
                  <HeaderLabel column={c.key} header={c.header} sort={sort} onSort={onSort} chips={chips} />
                  {editable && (
                    <span
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${c.header}`}
                      data-resize={c.key}
                      onPointerDown={(e) => onResizeDown(e, key)}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        onResizeFit(key);
                      }}
                      onPointerEnter={() => !resizing && !colDrag && showEdge(key, currentWidths())}
                      onPointerLeave={() => !resizing && setGuideX(null)}
                      className="group/rh absolute top-0 z-[4] h-full cursor-col-resize normal-case tracking-normal"
                      style={{ right: 0, width: LayoutGesture.HANDLE_W }}
                    >
                      <span
                        role="tooltip"
                        className={`pointer-events-none absolute top-[calc(100%+6px)] right-0 z-[7] whitespace-nowrap rounded-control border border-line bg-(--dark-input) px-2 py-1 text-[12px] leading-4 font-normal text-fg opacity-0 shadow-lg transition-opacity delay-300 group-hover/rh:opacity-100 ${resizing ? "hidden" : ""}`}
                      >
                        {LayoutCopy.RESIZE_TOOLTIP}
                      </span>
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        {groups.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={span} className="h-20 text-center text-muted">
                {empty ?? emptyText}
              </td>
            </tr>
          </tbody>
        )}
        {groups.map((g, i) => (
          <tbody key={g.area} data-area={g.area}>
            {i > 0 && (
              <tr aria-hidden="true">
                <td colSpan={span} className="h-6 p-0" />
              </tr>
            )}
            <GroupHeader group={g} span={span} total={groupTotals?.[g.area]} />
            {g.rows.map((r) => {
              const drag = rowStyle(r.id, g.area);
              const hit = search.trim() ? DashboardQuery.search(r, search, departments) : null;
              return (
                <Fragment key={r.id}>
                <ProjectRow
                  row={r}
                  columns={columns}
                  people={people}
                  stack={stack}
                  dueFlags={dueFlags}
                  today={today}
                  selected={r.id === selectedId || r.id === flashId}
                  onSelect={onSelect}
                  chips={chips}
                  search={search}
                  hit={hit}
                  onReview={onReview && r.editable && r.changed ? () => onReview(r) : undefined}
                  renderMeta={renderMeta}
                  style={drag.style}
                  lifted={drag.lifted}
                  animate={Boolean(rowDrag && rowDrag.area === g.area)}
                  grip={
                    showGrips ? (
                      <RowGrip
                        name={r.name}
                        active={rowDrag?.id === r.id}
                        onPointerDown={(e) => onGripDown(e, r.id, g.area, g.name)}
                        onPointerMove={onGripMove}
                        onPointerUp={onGripUp}
                        onKeyDown={(e) => onGripKey(e, r.id, g.area, g.name)}
                        onBlur={() => rowDrag?.id === r.id && rowDrag.dy === null && setRowDrag(null)}
                      />
                    ) : null
                  }
                />
                {hit && hit.milestones.length > 0 && <MilestoneMatches hit={hit} search={search} span={span} />}
                </Fragment>
              );
            })}
          </tbody>
        ))}
      </table>
      {guideX !== null && (
        <div aria-hidden="true" data-testid="layout-guide" className="pointer-events-none absolute top-0 z-[8] h-full" style={{ left: guideX - 1, width: 2, background: GroupedTableStyle.ACCENT }} />
      )}
      {rowDropY !== null && rowDrag && rowDrag.to !== rowDrag.from && (
        <div
          aria-hidden="true"
          data-testid="row-drop-line"
          className="pointer-events-none absolute z-[8]"
          style={{ top: rowDropY - 1, height: 2, left: DashboardColumnModel.GUTTER_WIDTH, right: 0, background: GroupedTableStyle.ACCENT }}
        />
      )}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
      {toast && (
        <div
          role="status"
          data-testid="layout-toast"
          className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-card border border-line bg-(--dark-input) px-4 py-2.5 text-fg shadow-lg type-table"
        >
          <span>{toast.text}</span>
          {toast.undo && (
            <button type="button" className="font-semibold text-accent hover:underline" onClick={toast.undo}>
              {LayoutCopy.UNDO}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Six-dot row grip in the gutter (admins, manual order): secondary gray, primary on hover; Space to pick up. */
export function RowGrip({
  name,
  active,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onKeyDown,
  onBlur,
}: {
  name: string;
  active: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  onBlur: () => void;
}) {
  return (
    <button
      type="button"
      data-grip
      aria-label={`Reorder ${name}`}
      aria-pressed={active}
      aria-roledescription="sortable"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={`group/grip relative flex h-6 w-6 cursor-grab touch-none items-center justify-center rounded-control focus-visible:outline-2 focus-visible:outline-(--color-accent) ${active ? "cursor-grabbing text-fg" : "text-(--dark-text-secondary) hover:text-(--dark-text-primary)"}`}
    >
      <svg width="8" height="14" viewBox="0 0 8 14" aria-hidden="true">
        {[2, 7, 12].map((y) => [2, 6].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}
      </svg>
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-1/2 left-[calc(100%+4px)] z-[7] -translate-y-1/2 whitespace-nowrap rounded-control border border-line bg-(--dark-input) px-2 py-1 text-[12px] leading-4 font-normal text-fg opacity-0 shadow-lg transition-opacity delay-300 group-hover/grip:opacity-100 ${active ? "hidden" : ""}`}
      >
        {LayoutCopy.GRIP_TOOLTIP}
      </span>
    </button>
  );
}

function GroupHeader({ group, span, total }: { group: DashboardGroup<DashboardRow>; span: number; total?: number }) {
  const edge = group.muted ? GroupedTableStyle.GROUP_EDGE_MUTED : GroupedTableStyle.GROUP_EDGE;
  const style: CSSProperties = { background: GroupedTableStyle.GROUP_HEADER_BG, boxShadow: `inset 3px 0 0 ${edge}`, top: GroupedTableStyle.HEADER_H };
  return (
    <tr data-testid="group-header">
      <th colSpan={span} scope="colgroup" style={style} className="sticky z-[2] h-9 border-b border-line px-3 text-left align-middle">
        <span className={`text-[13px] leading-[18px] font-semibold uppercase tracking-[.04em] ${group.muted ? "text-muted" : "text-fg"}`}>{group.label}</span>
        <span className="ml-2 font-normal text-muted type-table">{total !== undefined ? `· ${DashboardQuery.groupCount(group.rows.length, total)}` : group.countText}</span>
      </th>
    </tr>
  );
}

const CELL = "border-b border-line px-3 py-[10px] align-top";
/** Project names wrap onto as many lines as they need, never truncated (dashboard and the Completed and Cancelled pages). */
export const NAME_WRAP = "whitespace-normal [overflow-wrap:anywhere] hyphens-none";

function ProjectRow({
  row,
  columns,
  people,
  stack,
  dueFlags,
  today,
  selected,
  onSelect,
  renderMeta,
  grip = null,
  style,
  lifted = false,
  animate = false,
  chips = true,
  search = "",
  hit = null,
  onReview,
}: {
  row: DashboardRow;
  columns: readonly DashboardColumn[];
  people: PeopleVisibility;
  stack: MilestoneUpdateVisibility;
  dueFlags: DueFlagsVisibility;
  today: string;
  selected: boolean;
  onSelect: (id: string | null) => void;
  renderMeta: (row: DashboardRow) => ReactNode;
  grip?: ReactNode;
  style?: CSSProperties;
  lifted?: boolean;
  animate?: boolean;
  chips?: boolean;
  search?: string;
  hit?: SearchHit | null;
  onReview?: () => void;
}) {
  const td = `${CELL} ${selected ? "bg-row-selected" : lifted ? "bg-card" : ""}`;
  // Chips hidden: a Changed row keeps a quiet cue (2px lilac inset rule and "• Changed" under the meta line).
  const changedCue = !chips && row.changed;
  const projectShadow = selected ? "shadow-[inset_3px_0_0_var(--dark-accent)]" : changedCue ? "shadow-[inset_2px_0_0_#B9A3FF]" : "";
  return (
    <tr
      data-row-key={row.id}
      data-lifted={lifted || undefined}
      onClick={() => onSelect(selected ? null : row.id)}
      style={style}
      className={`pb-row cursor-pointer ${lifted ? "" : "hover:[&>td]:bg-row-selected/60"} ${animate && !lifted ? "transition-transform duration-150 ease-out motion-reduce:transition-none" : ""}`}
      aria-selected={selected}
    >
      {columns.map((c) => {
        switch (c.key) {
          case "gutter":
            return grip ? (
              <td key={c.key} className={`${td} px-0 py-[7px] align-top`}>
                {grip}
              </td>
            ) : (
              <td key={c.key} aria-hidden="true" className={`${td} px-0`} />
            );
          case "project":
            return (
              <td key={c.key} data-col={c.key} data-changed-cue={changedCue || undefined} className={`${td} type-table-strong ${projectShadow}`}>
                {/* The full name wraps between words (a single over-long word breaks anywhere, no hyphens); the row grows. */}
                <div data-part="project-name" className={NAME_WRAP}>
                  <Highlight text={row.name} query={search} />
                </div>
                {renderMeta(row)}
                {changedCue && (
                  <div data-part="changed-cue" className="text-[12px] leading-4 font-normal" style={{ color: "#B9A3FF" }}>
                    • Changed
                  </div>
                )}
                {hit && hit.hiddenFields.length > 0 && (
                  <div data-part="matched-in" className="text-[12px] leading-4 font-normal text-muted">
                    ⌕ Matched in: {hit.hiddenFields.join(", ")}
                  </div>
                )}
                {onReview && (
                  <button
                    type="button"
                    data-testid="mark-reviewed"
                    aria-label={QueryCopy.markReviewedLabel(row.name)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onReview();
                    }}
                    className="pb-review-btn mt-1 inline-flex h-6 items-center gap-1 rounded-control border border-line bg-card px-2 text-[12px] leading-4 font-semibold text-fg hover:bg-row-selected focus-visible:outline-2 focus-visible:outline-(--color-accent)"
                  >
                    <span aria-hidden="true">✓</span> {QueryCopy.MARK_REVIEWED}
                  </button>
                )}
              </td>
            );
          case "people":
            return (
              <td key={c.key} data-col={c.key} className={td}>
                <PeopleCell lines={PeopleStack.lines(row, people)} />
              </td>
            );
          case "status":
            return (
              <td key={c.key} data-col={c.key} className={td}>
                <StatusPill status={row.status} />
              </td>
            );
          case "milestoneUpdate":
            return (
              <td key={c.key} data-col={c.key} className={td}>
                <MilestoneUpdateCell lines={MilestoneUpdateStack.lines(row, stack)} />
              </td>
            );
          case "dueFlags":
            return (
              <td key={c.key} data-col={c.key} className={td}>
                <div className="flex items-start gap-2">
                  <DueFlagsCellView cell={DueFlags.cell(row, dueFlags, today)} />
                  <MilestoneOwnerView row={row} chips={chips} />
                </div>
              </td>
            );
        }
      })}
    </tr>
  );
}

/**
 * People cell text styles. Owner: label 400 and name 600 in the primary color. Requester and Contracts:
 * label and name 400 in the secondary gray, the same as the Latest update note. "To assign" is always
 * regular weight secondary gray (never amber).
 */
export class PeopleCellStyle {
  static labelClass(l: PeopleLine): string {
    return l.primary ? "font-normal text-fg" : "font-normal text-muted";
  }

  static nameClass(l: PeopleLine): string {
    return l.primary && !l.muted ? "font-semibold text-fg" : "font-normal text-muted";
  }
}

/**
 * Stacked People cell: up to three labeled entries at 13/18 ("Owner: Name"). Each entry wraps at word
 * boundaries onto as many lines as it needs (never truncated), like the Contracts line in the PDF.
 */
export function PeopleCell({ lines }: { lines: readonly PeopleLine[] }) {
  return (
    <div className="flex flex-col text-[13px] leading-[18px]" data-testid="people-cell">
      {lines.map((l) => (
        <div key={l.kind} data-line={l.kind} className="min-w-0 whitespace-normal break-words">
          <span className={PeopleCellStyle.labelClass(l)}>{`${l.label} `}</span>
          <span title={l.title} className={PeopleCellStyle.nameClass(l)}>
            {l.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Next milestone / Latest update, stacked like the PDF row: the milestone (13/18 primary, semibold, at most
 * two lines, full text as a tooltip), then after a 4px gap the latest update (13/18 regular, secondary, not
 * clamped; unchanged rows read "No change." in the same style). Blank lines render nothing.
 */
export function MilestoneUpdateCell({ lines }: { lines: readonly MilestoneUpdateLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col text-[13px] leading-[18px]" style={{ gap: MilestoneUpdateStack.LINE_GAP_PX }} data-testid="milestone-update">
      {lines.map((l) =>
        l.kind === "milestone" ? (
          l.progress || l.done ? (
            // Checklist: "· X of Y" (12px secondary, tabular) sits at the END of the milestone line and never wraps
            // onto its own line; a finished checklist reads "All milestones done" in teal.
            <div key="milestone" data-line="milestone" title={MilestoneUpdateStack.tooltip(l.text, l.progress)} className="flex min-w-0 items-end gap-1.5">
              <span className={`line-clamp-2 min-w-0 break-words font-semibold ${l.done ? "text-(--status-complete-dark-fg)" : "text-fg"}`}>{l.text}</span>
              {l.progress && (
                <span data-part="milestone-progress" className="shrink-0 whitespace-nowrap text-[12px] font-normal tabular-nums text-muted">
                  · {l.progress}
                </span>
              )}
            </div>
          ) : (
            <div key="milestone" data-line="milestone" title={MilestoneUpdateStack.tooltip(l.text, null)} className="line-clamp-2 break-words font-semibold text-fg">
              {l.text}
            </div>
          )
        ) : (
          <div
            key="update"
            data-line="update"
            data-muted={l.muted || undefined}
            data-clipped={l.clipped || undefined}
            title={l.clipped ? LatestUpdate.CLIPPED_TOOLTIP : undefined}
            className="break-words font-normal text-muted"
          >
            {l.prefix && <span data-part="no-change">{l.prefix}</span>}
            {l.prefix && l.text ? " " : null}
            {l.text}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Due / Flags with fixed placement (DueFlags.GRID): row 1 the date then Overdue, row 2 Changed then Stale,
 * in fixed-width columns. Every cell keeps its place when empty, so the date and each flag line up across
 * rows. With Flags hidden only the date shows. Top-aligned with the row's first line.
 */
export function DueFlagsCellView({ cell }: { cell: DueFlagsCell }) {
  if (!cell.due && !cell.slots) return null;
  const date = cell.due && (
    <span
      data-part="due"
      className={`whitespace-nowrap ${cell.due.overdue ? "font-semibold text-danger" : cell.due.muted ? "text-muted" : "text-fg"}`}
    >
      {cell.due.text}
    </span>
  );
  if (!cell.slots) {
    return (
      <div className="text-[13px] leading-[18px]" data-testid="due-flags">
        {date}
      </div>
    );
  }
  const at = (p: { row: number; col: number }) => ({ gridRow: p.row + 1, gridColumn: p.col + 1 });
  return (
    <div
      data-testid="due-flags"
      className="grid items-center text-[13px] leading-[18px]"
      style={{
        gridTemplateColumns: DueFlags.COLUMN_WIDTHS_PX.map((w) => `${w}px`).join(" "),
        gridTemplateRows: `repeat(${DueFlags.ROWS}, ${DueFlags.ROW_H_PX}px)`,
        columnGap: DueFlags.COL_GAP_PX,
        rowGap: DueFlags.ROW_GAP_PX,
      }}
    >
      <span data-cell="due" className="flex" style={at(DueFlags.position("due"))}>
        {date}
      </span>
      {cell.slots.map((s) => (
        <span key={s.kind} data-slot={s.slot} data-slot-kind={s.kind} className="flex" style={at(s)}>
          {s.flag && <DueFlagPill kind={s.flag.kind} label={s.flag.label} />}
        </span>
      ))}
    </div>
  );
}

/** One PDF flag pill in dark tokens: Changed and Stale dashed, Overdue filled. Also the side panel's "Completion date needed" (Stale chip). */
export function DueFlagPill({ kind, label }: { kind: DueFlagKind; label: string }) {
  return (
    <span className={`flag fl-${kind} flex-none`} data-flag={kind}>
      {kind === "changed" && <StatusShape status="OffTrack" />}
      {kind === "stale" && <ClockIcon />}
      {label}
    </span>
  );
}

function ClockIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 2.6V5l1.7 1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * Header text with its sort button(s): click cycles ascending, descending, manual (aria-sort on the th is set by the
 * caller through data). Project carries a second button for Updated; Due / Milestone owner has one per field. The
 * resize handle sits outside these buttons and never sorts. Flags is not sortable.
 */
function HeaderLabel({ column, header, sort, onSort, chips }: { column: string; header: string; sort: DashboardSortState; onSort?: (key: DashboardSortKey) => void; chips: boolean }) {
  const keys = HeaderSort.keysOf(column);
  if (!onSort || keys.length === 0) return <span className="block truncate">{header}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2">
      {keys.map((k, i) => {
        const state = DashboardQuery.ariaSort(sort, k);
        const label = HeaderSort.label(column, k, header, chips);
        return (
          <button
            key={k}
            type="button"
            data-sort={k}
            aria-label={`Sort by ${DashboardQuery.SORT_LABELS[k]}${state === "none" ? "" : `, ${state}`}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSort(k);
            }}
            className={`flex min-w-0 items-center gap-1 uppercase tracking-[.04em] hover:text-fg focus-visible:outline-2 focus-visible:outline-(--color-accent) ${state !== "none" ? "text-fg" : ""} ${i > 0 ? "text-[11px]" : ""}`}
          >
            <span className="truncate">{label}</span>
            <span aria-hidden="true" className="w-2 shrink-0" style={{ color: "#4C8DFF" }}>
              {state === "ascending" ? "▲" : state === "descending" ? "▼" : ""}
            </span>
          </button>
        );
      })}
    </span>
  );
}

/** Which sort keys each dashboard column header offers. */
export class HeaderSort {
  static keysOf(column: string): DashboardSortKey[] {
    switch (column) {
      case "project":
        return ["name", "updated"];
      case "people":
        return ["owner"];
      case "status":
        return ["status"];
      case "milestoneUpdate":
        return ["nextMilestone"];
      case "dueFlags":
        return ["due", "milestoneOwner"];
      default:
        return [];
    }
  }

  static label(column: string, key: DashboardSortKey, header: string, chips: boolean): string {
    if (column === "dueFlags") return key === "due" ? (chips ? "Due / Flags" : "Due") : "Milestone owner";
    if (column === "project" && key === "updated") return "Updated";
    return header;
  }

  /** aria-sort for a column header: the state of its first key that is active. */
  static ariaSort(column: string, sort: DashboardSortState): "ascending" | "descending" | "none" {
    for (const k of HeaderSort.keysOf(column)) {
      const s = DashboardQuery.ariaSort(sort, k);
      if (s !== "none") return s;
    }
    return "none";
  }
}

/**
 * Milestone owner (Option A): 12px Inter 500 #E6E8EC, up to two lines then ellipsis; physician names as
 * "Dr. A. Lastname"; tooltip and aria-label carry the full name. Unassigned italic amber; no open milestone a muted
 * en dash ("No open milestone"). 136px with chips off, 120px with chips on.
 */
export function MilestoneOwnerView({ row, chips }: { row: DashboardRow; chips: boolean }) {
  const cell = MilestoneOwner.cell(row);
  const width = chips ? MilestoneOwnerStyle.WIDTH_CHIPS_ON : MilestoneOwnerStyle.WIDTH_CHIPS_OFF;
  const label = MilestoneOwner.label(cell);
  return (
    <span
      data-part="milestone-owner"
      data-owner-kind={cell.kind}
      title={label}
      aria-label={cell.kind === "owner" ? `Milestone owner: ${label}` : label}
      className={`line-clamp-2 block shrink-0 break-words text-[12px] leading-[18px] ${cell.kind === "unassigned" ? "italic" : cell.kind === "none" ? "text-muted" : "font-medium"}`}
      style={{ width, color: cell.kind === "unassigned" ? "#F5B83D" : cell.kind === "owner" ? "#E6E8EC" : undefined }}
    >
      {MilestoneOwner.text(cell)}
    </span>
  );
}

export class MilestoneOwnerStyle {
  static readonly WIDTH_CHIPS_OFF = 136;
  static readonly WIDTH_CHIPS_ON = 120;
  static readonly GAP = 8;
}

/** "Matches in milestones (n)": up to 3, then "+N more" (search). */
function MilestoneMatches({ hit, search, span }: { hit: SearchHit; search: string; span: number }) {
  const shown = hit.milestones.slice(0, DashboardQuery.MILESTONE_MATCHES_SHOWN);
  const more = hit.milestones.length - shown.length;
  return (
    <tr data-testid="milestone-matches">
      <td aria-hidden="true" className="border-b border-line p-0" />
      <td colSpan={span - 1} className="border-b border-line px-3 pt-0 pb-2 text-[12px] leading-[18px] text-muted">
        <span className="font-semibold">Matches in milestones ({hit.milestones.length}):</span>{" "}
        {shown.map((m, i) => (
          <span key={i} className={m.done ? "line-through" : ""}>
            {i > 0 && " · "}
            <Highlight text={m.name} query={search} />
            {m.owner && (
              <>
                {" ("}
                <Highlight text={MilestoneOwner.short(m.owner)} query={search} />
                {")"}
              </>
            )}
          </span>
        ))}
        {more > 0 && ` +${more} more`}
      </td>
    </tr>
  );
}
