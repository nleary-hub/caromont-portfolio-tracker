"use client";

import { useActionState, useState } from "react";
import type { ServiceArea } from "@/generated/prisma/enums";
import { saveReportOptions } from "@/app/actions/reports";
import { TotalsGridPlacement, type TotalsGridMode } from "@/lib/domain/TotalsGridPlacement";
import type { ReportOptionsFormState } from "@/lib/services/ReportOptionsForm";
import { DepartmentChecklist } from "./DashboardFilterControls";

/** Admin "Report" section: departments in report (checkbox list, one always checked) and the totals grid placement. */
export function ReportSettingsForm({
  departments,
  totalsGrid,
  options,
  scheduled = true,
}: {
  departments: ServiceArea[];
  totalsGrid: TotalsGridMode;
  /** The active line's department filter options. */
  options?: readonly ServiceArea[];
  /** False for lines other than the default: they have on-demand PDFs only. */
  scheduled?: boolean;
}) {
  const [state, action, pending] = useActionState<ReportOptionsFormState, FormData>(saveReportOptions, null);
  const [selected, setSelected] = useState<ServiceArea[]>(departments);
  const [mode, setMode] = useState<TotalsGridMode>(totalsGrid);
  return (
    <form action={action} className="flex max-w-[520px] flex-col gap-4">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 type-label text-muted">Departments in report</legend>
        <div className="max-w-[260px]">
          <DepartmentChecklist value={selected} onChange={setSelected} name="departments" options={options} />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 type-label text-muted">Totals grid</legend>
        <input type="hidden" name="totalsGrid" value={mode} />
        <div role="radiogroup" aria-label="Totals grid" className="vp-seg df-seg3">
          {TotalsGridPlacement.MODES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "vp-act" : ""} onClick={() => setMode(m)}>
              {TotalsGridPlacement.LABELS[m]}
            </button>
          ))}
        </div>
        <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{TotalsGridPlacement.HELP}</p>
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
