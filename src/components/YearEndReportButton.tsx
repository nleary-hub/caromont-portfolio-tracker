"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { generateYearEndReport } from "@/app/actions/reports";
import { YearEndCategories, YearEndCopy, type YearEndCategory } from "@/lib/report/YearEndReportData";

const GHOST = "h-8 rounded-control border border-line px-3.5 type-table-strong hover:text-fg";
const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";

/**
 * Admin "Year-end report" (secondary, next to the report actions): a dialog with the fiscal year (current by
 * default) and Generate PDF. The server stores the file (listed below the archive) and the browser downloads it.
 */
export function YearEndReportButton({ years, current, initialOpen = false }: { years: readonly string[]; current: string; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" className={GHOST} onClick={() => setOpen(true)} aria-haspopup="dialog" data-testid="year-end-button">
        {YearEndCopy.BUTTON}
      </button>
      {open && <YearEndDialog years={years} current={current} onClose={() => setOpen(false)} />}
    </>
  );
}

function YearEndDialog({ years, current, onClose }: { years: readonly string[]; current: string; onClose: () => void }) {
  const router = useRouter();
  const [fy, setFy] = useState(current);
  // Which categories the report includes (section, header total, grid column), any fiscal year (not saved; all three each time the dialog opens).
  const [categories, setCategories] = useState<YearEndCategory[]>([...YearEndCategories.ALL]);
  const isCurrent = fy === current;
  const none = categories.length === 0;
  const hintId = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const titleId = useId();
  const helpId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !pending && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id={titleId} className="type-heading">
          {YearEndCopy.DIALOG_TITLE}
        </h2>
        <label className="flex flex-col gap-1">
          <span className="type-label text-muted">{YearEndCopy.SELECT_LABEL}</span>
          <select value={fy} onChange={(e) => setFy(e.target.value)} className={INPUT} aria-describedby={helpId} data-testid="year-end-fy" autoFocus>
            {years.map((y) => (
              <option key={y} value={y}>
                {YearEndCopy.option(y, current)}
              </option>
            ))}
          </select>
        </label>
        <p id={helpId} className="type-caption text-muted">
          {YearEndCopy.HELPER}
        </p>
        <fieldset className="flex flex-col gap-1" data-testid="year-end-categories">
          <legend className="type-label text-muted">{YearEndCopy.CATEGORIES_LABEL}</legend>
          {YearEndCategories.ALL.map((c) => (
            <label key={c} className="flex items-center gap-2 type-table">
              <input
                type="checkbox"
                checked={categories.includes(c)}
                onChange={(e) => setCategories((cur) => YearEndCategories.ALL.filter((x) => (x === c ? e.target.checked : cur.includes(x))))}
                data-testid={`year-end-category-${c}`}
              />
              {YearEndCopy.categoryLabel(c, fy, isCurrent)}
            </label>
          ))}
          {none && (
            <p id={hintId} className="type-caption text-muted" data-testid="year-end-categories-hint">
              {YearEndCopy.CATEGORIES_NONE}
            </p>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-danger type-caption">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className="h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg disabled:opacity-60">
            {YearEndCopy.CANCEL}
          </button>
          <button
            type="button"
            disabled={pending || none}
            aria-describedby={none ? hintId : undefined}
            aria-busy={pending || undefined}
            className="h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60"
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await generateYearEndReport(fy, categories).catch(() => null);
                if (!r || !r.ok) {
                  setError(YearEndCopy.ERROR);
                  return;
                }
                // Download the stored file (a route handler, not a page).
                const a = document.createElement("a");
                a.href = `/reports/year-end/${r.id}`;
                a.download = r.fileName;
                a.click();
                router.refresh();
                onClose();
              })
            }
          >
            {pending ? YearEndCopy.GENERATING : YearEndCopy.GENERATE}
          </button>
        </div>
      </div>
    </div>
  );
}
