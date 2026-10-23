import Link from "next/link";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { notFound, redirect } from "next/navigation";
import { PermissionGate } from "@/lib/permissions/PermissionGate";
import { ReportsPageData } from "@/lib/report/ReportsPageData";
import { setShowKeyPageForm } from "@/app/actions/reports";
import { DriveCheckButton } from "@/components/DriveCheckButton";
import { DriveCheckService } from "@/lib/services/DriveCheckService";
import { FreezeNowButton } from "@/components/FreezeNowButton";
import { FreezeGuard } from "@/lib/report/FreezeGuard";
import { YearEndPreviewCopy } from "@/lib/report/YearEndPreviewCopy";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { signOut, SIGN_IN_PATH } from "@/auth";
import { NoAccessCard } from "@/components/NoAccessCard";
import { LineGate } from "@/lib/access/LineGate";
import { ServiceLineCopy } from "@/lib/domain/ServiceLine";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { ReportSchedule } from "@/lib/report/ReportSchedule";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { ArchiveEntry } from "@/lib/services/ReportArchiveService";
import { ArchiveDeliveryText } from "@/lib/report/ArchiveDeliveryText";
import { YearEndReportButton } from "@/components/YearEndReportButton";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { YearEndCopy } from "@/lib/report/YearEndReportData";
import { YearEndReportService } from "@/lib/services/YearEndReportService";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { TotalsGridPlacement } from "@/lib/domain/TotalsGridPlacement";
import { ReportDisplaySettings } from "@/lib/report/ReportDisplaySettings";

export const dynamic = "force-dynamic";

const signOutAction = async () => {
  "use server";
  await signOut({ redirectTo: SIGN_IN_PATH });
};

class ArchiveView {
  static delivery(e: ArchiveEntry): string {
    // Never throws on a partial record (e.g. {"status":"signed_link"} with no link details).
    return ArchiveDeliveryText.label(e.delivery);
  }
}

/** Reports. The Owner sees the frozen archive, delivery and freeze controls; everyone else only on-demand PDFs. */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer) redirect("/signin");
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const params = await searchParams;
  // Per-line access (item 8): the archive of the viewer's line only; the same cards as the dashboard otherwise.
  const gate = await LineGate.forPage(viewer, params.line, "/reports");
  if (gate.kind === "switched") redirect(gate.to);
  if (gate.kind === "none") return <NoAccessCard email={viewer.email} signOutAction={signOutAction} />;
  if (gate.kind === "lacks") return <NoAccessCard email={viewer.email} signOutAction={signOutAction} line={gate.requested} goTo={{ shortName: gate.first.shortName, href: LineGate.href("/reports", gate.first.shortName) }} />;
  const { scope, lines } = gate;
  // L1: Owner-only data is loaded only for the Owner (ReportsPageData); everyone else gets on-demand controls only.
  const user = await PermissionGate.resolve(viewer);
  const data = await ReportsPageData.load(user, scope);
  if (!data) notFound();
  if (data.kind === "viewer") {
    return (
      <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <ServiceLineSlot viewer={viewer} active={scope} lines={lines} />
            <div className="h-6 w-px bg-line" />
            <h1 className="type-title whitespace-nowrap">Reports</h1>
          </div>
          <div className="flex items-center gap-3">
            <AdminMenuSlot viewer={viewer} />
            <Link href="/" className="text-muted type-table-strong hover:text-fg">
              Back to dashboard
            </Link>
          </div>
        </div>
        {data.canDownloadPdf && (
          <section className="flex flex-wrap items-center gap-4 rounded-card border border-line bg-card px-4 py-3">
            <a href="/api/reports/preview" download className="type-table-strong text-accent">
              Generate PDF now
            </a>
            <span className="text-muted type-caption">Downloads a PDF of the current projects.</span>
          </section>
        )}
      </main>
    );
  }
  const { entries, options, nextDisplay, yearEndYears, yearEnd } = data;
  const next = ReportSchedule.nextFreezeOnOrAfter(DateOnly.today());
  const today = DateOnly.today();
  // Deep link for review and screenshots: ?yearEnd=1 opens the dialog.
  const openYearEnd = params.yearEnd === "1";

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceLineSlot viewer={viewer} active={scope} lines={lines} />
          <div className="h-6 w-px bg-line" />
          <h1 className="type-title whitespace-nowrap">Report archive</h1>
        </div>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="text-muted type-caption">
        {scope.isDefault
          ? `Frozen every other Tuesday at 5 PM ET. Next scheduled freeze: ${ReportFormat.longDate(next)}.`
          : ServiceLineCopy.onDemandNote(scope.shortName)}
      </p>
      {options && (
        <section id="report-admin" aria-labelledby="report-freeze-heading" className="flex flex-col gap-3 rounded-card border border-line bg-card px-4 py-3">
          <h2 id="report-freeze-heading" className="type-heading">{AdminMenu.REPORT_FREEZE}</h2>
          <div className="flex flex-wrap items-center gap-4">
            {scope.isDefault && <FreezeNowButton disabledNote={FreezeGuard.disabled() ? FreezeGuard.NOTE : null} />}
            <a href="/api/reports/preview" download className="type-table-strong text-accent">
              Generate PDF now (draft)
            </a>
            <YearEndReportButton years={yearEndYears} current={FiscalYear.of(today).label} initialOpen={openYearEnd} disabledNote={FreezeGuard.disabled() ? YearEndPreviewCopy.NOTE : null} />
          </div>
          {nextDisplay !== undefined && (
            <p data-testid="next-freeze-display" className="self-start rounded-[8px] border border-white/10 bg-black/40 px-3 py-1.5 text-[12px] leading-4 text-(--dark-text-secondary) shadow-[inset_0_1px_0_rgba(255,255,255,.06)] backdrop-blur-md">
              {ReportDisplaySettings.summary(nextDisplay)}
            </p>
          )}
          {scope.isDefault && <DriveCheckButton folder={DriveCheckService.folderLabel()} help={DriveCheckService.help(DriveCheckService.folderLabel())} disabledNote={FreezeGuard.disabled() ? DriveCheckService.PREVIEW_OFF : null} />}
          <form action={setShowKeyPageForm} className="flex flex-wrap items-end gap-4 type-table">
            <label className="flex items-center gap-2 pb-1">
              <input type="checkbox" name="showKeyPage" defaultChecked={options.showKeyPage} />
              Add the status and flag key as the last page
            </label>
            <fieldset className="flex flex-col gap-1">
              <legend className="type-label text-muted">Summary grid</legend>
              <div role="radiogroup" aria-label="Summary grid" className="flex flex-wrap gap-3">
                {TotalsGridPlacement.MODES.map((mode) => (
                  <label key={mode} className="flex items-center gap-1">
                    <input type="radio" name="totalsGrid" value={mode} defaultChecked={options.totalsGrid === mode} />
                    {TotalsGridPlacement.LABELS[mode]}
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" className="text-accent type-table-strong pb-1">
              Save
            </button>
          </form>
          <p className="text-muted type-caption">
            {scope.isDefault ? "Only you see these controls. Changes apply to the next freeze and to drafts." : "Only you see these controls. Changes apply to drafts."}
          </p>
        </section>
      )}

      <div className="overflow-hidden rounded-card border border-line bg-card">
        <table className="w-full border-separate border-spacing-0 type-table">
          <thead>
            <tr className="text-left text-muted type-label uppercase">
              {["Period", "Frozen", "PDF", "Delivery", "handoff.json"].map((h) => (
                <th key={h} className="border-b border-line px-3 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-muted">
                  No reports frozen yet.
                </td>
              </tr>
            )}
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="border-b border-line px-3 py-2">{ReportFormat.period(e.periodStart, e.periodEnd)}</td>
                <td className="border-b border-line px-3 py-2 whitespace-nowrap">{ReportFormat.dateTimeEt(e.frozenAt)}</td>
                <td className="border-b border-line px-3 py-2">
                  {e.hasPdf ? (
                    <a href={`/reports/${e.id}/pdf`} className="text-accent type-table-strong">
                      Download PDF
                    </a>
                  ) : (
                    <span className="text-muted">Rendering</span>
                  )}
                </td>
                {(
                  <>
                    <td className="border-b border-line px-3 py-2" title={ArchiveDeliveryText.title(e.delivery)} data-testid="archive-delivery">
                      {ArchiveView.delivery(e)}
                      {ArchiveDeliveryText.linkHref(e.delivery) && (
                        <a href={ArchiveDeliveryText.linkHref(e.delivery)!} className="ml-2 text-accent">
                          link
                        </a>
                      )}
                    </td>
                    <td className="border-b border-line px-3 py-2">
                      <a href={`/reports/${e.id}/handoff`} className="text-accent">
                        Download
                      </a>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {yearEnd.length > 0 && (
        <section aria-labelledby="year-end-heading" className="flex flex-col gap-2">
          <h2 id="year-end-heading" className="type-heading">
            {YearEndCopy.LIST_HEADING}
          </h2>
          <ul className="overflow-hidden rounded-card border border-line bg-card type-table" data-testid="year-end-list">
            {yearEnd.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-4 border-b border-line px-3 py-2 last:border-b-0">
                <span>{YearEndReportService.listText(e)}</span>
                <a href={`/reports/year-end/${e.id}`} className="shrink-0 text-accent type-table-strong">
                  {YearEndCopy.DOWNLOAD}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
