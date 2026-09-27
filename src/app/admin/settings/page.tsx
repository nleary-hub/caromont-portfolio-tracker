import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { ReportSettingsForm } from "@/components/ReportSettingsForm";
import { ContractsLeadsForm, LineDepartmentsForm } from "@/components/ServiceLineListsForms";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLineHistoryText } from "@/lib/admin/ServiceLineHistoryText";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { ServiceLineService } from "@/lib/services/ServiceLineService";

export const metadata: Metadata = { title: "Line settings" };

class SettingsFormat {
  private static readonly WHEN = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

  static when(d: Date): string {
    return `${SettingsFormat.WHEN.format(d)} ET`;
  }
}

/** Admin-only settings of the active service line. Non-admins get a 404 so the route is not revealed. */
export default async function AdminSettingsPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const options = DepartmentFilter.optionsFor(scope);
  const history = Db.isConfigured() ? await ServiceLineService.history(scope, viewer).catch(() => []) : [];
  const reportOptions = Db.isConfigured()
    ? await ReportOptionsService.get(undefined, scope).catch(() => ReportOptionsService.defaults(options))
    : ReportOptionsService.defaults(options);
  const section = "flex flex-col gap-3 rounded-card border border-line bg-card p-4";

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceLineSlot viewer={viewer} active={scope} />
          <div className="h-6 w-px bg-line" />
          <h1 className="type-title whitespace-nowrap">Line settings</h1>
        </div>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="text-muted type-caption">
        Only admins can see this page. These settings are for {scope.name}. Rename it from{" "}
        <Link href="/admin/service-lines" className="text-accent hover:underline">
          Service lines
        </Link>
        . Every change is recorded below.
      </p>
      {!Db.isConfigured() && <p className="text-danger type-caption">DATABASE_URL is not configured; showing the defaults.</p>}

      <section id="report" className={section} aria-labelledby="report-settings">
        <h2 id="report-settings" className="type-heading">
          Report
        </h2>
        <ReportSettingsForm departments={reportOptions.departments} totalsGrid={reportOptions.totalsGrid} options={options} scheduled={scope.isDefault} />
      </section>

      <section className={section} aria-labelledby="line-departments">
        <h2 id="line-departments" className="type-heading">
          Departments
        </h2>
        {scope.isDefault ? (
          <p className="type-table text-muted">
            {ServiceAreaInfo.all()
              .map((a) => ServiceAreaInfo.label(a))
              .join(", ")}
            . The default service line keeps all of its departments.
          </p>
        ) : (
          <LineDepartmentsForm lineId={scope.id} departments={scope.departments} />
        )}
      </section>

      <section className={section} aria-labelledby="line-contracts">
        <h2 id="line-contracts" className="type-heading">
          People
        </h2>
        <ContractsLeadsForm lineId={scope.id} leads={scope.contractsLeads} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="type-heading">Recent changes to {scope.shortName}</h2>
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full type-table">
            <thead className="bg-card text-left text-muted type-label">
              <tr>
                {["When", "Who", "Change", "Old", "New"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted">
                    No changes yet.
                  </td>
                </tr>
              )}
              {history.map((h, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap">{SettingsFormat.when(h.changedAt)}</td>
                  <td className="px-3 py-2">{h.changedBy}</td>
                  <td className="px-3 py-2">{ServiceLineHistoryText.action(h.action)}</td>
                  <td className="px-3 py-2 text-muted">{ServiceLineHistoryText.value(h.oldValue)}</td>
                  <td className="px-3 py-2">{ServiceLineHistoryText.value(h.newValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
