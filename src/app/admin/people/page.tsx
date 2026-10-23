import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { signOut, SIGN_IN_PATH } from "@/auth";
import { assignUserRole, inviteUser, revokeInvite } from "@/app/actions/peopleRoles";
import { PeoplePanel } from "@/components/rbac/PeoplePanel";
import { RbacShell, type ShellAdminLink } from "@/components/rbac/RbacShell";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { Db } from "@/lib/db/Db";
import { Permissions } from "@/lib/permissions/Permissions";
import { PeopleRoleService, PrismaPeopleRoleStore } from "@/lib/services/PeopleRoleService";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

const signOutAction = async () => {
  "use server";
  await signOut({ redirectTo: SIGN_IN_PATH });
};

/**
 * Admin > People (Roles & Permissions 4/6): every person with their role, pending invites and Invite user. The
 * server checks people.view through the permission engine (PeopleRoleService); without it the page is a 404. Line
 * access, passwords and the name lists moved to /admin/people/access (the row menu links there).
 */
export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ invite?: string; role?: string; picker?: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer) redirect(SIGN_IN_PATH);
  if (!Db.isConfigured()) return <main className="p-6 text-danger">DATABASE_URL is not configured.</main>;
  const store = new PrismaPeopleRoleStore();
  const [data, params, actor, roles] = await Promise.all([PeopleRoleService.directory(viewer, store), searchParams, PeopleRoleService.actor(viewer, store), PeopleRoleService.roleOptions(store)]);
  if (!data) notFound();
  const me = data.people.find((p) => p.you);
  const name = me?.name ?? viewer.name ?? viewer.email;
  const admin: ShellAdminLink[] = [
    ...(Permissions.can(actor, "admin.departments") ? [{ id: "departments", label: "Departments", href: "/admin/departments" }] : []),
    ...(Permissions.can(actor, "admin.roles") ? [{ id: "roles", label: "Roles", href: "/admin/roles" }] : []),
    ...(OwnerPolicy.isOwner(viewer) ? [{ id: "ai", label: "AI settings", href: "/admin/ai" }] : []),
    ...(Permissions.can(actor, "admin.audit") ? [{ id: "audit", label: "Audit log", href: "/admin/audit" }] : []),
  ];
  return (
    <RbacShell
      active="people"
      nav={["dashboard", "projects", "reports", "people"]}
      admin={admin}
      crumb="People"
      searchPlaceholder="Search…"
      user={{ name, initials: PeopleRoleService.initials(name), sub: data.actorRoleName, role: data.actorRoleName, email: viewer.email }}
      signOutAction={signOutAction}
    >
      <PeoplePanel
        people={data.people}
        assignable={data.assignable}
        roles={roles.map(({ id, name: n, rank, description }) => ({ id, name: n, rank, description }))}
        canInvite={data.canInvite}
        departmentCount={data.departmentCount}
        nowIso={new Date().toISOString()}
        initialInvite={params.invite === "1"}
        initialRoleOpen={params.role === "open"}
        initialPicker={params.picker?.trim().toLowerCase() || null}
        actions={{ assign: assignUserRole, invite: inviteUser, revoke: revokeInvite }}
      />
    </RbacShell>
  );
}
