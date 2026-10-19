"use client";

import type { DepartmentKey, DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import { useActionState, useState } from "react";
import { saveReportOptions } from "@/app/actions/reports";
import { TotalsGridPlacement, type TotalsGridMode } from "@/lib/domain/TotalsGridPlacement";
import type { ReportOptionsFormState } from "@/lib/services/ReportOptionsForm";
import { ReportSettingsCopy } from "@/lib/admin/ReportSettingsCopy";
import { DepartmentChecklist } from "./DashboardFilterControls";

/** Admin "Report" section: departments in report (checkbox list, one always checked) and the totals grid placement. */
export function ReportSettingsForm({
  departments,
  totalsGrid,
  showWaitingOn = true,
  options,
  list,
  scheduled = true,
}: {
  departments: DepartmentKey[];
  totalsGrid: TotalsGridMode;
  /** "Waiting on" line under blocked projects (on by default). */
  showWaitingOn?: boolean;
  /** The active line's department filter options. */
  options?: readonly DepartmentKey[];
  /** The line's departments (checkbox labels). */
  list?: DepartmentList;
  /** False for lines other than the default: they have on-demand PDFs only. */
  scheduled?: boolean;
}) {
  const [state, action, pending] = useActionState<ReportOptionsFormState, FormData>(saveReportOptions, null);
  const [selected, setSelected] = useState<DepartmentKey[]>(departments);
  const [mode, setMode] = useState<TotalsGridMode>(totalsGrid);
  return (
    <form action={action} className="flex max-w-[520px] flex-col gap-4">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 type-label text-muted">Departments in report</legend>
        <div className="max-w-[260px]">
          <DepartmentChecklist value={selected} onChange={setSelected} name="departments" options={options} list={list} />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 type-label text-muted">Summary grid</legend>
        <input type="hidden" name="totalsGrid" value={mode} />
        <div role="radiogroup" aria-label="Summary grid" className="vp-seg df-seg3">
          {TotalsGridPlacement.MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "vp-act" : ""} onClick={() => setMode(m)}>
              {TotalsGridPlacement.LABELS[m]}
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{TotalsGridPlacement.HELP}</p>
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 type-label text-muted">{ReportSettingsCopy.WAITING_LEGEND}</legend>
        <input type="hidden" name="waitingOnField" value="1" />
        <label className="flex items-center gap-2 type-table">
          <input type="checkbox" name="showWaitingOn" defaultChecked={showWaitingOn} data-testid="report-show-waiting-on" />
          {ReportSettingsCopy.WAITING_LABEL}
        </label>
        <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{ReportSettingsCopy.WAITING_HELP}</p>
      </fieldset>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="h-8 rounded-control bg-accent px-3.5 text-white type-table-strong disabled:opacity-60">
          {pending ? "Saving…" : "Save"}
        </button>
        {state && (
          <span role="status" className={`type-caption ${state.ok ? "text-muted" : "text-danger"}`}>
            {state.message}
          </span>
        )}
      </div>
      <p className="type-caption text-muted">
        {scheduled
          ? "Used by Generate PDF now and the biweekly report. Frozen reports keep the settings they were frozen with."
          : "Used by Generate PDF now. The biweekly report is for CVPSL only."}
      </p>
    </form>
  );
}
