import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLinesAdmin, type ServiceLineRowDto } from "@/components/ServiceLinesAdmin";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import type { ServiceLineSummary } from "@/lib/domain/ServiceLine";
import { ServiceLineService } from "@/lib/services/ServiceLineService";

export const metadata: Metadata = { title: "Service lines" };
export const dynamic = "force-dynamic";

class ServiceLineRows {
  private static readonly DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/New_York" });

  static of(s: ServiceLineSummary): ServiceLineRowDto {
    return {
      id: s.id,
      name: s.name,
      shortName: s.shortName,
      isDefault: s.isDefault,
      projectCount: s.projectCount,
      updated: ServiceLineRows.DATE.format(s.updatedAt),
      archived: Boolean(s.archivedAt),
    };
  }
}

/** Admin > Service lines. Non-admins get a 404 so the route is not revealed. */
export default async function ServiceLinesPage({ searchParams }: { searchParams: Promise<{ new?: string; delete?: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const [scope, lists, params] = await Promise.all([ServiceLineAccess.activeOrDefault(viewer), ServiceLineService.list(viewer), searchParams]);

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
      <ServiceLinesAdmin
        active={lists.active.map(ServiceLineRows.of)}
        archived={lists.archived.map(ServiceLineRows.of)}
        initialNew={params.new === "1"}
        initialDeleteId={params.delete ?? null}
      />
    </main>
  );
}
