"use client";

import { Assignee } from "@/lib/domain/Assignee";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { FiscalYearSections, FySectionCopy, type DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { ServiceAreaInfo, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { ClosedStatus } from "@/lib/report/ClosedProjects";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { GroupedTableStyle } from "./DashboardTable";
import { usePopover } from "./DashboardFilterControls";

const CELL = "border-b border-line px-3 py-[10px] align-top";
const HEAD = "h-8 border-b border-line bg-card px-3 text-left align-middle uppercase tracking-[.04em] text-muted type-label";

/**
 * "Completed FY27" (expanded) and "Cancelled FY27" (collapsed) below the last department group: header bars in the
 * department heading style with a chevron and the count, flat rows newest first (no grips, no drag). The FY
 * picker in the Completed header changes only these two sections. `rows` are already filtered by the dashboard
 * department filter and search; `allRows` (unfiltered) decide which years the picker lists.
 */
export function FiscalYearSectionsView({
  rows,
  allRows,
  today,
  departments,
  selectedId,
  onSelect,
  renderMeta,
  initialYear,
  initialOpen,
}: {
  rows: readonly DashboardFyRow[];
  allRows: readonly DashboardFyRow[];
  today: string;
  departments?: DepartmentList;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  renderMeta: (row: DashboardRow) => ReactNode;
  /** Review and tests only. */
  initialYear?: string;
  initialOpen?: Partial<Record<ClosedStatus, boolean>>;
}) {
  const current = FiscalYearSections.currentLabel(today);
  const years = FiscalYearSections.years(allRows, today);
  const [fy, setFy] = useState(initialYear && years.includes(initialYear) ? initialYear : current);
  const [open, setOpen] = useState<Record<ClosedStatus, boolean>>({ ...FiscalYearSections.DEFAULT_OPEN, ...initialOpen });
  return (
    <div data-testid="fy-sections">
      {(["Complete", "Cancelled"] as const).map((status) => {
        const list = FiscalYearSections.section(rows, fy, status);
        return (
          <section key={status} data-testid={`fy-section-${status}`} aria-label={FySectionCopy.heading(status, fy, list.length)}>
            <div aria-hidden="true" className="h-6" />
            <SectionHeader
              status={status}
              heading={FySectionCopy.heading(status, fy, list.length)}
              open={open[status]}
              onToggle={() => setOpen((o) => ({ ...o, [status]: !o[status] }))}
              picker={status === "Complete" ? <FyPicker years={years} current={current} value={fy} onChange={setFy} /> : null}
            />
            {open[status] && (
              <table className="w-full table-fixed border-separate border-spacing-0 type-table" data-testid={`fy-table-${status}`}>
                <colgroup>
                  <col />
                  <col style={{ width: 112 }} />
                  <col style={{ width: 170 }} />
                  <col style={{ width: 112 }} />
                  <col style={{ width: "34%" }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" className={HEAD}>{FySectionCopy.PROJECT}</th>
                    <th scope="col" className={HEAD}>{FySectionCopy.DEPARTMENT}</th>
                    <th scope="col" className={HEAD}>{FySectionCopy.OWNER}</th>
                    <th scope="col" className={HEAD}>{FySectionCopy.dateHeader(status)}</th>
                    <th scope="col" className={HEAD}>{FySectionCopy.FINAL_UPDATE}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.length === 0 && (
                    <tr>
                      <td colSpan={5} className={`${CELL} text-muted`} data-testid={`fy-empty-${status}`}>
                        {FySectionCopy.empty(status, fy, current)}
                      </td>
                    </tr>
                  )}
                  {list.map((r) => {
                    const selected = r.id === selectedId;
                    const td = `${CELL} ${selected ? "bg-row-selected" : ""}`;
                    const area = ServiceAreaInfo.groupOf(r.serviceArea);
                    return (
                      <tr
                        key={r.id}
                        data-fy-row={r.id}
                        onClick={() => onSelect(selected ? null : r.id)}
                        aria-selected={selected}
                        className="cursor-pointer hover:[&>td]:bg-row-selected/60"
                      >
                        <td className={`${td} type-table-strong ${selected ? "shadow-[inset_3px_0_0_var(--dark-accent)]" : ""}`}>
                          <div className="truncate" title={r.name}>
                            {r.name}
                          </div>
                          {renderMeta(r)}
                        </td>
                        <td className={td}>
                          <span
                            data-testid="fy-dept-tag"
                            className="inline-block max-w-full truncate rounded-[4px] border border-line bg-input px-1.5 text-[11px] leading-4 font-medium text-muted"
                          >
                            {ServiceAreaInfo.label(area, departments)}
                          </span>
                        </td>
                        <td className={`${td} truncate`}>{Assignee.isAssigned(r.owner) ? r.owner : <span className="text-muted">{Assignee.TO_ASSIGN}</span>}</td>
                        <td className={`${td} whitespace-nowrap`}>{ReportFormat.shortDate(r.closedOn, today)}</td>
                        <td className={td}>
                          <div className="truncate text-muted" title={r.finalUpdate ?? undefined}>
                            {r.finalUpdate ?? ""}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className={`shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-90" : ""}`}>
      <path d="M4.5 2.5L8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SectionHeader({ status, heading, open, onToggle, picker }: { status: ClosedStatus; heading: string; open: boolean; onToggle: () => void; picker: ReactNode }) {
  const style: CSSProperties = { background: GroupedTableStyle.GROUP_HEADER_BG, boxShadow: `inset 3px 0 0 ${GroupedTableStyle.GROUP_EDGE}` };
  return (
    <div style={style} className="flex h-9 items-center justify-between gap-3 border-b border-line px-3" data-testid={`fy-header-${status}`}>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 items-center gap-2 text-fg">
        <Chevron open={open} />
        <span className="truncate text-[13px] leading-[18px] font-semibold tracking-[.04em]">{heading}</span>
      </button>
      {picker}
    </div>
  );
}

function FyPicker({ years, current, value, onChange }: { years: readonly string[]; current: string; value: string; onChange: (fy: string) => void }) {
  const { open, setOpen, rootRef } = usePopover();
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={FySectionCopy.PICKER_LABEL}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="fy-picker"
        className="flex h-6 items-center gap-1 rounded-control border border-line bg-card px-2 text-fg type-table-strong hover:border-(--dark-text-secondary)"
      >
        {value}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5L5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={FySectionCopy.PICKER_LABEL} className="absolute right-0 z-[6] mt-1 min-w-[150px] rounded-card border border-line bg-card py-1 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
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
              {FySectionCopy.option(y, current)}
              {y === value && <span aria-hidden>&#10003;</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
