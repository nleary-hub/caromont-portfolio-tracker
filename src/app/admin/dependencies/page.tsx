import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { DependencyReviewCopy, DependencyReviewIntro, DependencyReviewTable } from "@/components/DependencyReviewTable";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AuditText } from "@/lib/admin/AuditText";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { DependencyReviewService } from "@/lib/services/ProjectDependencyService";

export const metadata: Metadata = { title: DependencyReviewCopy.PAGE_TITLE };
export const dynamic = "force-dynamic";

/**
 * Admin-only, read only: the active line's project_dependencies rows for review. Non-admins get a 404 so the route is
 * not revealed. No actions: rows are changed only in the project drawer (Dependencies). Not read by the report or PDF.
 */
export default async function DependenciesReviewPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
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
      <DependencyReviewTable rows={rows} />
    </main>
  );
}
