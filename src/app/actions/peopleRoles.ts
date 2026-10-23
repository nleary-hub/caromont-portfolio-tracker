"use server";

import { revalidatePath } from "next/cache";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { PeopleRoleService, PrismaPeopleRoleStore, type PeopleResult } from "@/lib/services/PeopleRoleService";

/**
 * People > Role picker, Invite user and Revoke. Server Actions are reachable by direct POST, so each resolves the
 * viewer from the session; PeopleRoleService re-checks every rule through the permission engine (rank, Owner lock).
 */
class PeopleRoleAction {
  static readonly FAILED = "Couldn't save. Try again.";

  static async run(work: () => Promise<PeopleResult>): Promise<PeopleResult> {
    try {
      const result = await work();
      if (result.ok) revalidatePath("/admin/people");
      return result;
    } catch (e) {
      console.error("People role change failed", (e as Error)?.name ?? "error");
      return { ok: false, message: PeopleRoleAction.FAILED };
    }
  }
}

export async function assignUserRole(email: string, roleId: string): Promise<PeopleResult> {
  const viewer = await CurrentViewer.get();
  return PeopleRoleAction.run(() => PeopleRoleService.assignRole(viewer, email, roleId, new PrismaPeopleRoleStore()));
}

export async function inviteUser(input: { email: string; name: string; roleId: string }): Promise<PeopleResult> {
  const viewer = await CurrentViewer.get();
  return PeopleRoleAction.run(() => PeopleRoleService.invite(viewer, input, new PrismaPeopleRoleStore()));
}

export async function revokeInvite(email: string): Promise<PeopleResult> {
  const viewer = await CurrentViewer.get();
  return PeopleRoleAction.run(() => PeopleRoleService.revoke(viewer, email, new PrismaPeopleRoleStore()));
}
