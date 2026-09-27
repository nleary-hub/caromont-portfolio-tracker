import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { AuditChangeRow } from "@/components/AuditChangeRow";
import { restoreProjectForm, unhideProjectForm } from "@/app/actions/admin";
import { RestoreServiceLineButton } from "@/components/RestoreServiceLineButton";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AuditText } from "@/lib/admin/AuditText";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { AdminAuditService, type AuditProject } from "@/lib/services/AdminAuditService";

/**
 * Admin-only. Non-admins (and signed-out users past the proxy) get a 404 so the route is not revealed.
 * Recent changes: labels and OLD / NEW summaries come from AuditText (strings in AuditCopy), built at display time.
 * ?details=<row number> opens that row's Details (screenshots).
 */
export default async function AuditPage({ searchParams }: { searchParams?: Promise<{ details?: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const data = await AdminAuditService.load(viewer, undefined, scope);
  const detailsParam = (await searchParams)?.details;
  const details = detailsParam !== undefined && /^\d+$/.test(detailsParam) ? Number(detailsParam) : null;

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceLineSlot viewer={viewer} active={scope} />
          <div className="h-6 w-px bg-line" />
          <h1 className="type-title whitespace-nowrap">Audit: hidden and deleted</h1>
        </div>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="text-muted type-caption">Only admins can see this page.</p>

      <section className="flex flex-col gap-2">
        <h2 className="type-heading">Hidden projects</h2>
        <ProjectTable
          projects={data.hidden}
          empty="No hidden projects."
          actions={(p) => (
            <div className="flex gap-3">
              {p.hiddenFromDashboard && <UnhideButton projectId={p.id} context="dashboard" label="Unhide on dashboard" />}
              {p.hiddenFromReport && <UnhideButton projectId={p.id} context="report" label="Unhide in report" />}
            </div>
          )}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="type-heading">Deleted projects</h2>
        <ProjectTable
          projects={data.deleted}
          empty="No deleted projects."
          actions={(p) => (
            <form action={restoreProjectForm}>
              <input type="hidden" name="projectId" value={p.id} />
              <button type="submit" className="text-accent type-table-strong">
                Restore
              </button>
            </form>
          )}
        />
      </section>

      <section className="flex flex-col gap-2" id="deleted-service-lines">
        <h2 className="type-heading">Deleted service lines</h2>
        {data.deletedLines.length === 0 ? (
          <p className="text-muted type-caption">No deleted service lines.</p>
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-card">
            <table className="w-full border-separate border-spacing-0 type-table">
              <thead>
                <tr className="text-left text-muted type-label uppercase">
                  {["Service line", "Short name", "Deleted", "Deleted by", ""].map((h, i) => (
                    <th key={i} className="border-b border-line px-3 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.deletedLines.map((l) => (
                  <tr key={l.id}>
                    <td className="border-b border-line px-3 py-2 type-table-strong">{l.name}</td>
                    <td className="border-b border-line px-3 py-2">{l.shortName}</td>
                    <td className="border-b border-line px-3 py-2">{AuditText.when(l.deletedAt)}</td>
                    <td className="border-b border-line px-3 py-2">{l.deletedBy ?? "–"}</td>
                    <td className="border-b border-line px-3 py-2">
                      <RestoreServiceLineButton id={l.id} name={l.name} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2" id="deleted-departments">
        <h2 className="type-heading">Deleted departments</h2>
        {data.deletedDepartments.length === 0 ? (
          <p className="text-muted type-caption">No deleted departments.</p>
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-card">
            <table className="w-full border-separate border-spacing-0 type-table">
              <thead>
                <tr className="text-left text-muted type-label uppercase">
                  {["Department", "Short name", "Deleted", "Deleted by", ""].map((h, i) => (
                    <th key={i} className="border-b border-line px-3 py-2">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.deletedDepartments.map((d) => (
                  <tr key={d.id}>
                    <td className="border-b border-line px-3 py-2 type-table-strong">{d.name}</td>
                    <td className="border-b border-line px-3 py-2">{d.shortName}</td>
                    <td className="border-b border-line px-3 py-2">{AuditText.when(d.deletedAt)}</td>
                    <td className="border-b border-line px-3 py-2">{d.deletedBy ?? "–"}</td>
                    <td className="border-b border-line px-3 py-2">
                      <RestoreServiceLineButton id={d.id} name={d.name} kind="department" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="type-heading">Hidden by dashboard view</h2>
        <ul className="rounded-card border border-line bg-card px-3 py-2 type-table">
          {ViewSettings.CONTEXTS.map((c) => {
            const v = data.viewSettings[c];
            const statuses = v.hiddenStatuses.map((s) => ProjectStatusInfo.label(s)).join(", ") || "none";
            const columns = v.hiddenColumns.map((col) => ViewSettings.columnLabel(c, col)).join(", ") || "none";
            return (
              <li key={c} className="py-1">
                <b className="capitalize">{c}</b>: statuses {statuses}; columns {columns}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="type-heading">Recent changes</h2>
        <div className="overflow-hidden rounded-card border border-line bg-card">
          <table className="w-full border-separate border-spacing-0 type-table">
            <thead>
              <tr className="text-left text-muted type-label uppercase">
                {["When", "Who", "What", "Change", "Old", "New"].map((h) => (
                  <th key={h} className="border-b border-line px-3 py-2">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.events.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-muted">
                    No changes yet.
                  </td>
                </tr>
              )}
              {data.events.map((e, i) => (
                <AuditChangeRow
                  key={i}
                  id={String(i)}
                  when={AuditText.when(e.at)}
                  by={AuditText.who(e.by)}
                  subject={e.subject}
                  change={AuditText.change(e)}
                  oldText={AuditText.summary(e, "old")}
                  newText={AuditText.summary(e, "new")}
                  oldRaw={AuditText.raw(e, "old")}
                  newRaw={AuditText.raw(e, "new")}
                  initialOpen={details === i}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function UnhideButton({ projectId, context, label }: { projectId: string; context: string; label: string }) {
  return (
    <form action={unhideProjectForm}>
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="context" value={context} />
      <button type="submit" className="text-accent type-table-strong">
        {label}
      </button>
    </form>
  );
}

function ProjectTable({
  projects,
  empty,
  actions,
}: {
  projects: AuditProject[];
  empty: string;
  actions: (p: AuditProject) => ReactNode;
}) {
  if (projects.length === 0) return <p className="text-muted type-caption">{empty}</p>;
  return (
    <div className="overflow-hidden rounded-card border border-line bg-card">
      <table className="w-full border-separate border-spacing-0 type-table">
        <thead>
          <tr className="text-left text-muted type-label uppercase">
            {["Project", "Hidden from", "Deleted", "Deleted by", ""].map((h, i) => (
              <th key={i} className="border-b border-line px-3 py-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td className="border-b border-line px-3 py-2 type-table-strong">{p.name}</td>
              <td className="border-b border-line px-3 py-2">
                {[p.hiddenFromDashboard && "Dashboard", p.hiddenFromReport && "Report"].filter(Boolean).join(", ") || "–"}
              </td>
              <td className="border-b border-line px-3 py-2">{AuditText.when(p.deletedAt)}</td>
              <td className="border-b border-line px-3 py-2">{p.deletedBy ?? "–"}</td>
              <td className="border-b border-line px-3 py-2">{actions(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
