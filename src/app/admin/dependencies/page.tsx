import type { Metadata } from "next";
import Link from "next/link";
import { Permissions } from "@/lib/permissions/Permissions";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { AiDependencySuggestPanel } from "@/components/AiDependencySuggestPanel";
import { DependencyReviewCopy, DependencyReviewIntro, DependencyReviewTable } from "@/components/DependencyReviewTable";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AuditText } from "@/lib/admin/AuditText";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import type { AiModelDb } from "@/lib/services/AiModelService";
import { AiSettingsService, type AiSettingsDb } from "@/lib/services/AiSettingsService";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { AiPlacementData } from "@/lib/services/AiToolsReadiness";
import { DependencyReviewService } from "@/lib/services/ProjectDependencyService";

export const metadata: Metadata = { title: DependencyReviewCopy.PAGE_TITLE };
export const dynamic = "force-dynamic";

/**
 * Admin-only, read only: the active line's project_dependencies rows for review. Non-admins get a 404 so the route is
 * not revealed. No actions: rows are changed only in the project drawer (Dependencies). Not read by the report or PDF.
 * Item 8: when Dependency suggestions is on, the one-time AI seed pass runs from here. It only lists proposals on the
 * shared confirm card; nothing is created until a line is applied.
 */
export default async function DependenciesReviewPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer || !Permissions.can(viewer, "project.review")) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const aiOn = OwnerPolicy.isOwner(viewer) ? await AiSettingsService.isOn(Db.client as unknown as AiSettingsDb).catch(() => false) : false;
  const ai = aiOn ? await AiPlacementData.load(Db.client as unknown as AiModelDb & AiSettingsDb).catch(() => undefined) : undefined;
  const rows = (await DependencyReviewService.list(viewer, scope)).map((r) => ({ id: r.id, project: r.project, blockedBy: r.blockedBy, created: AuditText.when(r.createdAt), createdBy: AuditText.who(r.createdBy) }));

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <ServiceLineSlot viewer={viewer} active={scope} />
          <div className="h-6 w-px bg-line" />
          <h1 className="type-title whitespace-nowrap">{DependencyReviewCopy.PAGE_TITLE}</h1>
        </div>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <DependencyReviewIntro />
      {ai && "related_links" in ai && (
        <section aria-label={AiToolsCopy.DEPS_TITLE} className="flex flex-col gap-2 rounded-card border border-line p-4" data-testid="ai-deps-seed">
          <h2 className="type-table-strong text-fg">{AiToolsCopy.DEPS_TITLE}</h2>
          <AiDependencySuggestPanel disabledNote={ai.related_links ?? null} />
        </section>
      )}
      <DependencyReviewTable rows={rows} />
    </main>
  );
}
