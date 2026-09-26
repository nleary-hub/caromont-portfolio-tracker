"use client";

import type { CSSProperties, ReactNode } from "react";
import {
  DashboardColumnModel,
  type DashboardColumn,
  type DueFlagsVisibility,
  type MilestoneUpdateVisibility,
  type PeopleVisibility,
} from "@/lib/dashboard/DashboardColumnModel";
import { CompletedBlockCopy, DashboardGroups, type DashboardGroup } from "@/lib/dashboard/DashboardGroups";
import type { DashboardCompletedRow, DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { PeopleStack, type PeopleLine } from "@/lib/dashboard/PeopleStack";
import { DueFlags, MilestoneUpdateStack, type DueFlagKind, type DueFlagsCell, type MilestoneUpdateLine } from "@/lib/dashboard/StackedCells";
import { InforNumber } from "@/lib/domain/InforNumber";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { StatusPill } from "./StatusPill";
import { StatusShape } from "./StatusShape";

export interface DashboardTableProps {
  /** Filtered regular rows, in report order. */
  rows: readonly DashboardRow[];
  /** Filtered "Completed this period" rows. */
  completed: readonly DashboardCompletedRow[];
  /** Dashboard view settings (drives the one column model shared by every group). */
  settings: ViewSettingsValue;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  today: string;
  /** Shown when there is nothing to list. */
  emptyText: string;
  /** Meta line under the project name ("REQ-5081  Updated Sep 24"). */
  renderMeta: (row: DashboardRow) => ReactNode;
}

/** Dark-theme styling of the grouped table (Figma spec; dark versions of the PDF tokens). */
class GroupedTableStyle {
  /** Department header row: PDF section head. The PDF fill (#F4F5F7) has no dark token; --dark-input is the closest. */
  static readonly GROUP_HEADER_BG = "var(--dark-input)";
  /** PDF section edge: primary text color, Unassigned in the secondary gray. */
  static readonly GROUP_EDGE = "var(--dark-text-primary)";
  static readonly GROUP_EDGE_MUTED = "var(--dark-text-secondary)";
  /** Completed block: PDF accent #0E6961 and tint #F4FBFA map to the dark complete tokens (tint mixed into the card). */
  static readonly COMPLETE_ACCENT = "var(--status-complete-dark-fg)";
  static readonly COMPLETE_TINT = "color-mix(in srgb, var(--status-complete-dark-bg) 45%, var(--dark-card))";
  static readonly HEADER_H = 36;
}

/**
 * The grouped dashboard table: one <table> with one <colgroup> from DashboardColumnModel, one sticky
 * column header, then one <tbody> per department (DashboardGroups, PDF order) with a sticky 36px group
 * header, the rows (keyed by project id) and the department's "Completed this period" block at the end.
 * The first column is the reserved 24px gutter for the later row drag grip.
 */
export function DashboardTable({ rows, completed, settings, selectedId, onSelect, today, emptyText, renderMeta }: DashboardTableProps) {
  const columns = DashboardColumnModel.columns(settings);
  const people = DashboardColumnModel.peopleVisibility(settings);
  const stack = DashboardColumnModel.milestoneUpdateVisibility(settings);
  const dueFlags = DashboardColumnModel.dueFlagsVisibility(settings);
  const showInfor = settings.columnOrder.includes("inforNumber") && !settings.hiddenColumns.includes("inforNumber");
  const groups = DashboardGroups.group(rows, completed);
  const span = columns.length;
  return (
    <table
      className="w-full table-fixed border-separate border-spacing-0 type-table"
      style={{ minWidth: DashboardColumnModel.minTableWidth(columns) }}
      data-testid="dashboard-table"
    >
      <colgroup>
        {columns.map((c) => (
          <col key={c.key} data-col={c.key} style={c.flex ? { minWidth: c.minWidth } : { width: c.width }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          {columns.map((c) =>
            c.structural ? (
              <td key={c.key} aria-hidden="true" className="sticky top-0 z-[3] h-9 border-b border-line bg-card p-0" />
            ) : (
              <th
                key={c.key}
                scope="col"
                data-col={c.key}
                className="sticky top-0 z-[3] h-9 truncate border-b border-line bg-card px-3 text-left uppercase tracking-[.04em] text-muted type-label"
              >
                {c.header}
              </th>
            ),
          )}
        </tr>
      </thead>
      {groups.length === 0 && (
        <tbody>
          <tr>
            <td colSpan={span} className="h-20 text-center text-muted">
              {emptyText}
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
          <GroupHeader group={g} span={span} />
          {g.rows.map((r) => (
            <ProjectRow
              key={r.id}
              row={r}
              columns={columns}
              people={people}
              stack={stack}
              dueFlags={dueFlags}
              today={today}
              selected={r.id === selectedId}
              onSelect={onSelect}
              renderMeta={renderMeta}
            />
          ))}
          {g.completed.length > 0 && (
            <CompletedBlock rows={g.completed} columns={columns} people={people} showInfor={showInfor} selectedId={selectedId} onSelect={onSelect} today={today} />
          )}
        </tbody>
      ))}
    </table>
  );
}

function GroupHeader({ group, span }: { group: DashboardGroup<DashboardRow, DashboardCompletedRow>; span: number }) {
  const edge = group.muted ? GroupedTableStyle.GROUP_EDGE_MUTED : GroupedTableStyle.GROUP_EDGE;
  const style: CSSProperties = { background: GroupedTableStyle.GROUP_HEADER_BG, boxShadow: `inset 3px 0 0 ${edge}`, top: GroupedTableStyle.HEADER_H };
  return (
    <tr data-testid="group-header">
      <th colSpan={span} scope="colgroup" style={style} className="sticky z-[2] h-9 border-b border-line px-3 text-left align-middle">
        <span className={`text-[13px] leading-[18px] font-semibold uppercase tracking-[.04em] ${group.muted ? "text-muted" : "text-fg"}`}>{group.label}</span>
        <span className="ml-2 font-normal text-muted type-table">{group.countText}</span>
      </th>
    </tr>
  );
}

const CELL = "border-b border-line px-3 py-[10px] align-top";

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
}) {
  const td = `${CELL} ${selected ? "bg-row-selected" : ""}`;
  return (
    <tr
      data-row-key={row.id}
      onClick={() => onSelect(selected ? null : row.id)}
      className="cursor-pointer hover:[&>td]:bg-row-selected/60"
      aria-selected={selected}
    >
      {columns.map((c) => {
        switch (c.key) {
          case "gutter":
            return <td key={c.key} aria-hidden="true" className={`${td} px-0`} />;
          case "project":
            return (
              <td key={c.key} className={`${td} type-table-strong ${selected ? "shadow-[inset_3px_0_0_var(--dark-accent)]" : ""}`}>
                <div className="truncate" title={row.name}>
                  {row.name}
                </div>
                {renderMeta(row)}
              </td>
            );
          case "people":
            return (
              <td key={c.key} className={td}>
                <PeopleCell lines={PeopleStack.lines(row, people)} />
              </td>
            );
          case "status":
            return (
              <td key={c.key} className={td}>
                <StatusPill status={row.status} />
              </td>
            );
          case "milestoneUpdate":
            return (
              <td key={c.key} className={td}>
                <MilestoneUpdateCell lines={MilestoneUpdateStack.lines(row, stack)} />
              </td>
            );
          case "dueFlags":
            return (
              <td key={c.key} className={td}>
                <DueFlagsCellView cell={DueFlags.cell(row, dueFlags, today)} />
              </td>
            );
        }
      })}
    </tr>
  );
}

/** Stacked People cell: up to three single-line entries at 13/18 with an ellipsis and the full text as a tooltip. */
export function PeopleCell({ lines }: { lines: readonly PeopleLine[] }) {
  return (
    <div className="flex flex-col text-[13px] leading-[18px]" data-testid="people-cell">
      {lines.map((l) => (
        <div key={l.kind} data-line={l.kind} title={l.title} className="truncate">
          {l.prefix && <span className="font-medium text-muted">{l.prefix} </span>}
          <span className={l.muted ? "font-normal text-muted" : "text-fg"}>{l.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Next milestone / Latest update, stacked like the PDF row: the milestone (13/18 primary, regular weight,
 * at most two lines, full text as a tooltip), then after a 2px gap the latest update (13/18, not clamped;
 * unchanged rows read "No change." and the whole line is secondary). Blank lines render nothing.
 */
export function MilestoneUpdateCell({ lines }: { lines: readonly MilestoneUpdateLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="flex flex-col text-[13px] leading-[18px]" style={{ gap: MilestoneUpdateStack.LINE_GAP_PX }} data-testid="milestone-update">
      {lines.map((l) =>
        l.kind === "milestone" ? (
          <div key="milestone" data-line="milestone" title={l.text} className="line-clamp-2 break-words font-normal text-fg">
            {l.text}
          </div>
        ) : (
          <div key="update" data-line="update" data-muted={l.muted || undefined} className={`break-words font-normal ${l.muted ? "text-muted" : "text-fg"}`}>
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
 * Due / Flags: the date, 6px, then the flag pills 4px apart. Pills never shrink or clip; when they do not fit they wrap to a line
 * under the date. Top-aligned with the row's first line.
 */
export function DueFlagsCellView({ cell }: { cell: DueFlagsCell }) {
  if (!cell.due && cell.flags.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-start text-[13px] leading-[18px]"
      style={{ columnGap: DueFlags.DUE_GAP_PX, rowGap: DueFlags.FLAG_GAP_PX }}
      data-testid="due-flags"
    >
      {cell.due && (
        <span
          data-part="due"
          className={`whitespace-nowrap ${cell.due.overdue ? "font-semibold text-danger" : cell.due.muted ? "text-muted" : "text-fg"}`}
        >
          {cell.due.text}
        </span>
      )}
      {cell.flags.length > 0 && (
        <span data-part="flags" className="flex flex-wrap" style={{ gap: DueFlags.FLAG_GAP_PX }}>
          {cell.flags.map((f) => (
            <DueFlagPill key={f.kind} kind={f.kind} label={f.label} />
          ))}
        </span>
      )}
    </div>
  );
}

/** One PDF flag pill in dark tokens: Changed and Stale dashed, Overdue filled. */
function DueFlagPill({ kind, label }: { kind: DueFlagKind; label: string }) {
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

/** Columns that keep their own cell in a completed row; the first other column starts the accomplishment span. */
const COMPLETED_OWN_CELLS = new Set(["gutter", "project", "people", "status"]);

function CompletedBlock({
  rows,
  columns,
  people,
  showInfor,
  selectedId,
  onSelect,
  today,
}: {
  rows: readonly DashboardCompletedRow[];
  columns: readonly DashboardColumn[];
  people: PeopleVisibility;
  showInfor: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  today: string;
}) {
  const tint: CSSProperties = { background: GroupedTableStyle.COMPLETE_TINT };
  const accent = GroupedTableStyle.COMPLETE_ACCENT;
  // The accomplishment spans the first run of columns that are not project, people or status (the note width).
  const spanStart = columns.findIndex((c) => !COMPLETED_OWN_CELLS.has(c.key));
  let spanLen = 0;
  if (spanStart >= 0) while (spanStart + spanLen < columns.length && !COMPLETED_OWN_CELLS.has(columns[spanStart + spanLen].key)) spanLen += 1;
  return (
    <>
      <tr data-testid="completed-header">
        <td aria-hidden="true" className="p-0" />
        <td colSpan={columns.length - 1} style={{ ...tint, boxShadow: `inset 2px 0 0 ${accent}`, color: accent }} className="h-7 px-3 align-middle">
          <div className="flex items-center justify-between gap-3 type-label">
            <span className="flex items-center gap-1.5 font-semibold tracking-[.04em]">
              <CheckIcon />
              {CompletedBlockCopy.HEADING}
            </span>
            <span className="font-normal">{CompletedBlockCopy.NOTE}</span>
          </div>
        </td>
      </tr>
      {rows.map((r) => {
        const selected = r.id === selectedId;
        const td = `${CELL} ${selected ? "bg-row-selected" : ""}`;
        const cells: ReactNode[] = [];
        columns.forEach((c, i) => {
          if (i > spanStart && i < spanStart + spanLen) return;
          const style = selected ? undefined : tint;
          if (i === spanStart) {
            cells.push(
              <td key="accomplishment" colSpan={spanLen} className={td} style={style}>
                {r.accomplishment && (
                  <div title={r.accomplishment} className="line-clamp-2 text-[13px] leading-[18px] text-fg" data-testid="accomplishment">
                    {r.accomplishment}
                  </div>
                )}
              </td>,
            );
            return;
          }
          switch (c.key) {
            case "gutter":
              cells.push(<td key={c.key} aria-hidden="true" className={`${td} px-0`} />);
              return;
            case "project": {
              const req = showInfor ? InforNumber.format(r.inforRequestNumber) : null;
              cells.push(
                <td key={c.key} className={`${td} type-table-strong`} style={{ ...style, boxShadow: `inset 2px 0 0 ${accent}` }}>
                  <div className="truncate" title={r.name}>
                    {r.name}
                  </div>
                  {req && <div className="font-mono text-[9px] font-normal text-[#B8BEC8]">{req}</div>}
                </td>,
              );
              return;
            }
            case "people":
              cells.push(
                <td key={c.key} className={td} style={style}>
                  <PeopleCell lines={PeopleStack.lines(r, people)} />
                </td>,
              );
              return;
            case "status":
              cells.push(
                <td key={c.key} className={td} style={style}>
                  <span className="flex items-center gap-1 font-medium" style={{ color: accent }} data-testid="completed-date">
                    <CheckIcon />
                    {ReportFormat.shortDate(r.completedOn, today)}
                  </span>
                </td>,
              );
              return;
            default:
              cells.push(<td key={c.key} className={td} style={style} />);
          }
        });
        return (
          <tr
            key={r.id}
            data-row-key={r.id}
            data-completed="true"
            onClick={() => onSelect(selected ? null : r.id)}
            className="cursor-pointer hover:[&>td]:bg-row-selected/60"
            aria-selected={selected}
          >
            {cells}
          </tr>
        );
      })}
    </>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" className="flex-none">
      <path d="M1.5 5.2 4 7.5 8.5 2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
