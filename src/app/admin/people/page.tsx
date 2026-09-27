import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { PeopleAdmin } from "@/components/PeopleAdmin";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { ContractsLeadRules } from "@/lib/people/ContractsLeadRules";
import { PeopleService } from "@/lib/services/PeopleService";

export const metadata: Metadata = { title: ContractsLeadRules.PAGE_TITLE };
export const dynamic = "force-dynamic";

/** Admin > People of the active line (this release: Contracts leads). Non-admins get a 404. */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ add?: string; remove?: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const [leads, params] = await Promise.all([PeopleService.contractsLeads(scope, viewer), searchParams]);

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
      <PeopleAdmin key={scope.id} lineShort={scope.shortName} leads={leads} initial={{ add: params.add === "1", remove: params.remove ?? null }} />
    </main>
  );
}
