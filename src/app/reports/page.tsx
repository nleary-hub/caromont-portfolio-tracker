import Link from "next/link";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { redirect } from "next/navigation";
import { setShowKeyPageForm } from "@/app/actions/reports";
import { FreezeNowButton } from "@/components/FreezeNowButton";
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
import { ReportArchiveService, type ArchiveEntry } from "@/lib/services/ReportArchiveService";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { YearEndReportButton } from "@/components/YearEndReportButton";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { YearEndCopy } from "@/lib/report/YearEndReportData";
import { YearEndReportService } from "@/lib/services/YearEndReportService";

export const dynamic = "force-dynamic";

const signOutAction = async () => {
  "use server";
  await signOut({ redirectTo: SIGN_IN_PATH });
};

class ArchiveView {
  static delivery(e: ArchiveEntry): string {
    const d = e.delivery;
    if (!d) return "Not delivered yet";
    if (d.status === "drive") return "Uploaded to Google Drive";
    if (d.status === "signed_link") return `Signed link until ${ReportFormat.dateTimeEt(new Date(d.signedLink!.expiresAt))}`;
    return "Delivery failed";
  }
}

/** Archive of frozen reports. Signed-in users download PDFs; admins also see delivery and can freeze. */
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
  const entries = await ReportArchiveService.list(viewer, undefined, scope);
  const next = ReportSchedule.nextFreezeOnOrAfter(DateOnly.today());
  const options = viewer.isAdmin ? await ReportOptionsService.get(undefined, scope) : null;
  const today = DateOnly.today();
  const yearEndYears = viewer.isAdmin ? await YearEndReportService.years(viewer, scope).catch(() => [FiscalYear.of(today).label]) : [];
  const yearEnd = await YearEndReportService.list(scope).catch(() => []);
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
      {viewer.isAdmin && options && (
        <section id="report-admin" className="flex flex-col gap-3 rounded-card border border-line bg-card px-4 py-3">
          <div className="flex flex-wrap items-center gap-4">
            {scope.isDefault && <FreezeNowButton />}
            <a href="/api/reports/preview" download className="type-table-strong text-accent">
              Generate PDF now (draft)
            </a>
            <YearEndReportButton years={yearEndYears} current={FiscalYear.of(today).label} initialOpen={openYearEnd} />
          </div>
          <form action={setShowKeyPageForm} className="flex items-center gap-2 type-table">
            <label className="flex items-center gap-2">
              <input type="checkbox" name="showKeyPage" defaultChecked={options.showKeyPage} />
              Add the status and flag key as the last page
            </label>
            <button type="submit" className="text-accent type-table-strong">
              Save
            </button>
          </form>
          <p className="text-muted type-caption">
            {scope.isDefault ? "Only admins see these controls. Changes apply to the next freeze and to drafts." : "Only admins see these controls. Changes apply to drafts."}
          </p>
        </section>
      )}

      <div className="overflow-hidden rounded-card border border-line bg-card">
        <table className="w-full border-separate border-spacing-0 type-table">
          <thead>
            <tr className="text-left text-muted type-label uppercase">
              {["Period", "Frozen", "PDF", ...(viewer.isAdmin ? ["Delivery", "handoff.json"] : [])].map((h) => (
                <th key={h} className="border-b border-line px-3 py-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td colSpan={viewer.isAdmin ? 5 : 3} className="px-3 py-4 text-center text-muted">
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
                {viewer.isAdmin && (
                  <>
                    <td className="border-b border-line px-3 py-2" title={e.delivery?.driveError ?? e.delivery?.signedLinkError ?? ""}>
                      {ArchiveView.delivery(e)}
                      {e.delivery?.signedLink && (
                        <a href={e.delivery.signedLink.pdfUrl} className="ml-2 text-accent">
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
