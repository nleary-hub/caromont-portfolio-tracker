import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { ReportSettingsForm } from "@/components/ReportSettingsForm";
import { ServiceLineSettingsForm } from "@/components/ServiceLineSettingsForm";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { ServiceLineService } from "@/lib/services/ServiceLineService";

export const metadata: Metadata = { title: "Settings" };

class SettingsFormat {
  private static readonly WHEN = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

  static when(d: Date): string {
    return `${SettingsFormat.WHEN.format(d)} ET`;
  }
}

/** Admin-only service line settings. Non-admins get a 404 so the route is not revealed. */
export default async function AdminSettingsPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  const value = await ServiceLineService.getOrDefault();
  const history = Db.isConfigured() ? await ServiceLineService.history(viewer).catch(() => []) : [];
  const reportOptions = Db.isConfigured() ? await ReportOptionsService.get().catch(() => ReportOptionsService.defaults()) : ReportOptionsService.defaults();

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="type-title">Service line and report settings</h1>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="text-muted type-caption">Only admins can see this page. Every change is recorded below.</p>
      {!Db.isConfigured() && <p className="text-danger type-caption">DATABASE_URL is not configured; showing the default names.</p>}

      <section className="rounded-card border border-line bg-card p-4">
        <ServiceLineSettingsForm value={value} />
      </section>

      <section id="report" className="flex flex-col gap-3 rounded-card border border-line bg-card p-4" aria-labelledby="report-settings">
        <h2 id="report-settings" className="type-heading">
          Report
        </h2>
        <ReportSettingsForm departments={reportOptions.departments} totalsGrid={reportOptions.totalsGrid} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="type-heading">Recent service line changes</h2>
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full type-table">
            <thead className="bg-card text-left text-muted type-label">
              <tr>
                {["When", "Who", "Old", "New"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-muted">
                    No changes yet.
                  </td>
                </tr>
              )}
              {history.map((h, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap">{SettingsFormat.when(h.changedAt)}</td>
                  <td className="px-3 py-2">{h.changedBy}</td>
                  <td className="px-3 py-2 text-muted">
                    {h.oldValue.name} ({h.oldValue.shortName})
                  </td>
                  <td className="px-3 py-2">
                    {h.newValue.name} ({h.newValue.shortName})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
