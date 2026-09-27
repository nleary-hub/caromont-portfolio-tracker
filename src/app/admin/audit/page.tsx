import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { restoreProjectForm, unhideProjectForm } from "@/app/actions/admin";
import { RestoreServiceLineButton } from "@/components/RestoreServiceLineButton";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLineHistoryText } from "@/lib/admin/ServiceLineHistoryText";
import { AuditLayoutText } from "@/lib/admin/AuditLayoutText";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { AdminAuditService, type AuditEvent, type AuditProject } from "@/lib/services/AdminAuditService";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";


class AuditFormat {
  private static readonly WHEN = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/New_York",
  });

  static when(d: Date | null): string {
    return d ? `${AuditFormat.WHEN.format(d)} ET` : "–";
  }

  private static readonly FIELD_LABELS: Record<string, string> = {
    archivedAt: "Deleted at",
    deletedBy: "Deleted by",
    hiddenFromDashboard: "Hidden from dashboard",
    hiddenFromReport: "Hidden from report",
    viewSettings: "View settings",
    ...MilestoneRules.FIELD_LABELS,
  };

  static field(e: AuditEvent): string {
    if (e.kind === "serviceLine") return `Service line: ${ServiceLineHistoryText.action(e.field.replace(/^serviceLine\./, ""))}`;
    if (e.kind === "layout") return `Layout: ${AuditLayoutText.action(e.field.replace(/^layout\./, ""))}`;
    if (e.kind === "access") return e.comment ?? "Access";
    if (e.kind === "template") return `Template: ${e.field.replace(/^template\./, "").replace(/_/g, " ")}`;
    return AuditFormat.FIELD_LABELS[e.field] ?? e.field;
  }
}

/** Admin-only. Non-admins (and signed-out users past the proxy) get a 404 so the route is not revealed. */
export default async function AuditPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const data = await AdminAuditService.load(viewer, undefined, scope);

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
                    <td className="border-b border-line px-3 py-2">{AuditFormat.when(l.deletedAt)}</td>
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
                    <td className="border-b border-line px-3 py-2">{AuditFormat.when(d.deletedAt)}</td>
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
        <h2 className="type-heading">Hidden by view settings</h2>
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
                <tr key={i}>
                  <td className="border-b border-line px-3 py-2 whitespace-nowrap">{AuditFormat.when(e.at)}</td>
                  <td className="border-b border-line px-3 py-2">{e.by}</td>
                  <td className="border-b border-line px-3 py-2">{e.subject}</td>
                  <td className="border-b border-line px-3 py-2">{AuditFormat.field(e)}</td>
                  <td className="max-w-[220px] truncate border-b border-line px-3 py-2 text-muted" title={e.oldValue ?? ""}>
                    {e.oldValue ?? "–"}
                  </td>
                  <td className="max-w-[220px] truncate border-b border-line px-3 py-2" title={e.newValue ?? ""}>
                    {e.newValue ?? "–"}
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
              <td className="border-b border-line px-3 py-2">{AuditFormat.when(p.deletedAt)}</td>
              <td className="border-b border-line px-3 py-2">{p.deletedBy ?? "–"}</td>
              <td className="border-b border-line px-3 py-2">{actions(p)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
