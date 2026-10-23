import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { RolesEditor } from "@/components/RolesEditor";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { RoleEditPolicy } from "@/lib/permissions/RoleEditPolicy";
import { RoleService } from "@/lib/services/RoleService";

export const metadata: Metadata = { title: "Roles" };
export const dynamic = "force-dynamic";

/**
 * Admin > Roles (Roles & Permissions PR 3 of 6). Opens for anyone holding admin.roles, checked on the server through
 * the engine; everyone else gets a 404 so the route is not revealed. ?role=<id> opens that role.
 */
export default async function RolesPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer) notFound();
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const actor = await RoleService.actorFor(viewer);
  if (!actor || !RoleEditPolicy.canOpen(actor)) notFound();
  const [data, params] = await Promise.all([RoleService.load(actor), searchParams]);

  return (
    <main className="mx-auto flex max-w-[1440px] flex-col gap-4 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <div className="text-muted type-table">
          Admin <span className="opacity-60">/</span> <b className="text-fg">Roles</b>
        </div>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <RolesEditor data={data} initialRoleId={params.role} />
    </main>
  );
}
