import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { AiSettingsForm } from "@/components/AiSettingsForm";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { AiCopy } from "@/lib/ai/AiCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiSettingsService, type AiSettingsDb, type AiSettingsHistoryRow, type AiSettingsView } from "@/lib/services/AiSettingsService";

/** AI Draft/Fit/Test connection server actions run on this page; the provider call can take up to AiProviderClient.TIMEOUT_MS (60 s). */
export const maxDuration = 90;

export const metadata: Metadata = { title: AdminMenu.AI_SETTINGS };

class AiPageFormat {
  private static readonly WHEN = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

  static when(d: Date | string): string {
    return `${AiPageFormat.WHEN.format(new Date(d))} ET`;
  }
}

/**
 * Admin > AI settings. Admins only: anyone else gets a 404 so the route is not revealed (limited users never see it,
 * and the admin menu lists it only for admins). The page never receives the API key or its ciphertext.
 */
export default async function AiSettingsPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  let view: AiSettingsView = AiSettingsService.view(null);
  let history: AiSettingsHistoryRow[] = [];
  let dbReady = Db.isConfigured();
  if (dbReady) {
    try {
      const db = Db.client as unknown as AiSettingsDb;
      view = AiSettingsService.view(await AiSettingsService.row(db));
      history = await AiSettingsService.history(db);
    } catch {
      // Tables not migrated yet (Vercel previews skip migrations): show the defaults, saving is disabled.
      dbReady = false;
    }
  }
  const keySavedLine = view.key.set && view.key.setAt ? AiCopy.keySaved(AiPageFormat.when(view.key.setAt), view.key.setBy ?? "") : null;
  const section = "flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4 backdrop-blur-[20px]";

  return (
    // .pb-page: the standard focus ring on inputs, selects and textareas (polish.css), as in the dashboard and editor.
    <main className="pb-page mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="type-title whitespace-nowrap">{AiCopy.PAGE_TITLE}</h1>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="text-muted type-caption">{AiCopy.PAGE_INTRO}</p>
      {!dbReady && (
        <p className="rounded-control bg-(--status-at-risk-dark-bg) px-3 py-2 text-(--status-at-risk-dark-fg) type-table" role="status" data-testid="ai-db-missing">
          {Db.isConfigured() ? AiCopy.DB_MISSING : "DATABASE_URL is not configured; showing the defaults."}
        </p>
      )}

      <section className={section} aria-labelledby="ai-settings-heading">
        <h2 id="ai-settings-heading" className="type-heading">
          {AiCopy.SWITCH_LABEL}
        </h2>
        <AiSettingsForm view={view} keySavedLine={keySavedLine} dbReady={dbReady} />
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="ai-history-heading">
        <h2 id="ai-history-heading" className="type-heading">
          {AiCopy.HISTORY_TITLE}
        </h2>
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full type-table" data-testid="ai-history">
            <thead className="bg-card text-left text-muted type-label">
              <tr>
                {AiCopy.HISTORY_HEADERS.map((h) => (
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
                    {AiCopy.HISTORY_EMPTY}
                  </td>
                </tr>
              )}
              {history.map((h) => (
                <tr key={h.id} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap">{AiPageFormat.when(h.changedAt)}</td>
                  <td className="px-3 py-2">{h.changedBy}</td>
                  <td className="px-3 py-2">{AiCopy.fieldLabel(h.field)}</td>
                  <td className="px-3 py-2">{AiCopy.historyChange(h.field, h.action, h.oldValue, h.newValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
