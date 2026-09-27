import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { DepartmentsAdmin, type DepartmentRowDto } from "@/components/DepartmentsAdmin";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { DepartmentCopy } from "@/lib/domain/DepartmentRules";
import { DepartmentService, type DepartmentAdminRow } from "@/lib/services/DepartmentService";

export const metadata: Metadata = { title: DepartmentCopy.PAGE_TITLE };
export const dynamic = "force-dynamic";

class DepartmentRows {
  private static readonly DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/New_York" });

  static of(d: DepartmentAdminRow): DepartmentRowDto {
    return { id: d.id, name: d.name, shortName: d.shortName, activeProjects: d.activeProjects, updated: DepartmentRows.DATE.format(d.updatedAt), archived: d.archived };
  }
}

/** Admin > Departments of the active line. Non-admins get a 404 so the route is not revealed. */
export default async function DepartmentsPage({ searchParams }: { searchParams: Promise<{ new?: string; edit?: string; archive?: string; delete?: string; archived?: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const [lists, params] = await Promise.all([DepartmentService.list(scope, viewer), searchParams]);

  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-5 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <ServiceLineSlot viewer={viewer} active={scope} />
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <DepartmentsAdmin
        key={scope.id}
        lineShort={scope.shortName}
        active={lists.active.map(DepartmentRows.of)}
        archived={lists.archived.map(DepartmentRows.of)}
        initial={{ new: params.new === "1", edit: params.edit ?? null, archive: params.archive ?? null, delete: params.delete ?? null, archivedOpen: params.archived === "1" }}
      />
    </main>
  );
}
