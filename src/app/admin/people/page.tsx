import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { PeopleAdmin } from "@/components/PeopleAdmin";
import { AccessAdmin } from "@/components/AccessAdmin";
import { LineAccessService } from "@/lib/services/LineAccessService";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { ContractsLeadRules } from "@/lib/people/ContractsLeadRules";
import { PeopleService } from "@/lib/services/PeopleService";
import { UserAccountService } from "@/lib/services/UserAccountService";

export const metadata: Metadata = { title: ContractsLeadRules.PAGE_TITLE };
export const dynamic = "force-dynamic";

/** Admin > People: Access (every line) at the top, then the active line's Owners, Requesters and Contracts leads. Non-admins get a 404. */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ add?: string; remove?: string; rename?: string; role?: string; access?: string; menu?: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const [leads, lists, grid, params] = await Promise.all([PeopleService.contractsLeads(scope, viewer), PeopleService.lists(scope, viewer), LineAccessService.grid(viewer), searchParams]);
  // Deep links (screenshots): ?add=1 (Contracts leads) or ?add=owner|requester; ?role=owner|requester with ?rename= or ?remove=.
  const section = (v: string | undefined) => (v === "owner" || v === "requester" || v === "lead" ? v : undefined);
  // Password tags and row menus for everyone in the grid. ?menu=<email> opens that row's ⋯ menu.
  const passwords = await UserAccountService.statuses(viewer, [...grid.admins, ...grid.users].map((r) => r.email));
  const accessGrid = UserAccountService.withPasswordAdmins(grid, passwords);

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
      <PeopleAdmin
        key={scope.id}
        lineShort={scope.shortName}
        leads={leads}
        owners={lists.owners}
        requesters={lists.requesters}
        initial={{ add: params.add === "1" ? true : section(params.add), role: section(params.role), remove: params.remove ?? null, rename: params.rename ?? null }}
        // Access (item 8) covers every line, so it is not keyed to the active one. ?add=user opens its Add row;
        // ?access=<email> opens that person's department panel; ?menu=<email> opens that row's ⋯ menu.
        top={<AccessAdmin grid={accessGrid} initialAdd={params.add === "user"} initialExpanded={params.access?.trim().toLowerCase() || null} passwords={passwords} initialMenu={params.menu?.trim().toLowerCase() || null} />}
      />
    </main>
  );
}
