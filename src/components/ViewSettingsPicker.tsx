"use client";

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ProjectStatus, ViewContext } from "@/generated/prisma/enums";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { DashboardColumnModel, type PickerEntry } from "@/lib/dashboard/DashboardColumnModel";
import { LayoutCopy } from "@/lib/layout/LineLayout";
import { TopBarCopy } from "@/lib/layout/TopBarCopy";
import { LayoutResetDialog, type LayoutResetKind } from "./LayoutResetDialog";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { StatusCounts } from "@/lib/domain/types";
import {
  ViewSettings,
  type ViewColumn,
  type ViewSettingsByContext,
  type ViewSettingsValue,
} from "@/lib/domain/ViewSettings";

/**
 * ADMIN ONLY. Render only when the viewer is an admin (ProjectDashboard does this).
 * "View" button + 320px panel for column and status show/hide (design: portfolio-tracker-mockups/picker.html).
 * Self-contained: styles live in src/styles/view-picker.css (vp-* classes) so it can be restyled alone.
 * Dashboard changes are applied immediately through onSave; Report changes are a local draft until
 * "Save report view".
 */
export interface ViewSettingsPickerProps {
  settings: ViewSettingsByContext;
  /** Admin-only per-status counts shown next to each status. */
  counts: Record<ViewContext, StatusCounts>;
  /** Persist a context. Resolves to an error message, or null on success. */
  onSave: (context: ViewContext, value: ViewSettingsValue) => Promise<string | null>;
  /** "Reset columns" and "Reset row order" for the active line (bottom of the menu, each with a confirmation). */
  layoutReset?: LayoutResetProps;
  /** Top bar fit step 4 (TopBarFit): the icon and the hidden count only; the label moves to the tooltip. */
  compact?: boolean;
}

export interface LayoutResetProps {
  /** Active line's short name, e.g. CVPSL. */
  shortName: string;
  onResetColumns: () => Promise<string | null>;
  onResetRows: () => Promise<string | null>;
}

class PickerCopy {
  static readonly SCOPE: Record<ViewContext, string> = {
    dashboard: "Changes apply to your live dashboard right away.",
    report: "Applies to the next report. Settings are saved with each frozen report, so past reports rebuild exactly.",
  };
  /** Same admin-only footnote on both tabs (picker.html). */
  static readonly NOTE = "Only you see this menu. Hidden items are left out of every count, flag, and export that others see.";
  static readonly TAB_LABEL: Record<ViewContext, string> = { dashboard: "Dashboard", report: "Report" };
}

export function ViewSettingsPicker({ settings, counts, onSave, layoutReset, compact = false }: ViewSettingsPickerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<ViewContext>("dashboard");
  const [reportDraft, setReportDraft] = useState<ViewSettingsValue>(settings.report);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<LayoutResetKind | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Opened from the admin menu "Dashboard view" item: an event on "/", or "/#view-settings" from other pages.
  useEffect(() => {
    const openFromMenu = () => {
      setReportDraft(settings.report);
      setError(null);
      setSaved(false);
      setOpen(true);
    };
    if (window.location.hash === AdminMenu.VIEW_SETTINGS_HASH) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      openFromMenu();
    }
    window.addEventListener(AdminMenu.OPEN_VIEW_SETTINGS_EVENT, openFromMenu);
    return () => window.removeEventListener(AdminMenu.OPEN_VIEW_SETTINGS_EVENT, openFromMenu);
  }, [settings.report]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const inDialog = e.target instanceof Element && e.target.closest("[data-layout-dialog]");
      if (rootRef.current && !rootRef.current.contains(e.target as Node) && !inDialog) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc closes the reset confirmation first, then the menu.
      if (confirm) setConfirm(null);
      else setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, confirm]);

  const value = tab === "dashboard" ? settings.dashboard : reportDraft;
  const reportDirty = !ViewSettings.equals(reportDraft, settings.report);
  const hidden = ViewSettings.hiddenCount(settings.dashboard);

  const change = async (next: ViewSettingsValue) => {
    setError(null);
    setSaved(false);
    if (tab === "report") {
      setReportDraft(next);
      return;
    }
    const err = await onSave("dashboard", next);
    if (err) setError(err);
  };

  const saveReport = async () => {
    setSaving(true);
    setError(null);
    const err = await onSave("report", reportDraft);
    setSaving(false);
    if (err) setError(err);
    else setSaved(true);
  };

  const toggleOpen = () => {
    if (!open) {
      setReportDraft(settings.report);
      setError(null);
      setSaved(false);
    }
    setOpen(!open);
  };

  return (
    <div ref={rootRef} className="vp-root">
      <button
        type="button"
        className="vp-trigger tap-44"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggleOpen}
        aria-label={compact ? TopBarCopy.viewIcon(hidden) : undefined}
        title={compact ? TopBarCopy.viewIcon(hidden) : undefined}
        data-compact={compact ? "" : undefined}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M1 3h12M3 7h8M5 11h4" stroke="currentColor" strokeWidth="1.5" fill="none" />
        </svg>
        {compact ? (
          hidden > 0 && (
            <span className="vp-badge" aria-hidden="true">
              {hidden}
            </span>
          )
        ) : (
          <>
            {AdminMenu.DASHBOARD_VIEW}
            {hidden > 0 && <span className="vp-badge">{hidden} hidden</span>}
          </>
        )}
      </button>

      {open && (
        <div className="vp-pop" role="dialog" aria-label={AdminMenu.DASHBOARD_VIEW}>
          <div className="vp-seg" role="tablist">
            {ViewSettings.CONTEXTS.map((c) => (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={tab === c}
                className={tab === c ? "vp-act" : ""}
                onClick={() => {
                  setTab(c);
                  setError(null);
                  setSaved(false);
                }}
              >
                {PickerCopy.TAB_LABEL[c]}
              </button>
            ))}
          </div>
          <p className="vp-scope">{PickerCopy.SCOPE[tab]}</p>

          <ColumnList context={tab} value={value} onChange={change} />

          <h3 className="vp-h3">Statuses</h3>
          <ul className="vp-list">
            {ProjectStatusInfo.all().map((s) => (
              <StatusItem
                key={s}
                status={s}
                count={counts[tab][s]}
                visible={ViewSettings.isStatusVisible(value, s)}
                onToggle={(visible) => change(ViewSettings.withStatusHidden(tab, value, s, !visible))}
              />
            ))}
          </ul>
          <p className="vp-note">{PickerCopy.NOTE}</p>
          {error && (
            <p role="alert" className="vp-error">
              {error}
            </p>
          )}

          <div className="vp-foot">
            <button type="button" className="vp-link" onClick={() => change(ViewSettings.defaults(tab))}>
              Reset to defaults
            </button>
            {tab === "report" && (
              <span className="vp-foot-right">
                {saved && !reportDirty && <span className="vp-saved">Saved</span>}
                <button type="button" className="vp-primary" disabled={saving || !reportDirty} onClick={saveReport}>
                  {saving ? "Saving..." : "Save report view"}
                </button>
              </span>
            )}
          </div>
          {layoutReset && (
            <div className="vp-layout" data-testid="layout-resets">
              <button type="button" className="vp-link" onClick={() => setConfirm("columns")}>
                {LayoutCopy.RESET_COLUMNS}
              </button>
              <button type="button" className="vp-link" onClick={() => setConfirm("rows")}>
                {LayoutCopy.RESET_ROWS}
              </button>
            </div>
          )}
        </div>
      )}
      {open && confirm && layoutReset && (
        <LayoutResetDialog
          kind={confirm}
          shortName={layoutReset.shortName}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const err = await (confirm === "columns" ? layoutReset.onResetColumns() : layoutReset.onResetRows());
            if (!err) {
              setConfirm(null);
              setOpen(false);
            }
            return err;
          }}
        />
      )}
    </div>
  );
}

function ColumnList({
  context,
  value,
  onChange,
}: {
  context: ViewContext;
  value: ViewSettingsValue;
  onChange: (next: ViewSettingsValue) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  // One entry per column; on the dashboard, keys that stack in one cell (People; Next milestone / Latest
  // update; Due / Flags) are one group entry that moves as a block and shows each field's own checkbox.
  const entries = DashboardColumnModel.pickerEntries(context, value);

  const move = (from: number, toIndex: number) => onChange(DashboardColumnModel.moveEntry(context, value, from, toIndex));

  const onDrop = (e: DragEvent, index: number) => {
    e.preventDefault();
    if (dragging !== null) move(dragging, dragging < index ? index - 1 : index);
    setDragging(null);
    setOverIndex(null);
  };

  const onGripKey = (e: ReactKeyboardEvent, index: number) => {
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      move(index, index - 1);
    } else if (e.key === "ArrowDown" && index < entries.length - 1) {
      e.preventDefault();
      move(index, index + 1);
    }
  };

  const entryKey = (entry: PickerEntry) => (entry.kind === "group" ? entry.stack : entry.column);
  const entryLabel = (entry: PickerEntry) => (entry.kind === "group" ? entry.label : ViewSettings.columnLabel(context, entry.column));

  return (
    <>
      <h3 className="vp-h3">
        Columns <span>Drag to reorder</span>
      </h3>
      <ul className="vp-list" onDragEnd={() => {
          setDragging(null);
          setOverIndex(null);
        }}>
        {entries.map((entry, i) => {
          const label = entryLabel(entry);
          const locked = entry.kind === "column" && ViewSettings.isLocked(entry.column);
          return (
            <li
              key={entryKey(entry)}
              draggable
              data-entry={entryKey(entry)}
              onDragStart={(e) => {
                setDragging(i);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", entryKey(entry));
              }}
              onDragOver={(e) => {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setOverIndex(e.clientY > rect.top + rect.height / 2 ? i + 1 : i);
              }}
              onDrop={(e) => onDrop(e, overIndex ?? i)}
              className={[
                locked ? "vp-locked" : "",
                entry.kind === "group" ? "vp-group" : "",
                dragging === i ? "vp-dragging" : "",
                overIndex === i ? "vp-drop-before" : "",
                overIndex === i + 1 && i === entries.length - 1 ? "vp-drop-after" : "",
              ].join(" ")}
            >
              <button
                type="button"
                className="vp-grip"
                aria-label={`Move ${label}. Use arrow up and down.`}
                onKeyDown={(e) => onGripKey(e, i)}
              >
                ⋮⋮
              </button>
              {entry.kind === "group" ? (
                <div className="vp-group-body" role="group" aria-label={label}>
                  <span className="vp-subhead">{label}</span>
                  {entry.columns.map((c) => (
                    <ColumnCheck key={c} context={context} value={value} column={c} onChange={onChange} />
                  ))}
                </div>
              ) : (
                <>
                  <ColumnCheck context={context} value={value} column={entry.column} onChange={onChange} />
                  {locked && <span className="vp-hint">Always shown</span>}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function ColumnCheck({
  context,
  value,
  column,
  onChange,
}: {
  context: ViewContext;
  value: ViewSettingsValue;
  column: ViewColumn;
  onChange: (next: ViewSettingsValue) => void;
}) {
  const locked = ViewSettings.isLocked(column);
  const visible = ViewSettings.isColumnVisible(value, column);
  return (
    <label className="vp-check">
      <input
        type="checkbox"
        className="sr-only"
        checked={visible}
        disabled={locked}
        onChange={(e) => onChange(ViewSettings.withColumnHidden(context, value, column, !e.target.checked))}
      />
      <CheckBox on={visible} locked={locked} />
      <span className="vp-lbl">{ViewSettings.columnLabel(context, column)}</span>
    </label>
  );
}

function StatusItem({
  status,
  count,
  visible,
  onToggle,
}: {
  status: ProjectStatus;
  count: number;
  visible: boolean;
  onToggle: (visible: boolean) => void;
}) {
  return (
    <li className={visible ? "" : "vp-off"}>
      <label className="vp-check">
        <input type="checkbox" className="sr-only" checked={visible} onChange={(e) => onToggle(e.target.checked)} />
        <CheckBox on={visible} />
        <span className={`pill st-${status}`}>{ProjectStatusInfo.label(status)}</span>
      </label>
      {!visible && ViewSettings.isDefaultHiddenStatus(status) && <span className="vp-hint">Hidden by default</span>}
      <span className="vp-count">{count}</span>
    </li>
  );
}

function CheckBox({ on, locked = false }: { on: boolean; locked?: boolean }) {
  return (
    <span className={`vp-box ${on ? "vp-on" : ""} ${locked ? "vp-box-locked" : ""}`} aria-hidden>
      {locked ? (
        <svg width="10" height="12" viewBox="0 0 10 12">
          <rect x="1" y="5" width="8" height="6" rx="1.5" fill="currentColor" />
          <path d="M3 5V3.5a2 2 0 014 0V5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      ) : on ? (
        <svg width="10" height="8" viewBox="0 0 10 8">
          <path d="M1 4l3 3 5-6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      ) : null}
    </span>
  );
}
