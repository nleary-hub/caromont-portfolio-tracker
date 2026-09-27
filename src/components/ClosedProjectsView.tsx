"use client";

import { useCallback, useEffect, useMemo, useState, useTransition, type CSSProperties, type ReactNode } from "react";
import type { DashboardGroup } from "@/lib/dashboard/DashboardGroups";
import type { DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { Assignee } from "@/lib/domain/Assignee";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { InforNumber } from "@/lib/domain/InforNumber";
import { Requester } from "@/lib/domain/Requester";
import type { DepartmentKey, DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import { ClosedPageModel, type ClosedPageKind, type ClosedView } from "@/lib/closed/ClosedPageModel";
import { ClosedPagesCopy as C } from "@/lib/closed/ClosedPagesCopy";
import type { RestorePreview } from "@/lib/closed/ClosedPageData";
import type { RestoreActionResult } from "@/app/actions/closed";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { ActionToast, RowFade, type ActionToastValue } from "./ActionToast";
import { DepartmentsSelect, usePopover } from "./DashboardFilterControls";
import { GroupedTableStyle } from "./DashboardTable";
import { MainNav } from "./MainNav";
import { ProjectDrawer } from "./ProjectDashboard";
import type { HistoryLoader } from "./ProjectHistory";

const CELL = "border-b border-line px-3 py-[10px] align-top";
const HEAD = "h-8 border-b border-line bg-card px-3 text-left align-middle uppercase tracking-[.04em] text-muted type-label";
const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";

/** Column widths of the closed list (Figma: the item 4 table pattern). The menu column exists for admins on Cancelled only. */
export class ClosedTableStyle {
  static readonly OWNER_W = 170;
  static readonly REQUESTER_W = 170;
  static readonly DATE_W = 112;
  static readonly FINAL_W = "34%";
  static readonly MENU_W = 44;
}

/** Deep-link state for review and screenshots only. */
export interface ClosedViewDemo {
  menuOpenFor?: string;
  drawerFor?: string;
  confirmFor?: string;
  fyOpen?: boolean;
  toast?: ActionToastValue;
}

export function ClosedProjectsView({
  kind,
  rows: initialRows,
  today,
  initialView,
  options,
  list,
  restore,
  restoreAction,
  historyAction,
  lineSlot,
  adminSlot,
  loadError,
  demo,
}: {
  kind: ClosedPageKind;
  /** Rows of this page's status, every fiscal year, already visibility- and line-filtered on the server. */
  rows: DashboardFyRow[];
  today: string;
  initialView: ClosedView;
  options: readonly DepartmentKey[];
  list: DepartmentList;
  /** Admins on the Cancelled page only (null otherwise: no menu column, no drawer button). */
  restore: Record<string, RestorePreview> | null;
  restoreAction?: (projectId: string) => Promise<RestoreActionResult>;
  historyAction?: HistoryLoader;
  lineSlot: ReactNode;
  adminSlot: ReactNode;
  loadError: string | null;
  demo?: ClosedViewDemo;
}) {
  const [view, setViewState] = useState<ClosedView>(initialView);
  const [rows, setRows] = useState(initialRows);
  const [selectedId, setSelectedId] = useState<string | null>(demo?.drawerFor ?? null);
  const [confirmId, setConfirmId] = useState<string | null>(demo?.confirmFor ?? null);
  const [toast, setToast] = useState<ActionToastValue | null>(demo?.toast ?? null);
  const current = FiscalYear.of(today).label;
  const years = useMemo(() => {
    const ys = ClosedPageModel.years(initialRows, kind.status, today);
    return ys.includes(view.fy) ? ys : [...ys, view.fy].sort((a, b) => (a === current ? -1 : b === current ? 1 : b.localeCompare(a)));
  }, [initialRows, kind.status, today, view.fy, current]);
  const state = useMemo(() => ClosedPageModel.state(rows, kind.status, view, options, list), [rows, kind.status, view, options, list]);
  const query = ClosedPageModel.query(view, today, options, list);

  // The URL keeps fy and departments, so a link (or reload) reopens the same view.
  const setView = (next: ClosedView) => {
    setViewState(next);
    window.history.replaceState(null, "", `${kind.path}${ClosedPageModel.query(next, today, options, list)}`);
  };
  const clearFilters = () => setView({ ...view, departments: [...options] });
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const canRestore = Boolean(restore && restoreAction && kind.status === "Cancelled");
  const confirmRow = rows.find((r) => r.id === confirmId) ?? null;

  const onRestored = (row: DashboardFyRow, r: Extract<RestoreActionResult, { ok: true }>) => {
    setConfirmId(null);
    if (selectedId === row.id) setSelectedId(null);
    RowFade.out(row.id);
    window.setTimeout(() => setRows((rs) => rs.filter((x) => x.id !== row.id)), RowFade.MS);
    setToast({ text: C.restoreToast(r.name, r.statusLabel), link: { href: "/", label: C.VIEW_ON_DASHBOARD } });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmId) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmId]);

  const dateHeader = C.dateHeader(kind.status);
  const span = canRestore ? 6 : 5;

  return (
    <div className="relative min-h-screen">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-topbar px-6 backdrop-blur-[20px]">
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="grid size-[26px] shrink-0 place-items-center rounded-[6px] bg-accent type-label font-bold">SL</div>
          {lineSlot}
        </div>
        <div className="h-6 w-px bg-line" />
        <MainNav active={kind.status === "Complete" ? "completed" : "cancelled"} closedQuery={query} />
        <div className="flex-1" />
        {adminSlot}
      </header>

      <main className="flex flex-col gap-4 px-6 pt-5 pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="type-title whitespace-nowrap">{C.title(kind.status)}</h1>
            <p className="mt-1 text-muted type-caption" data-testid="closed-summary">
              {ClosedPageModel.summary(state)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <FyPicker years={years} current={current} value={view.fy} onChange={(fy) => setView({ ...view, fy })} initialOpen={demo?.fyOpen} />
            <DepartmentsSelect value={view.departments} onChange={(departments) => setView({ ...view, departments })} options={options} list={list} />
          </div>
        </div>

        {loadError && (
          <p role="alert" className="rounded-card border border-line bg-card px-3 py-2 text-danger">
            {loadError}
          </p>
        )}

        <section className="overflow-hidden rounded-card border border-line bg-card" aria-label={C.title(kind.status)}>
          <table className="w-full table-fixed border-separate border-spacing-0 type-table" data-testid="closed-table">
            <colgroup>
              <col />
              <col style={{ width: ClosedTableStyle.OWNER_W }} />
              <col style={{ width: ClosedTableStyle.REQUESTER_W }} />
              <col style={{ width: ClosedTableStyle.DATE_W }} />
              <col style={{ width: ClosedTableStyle.FINAL_W }} />
              {canRestore && <col style={{ width: ClosedTableStyle.MENU_W }} />}
            </colgroup>
            <thead>
              <tr>
                <th scope="col" className={HEAD}>{C.PROJECT}</th>
                <th scope="col" className={HEAD}>{C.OWNER}</th>
                <th scope="col" className={HEAD}>{C.REQUESTER}</th>
                <th scope="col" className={HEAD}>{dateHeader}</th>
                <th scope="col" className={HEAD}>{C.FINAL_UPDATE}</th>
                {canRestore && (
                  <th scope="col" className={HEAD}>
                    <span className="sr-only">{C.ROW_MENU_LABEL}</span>
                  </th>
                )}
              </tr>
            </thead>
            {state.empty ? (
              <tbody>
                <tr>
                  <td colSpan={span} className="px-3 py-8 text-center" data-testid={`closed-empty-${state.empty}`}>
                    {state.empty === "year" ? (
                      <>
                        <p className="type-table-strong">{C.emptyYear(kind.status, view.fy, current)}</p>
                        {C.emptyYearHint(kind.status, view.fy, current) && <p className="mt-1 text-muted type-caption">{C.emptyYearHint(kind.status, view.fy, current)}</p>}
                      </>
                    ) : (
                      <p className="type-table-strong">
                        {C.NO_MATCH}{" "}
                        <button type="button" onClick={clearFilters} className="text-accent hover:underline">
                          {C.CLEAR_FILTERS}
                        </button>
                      </p>
                    )}
                  </td>
                </tr>
              </tbody>
            ) : (
              state.groups.map((g) => (
                <tbody key={g.area} data-area={g.area}>
                  <GroupHeading group={g} span={span} />
                  {g.rows.map((r) => (
                    <ClosedRow
                      key={r.id}
                      row={r}
                      today={today}
                      selected={r.id === selectedId}
                      onSelect={() => setSelectedId(r.id === selectedId ? null : r.id)}
                      menu={canRestore ? <RestoreMenu name={r.name} initialOpen={demo?.menuOpenFor === r.id} onRestore={() => setConfirmId(r.id)} /> : null}
                    />
                  ))}
                </tbody>
              ))
            )}
          </table>
        </section>
      </main>

      {selected && (
        <ProjectDrawer
          row={selected}
          historyAction={historyAction}
          departments={list}
          today={today}
          onClose={() => setSelectedId(null)}
          peopleEditor={null}
          adminControls={null}
          headerAction={
            canRestore ? (
              <button type="button" onClick={() => setConfirmId(selected.id)} className={GHOST} data-testid="drawer-restore">
                {C.RESTORE}
              </button>
            ) : null
          }
        />
      )}
      {canRestore && confirmRow && restore?.[confirmRow.id] && (
        <RestoreDialog row={confirmRow} preview={restore[confirmRow.id]} action={restoreAction!} onCancel={() => setConfirmId(null)} onDone={(r) => onRestored(confirmRow, r)} />
      )}
      {toast && <ActionToast value={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function GroupHeading({ group, span }: { group: DashboardGroup<DashboardFyRow>; span: number }) {
  const edge = group.muted ? GroupedTableStyle.GROUP_EDGE_MUTED : GroupedTableStyle.GROUP_EDGE;
  const style: CSSProperties = { background: GroupedTableStyle.GROUP_HEADER_BG, boxShadow: `inset 3px 0 0 ${edge}` };
  return (
    <tr data-testid="group-header">
      <th colSpan={span} scope="colgroup" style={style} className="h-9 border-b border-line px-3 text-left align-middle">
        <div className="flex items-center justify-between gap-3">
          <span className={`text-[13px] leading-[18px] font-semibold uppercase tracking-[.04em] ${group.muted ? "text-muted" : "text-fg"}`}>{group.label}</span>
          <span className="font-normal text-muted type-table">{group.countText}</span>
        </div>
      </th>
    </tr>
  );
}

function Dash() {
  return <span className="text-muted">{C.EMPTY_CELL}</span>;
}

function ClosedRow({ row, today, selected, onSelect, menu }: { row: DashboardFyRow; today: string; selected: boolean; onSelect: () => void; menu: ReactNode }) {
  const td = `${CELL} ${selected ? "bg-row-selected" : ""}`;
  const req = InforNumber.format(row.inforRequestNumber);
  const requester = Requester.display(row.physicianChampion, row.requesterNotApplicable);
  return (
    <tr data-row-key={row.id} onClick={onSelect} aria-selected={selected} className="cursor-pointer hover:[&>td]:bg-row-selected/60">
      <td className={`${td} type-table-strong ${selected ? "shadow-[inset_3px_0_0_var(--dark-accent)]" : ""}`}>
        <div className="truncate" title={row.name}>
          {row.name}
        </div>
        {req && <div className="truncate text-[12px] leading-4 font-normal text-muted" data-testid="closed-infor">{req}</div>}
      </td>
      <td className={`${td} truncate`}>{Assignee.isAssigned(row.owner) ? row.owner : <Dash />}</td>
      <td className={`${td} truncate`}>{requester && !requester.muted ? requester.text : <Dash />}</td>
      <td className={`${td} whitespace-nowrap`}>{ReportFormat.shortDate(row.closedOn, today)}</td>
      <td className={td}>
        {row.finalUpdate ? (
          <div className="line-clamp-2 text-muted" title={row.finalUpdate} data-testid="final-update">
            {row.finalUpdate}
          </div>
        ) : (
          <Dash />
        )}
      </td>
      {menu !== null && (
        <td className={`${td} text-right`} onClick={(e) => e.stopPropagation()}>
          {menu}
        </td>
      )}
    </tr>
  );
}

/** The row's ⋯ menu (Admin > People style) with its one item. */
function RestoreMenu({ name, onRestore, initialOpen }: { name: string; onRestore: () => void; initialOpen?: boolean }) {
  const { open, setOpen, rootRef } = usePopover();
  useEffect(() => {
    if (initialOpen) setOpen(true);
  }, [initialOpen, setOpen]);
  const run = () => {
    setOpen(false);
    onRestore();
  };
  return (
    <div ref={rootRef} className="relative inline-block">
      <button type="button" className="df-icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`${C.ROW_MENU_LABEL}: ${name}`} onClick={() => setOpen(!open)}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="7" r="1.3" />
          <circle cx="7" cy="7" r="1.3" />
          <circle cx="11" cy="7" r="1.3" />
        </svg>
      </button>
      {open && (
        <ul role="menu" className="vp-pop vp-list w-[160px] p-1 text-left">
          <li role="menuitem" tabIndex={0} className="cursor-pointer" onClick={run} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && run()}>
            {C.RESTORE}
          </li>
        </ul>
      )}
    </div>
  );
}

/** Standard confirmation (not the danger style); the body names the status it goes back to. */
function RestoreDialog({
  row,
  preview,
  action,
  onCancel,
  onDone,
}: {
  row: DashboardFyRow;
  preview: RestorePreview;
  action: (projectId: string) => Promise<RestoreActionResult>;
  onCancel: () => void;
  onDone: (r: Extract<RestoreActionResult, { ok: true }>) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const cancel = useCallback(() => !pending && onCancel(), [pending, onCancel]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="restore-title" aria-describedby="restore-body" data-testid="restore-dialog" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="restore-title" className="type-heading">
          {C.restoreTitle(row.name)}
        </h2>
        <p id="restore-body" className="type-table text-muted">
          {C.restoreBody(preview.statusLabel, preview.fromHistory)}
        </p>
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={cancel} className={GHOST}>
            {C.RESTORE_BACK}
          </button>
          <button
            type="button"
            autoFocus
            disabled={pending}
            className={PRIMARY}
            onClick={() =>
              start(async () => {
                setError(null);
                try {
                  const r = await action(row.id);
                  if (r.ok) onDone(r);
                  else setError(r.error);
                } catch {
                  setError(C.RESTORE_ERROR);
                }
              })
            }
          >
            {C.RESTORE_CONFIRM}
          </button>
        </div>
      </div>
    </div>
  );
}

function FyPicker({ years, current, value, onChange, initialOpen }: { years: readonly string[]; current: string; value: string; onChange: (fy: string) => void; initialOpen?: boolean }) {
  const { open, setOpen, rootRef } = usePopover();
  useEffect(() => {
    if (initialOpen) setOpen(true);
  }, [initialOpen, setOpen]);
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={`${C.FY_LABEL}: ${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="fy-picker"
        className="flex h-8 items-center gap-1.5 rounded-control border border-line bg-input pr-2 pl-2.5 text-muted type-table hover:border-(--dark-text-secondary)"
      >
        {C.FY_LABEL}
        <span className="text-fg type-table-strong">{C.fyOption(value, current)}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5L5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={C.FY_LABEL} className="absolute right-0 z-[6] mt-1 min-w-[170px] rounded-card border border-line bg-card py-1 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
          {years.map((y) => (
            <button
              key={y}
              type="button"
              role="menuitemradio"
              aria-checked={y === value}
              onClick={() => {
                onChange(y);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left type-table hover:bg-row-selected ${y === value ? "text-fg" : "text-muted"}`}
            >
              {C.fyOption(y, current)}
              {y === value && <span aria-hidden>&#10003;</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Loading state: skeleton heading bars and rows (loading.tsx of both pages). */
export function ClosedPageSkeleton() {
  const bar = "animate-pulse rounded bg-input motion-reduce:animate-none";
  return (
    <div className="flex flex-col gap-4 px-6 pt-[76px] pb-6" aria-busy="true" aria-label={C.LOADING} data-testid="closed-skeleton">
      <div className={`${bar} h-6 w-56`} />
      <div className={`${bar} h-3 w-40`} />
      <div className="overflow-hidden rounded-card border border-line bg-card">
        {[0, 1].map((g) => (
          <div key={g}>
            <div className="h-9 border-b border-line" style={{ background: GroupedTableStyle.GROUP_HEADER_BG }}>
              <div className={`${bar} mt-3 ml-3 h-3 w-24 bg-line`} />
            </div>
            {[0, 1, 2].map((r) => (
              <div key={r} className="flex h-12 items-center gap-6 border-b border-line px-3">
                <div className={`${bar} h-3 flex-1`} />
                <div className={`${bar} h-3 w-28`} />
                <div className={`${bar} h-3 w-28`} />
                <div className={`${bar} h-3 w-16`} />
                <div className={`${bar} h-3 w-1/4`} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
