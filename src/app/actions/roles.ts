"use server";

import { revalidatePath } from "next/cache";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { RoleService, type RoleResult } from "@/lib/services/RoleService";

/**
 * Admin > Roles. Each action resolves the signed-in person from the database and lets RoleService check the rank rule,
 * the grant limit and the Owner lock through the engine on the server. Anyone without admin.roles gets "Not found.".
 */
const NOT_FOUND: RoleResult = { ok: false, message: "Not found." };

async function run(fn: (actor: NonNullable<Awaited<ReturnType<typeof RoleService.actorFor>>>) => Promise<RoleResult>): Promise<RoleResult> {
  const actor = await RoleService.actorFor(await CurrentViewer.get());
  if (!actor) return NOT_FOUND;
  try {
    const result = await fn(actor);
    if (result.ok) revalidatePath("/admin/roles");
    return result;
  } catch (e) {
    console.error("Roles editor action failed", (e as Error)?.name ?? "error");
    return { ok: false, message: "Could not save. Try again." };
  }
}

export async function saveRoleKeys(roleId: string, keys: string[]): Promise<RoleResult> {
  return run((actor) => RoleService.saveKeys(actor, String(roleId), keys));
}

export async function createRole(name: string, description: string): Promise<RoleResult> {
  return run((actor) => RoleService.create(actor, name, description));
}

export async function duplicateRole(roleId: string): Promise<RoleResult> {
  return run((actor) => RoleService.duplicate(actor, String(roleId)));
}

export async function renameRole(roleId: string, name: string, description: string): Promise<RoleResult> {
  return run((actor) => RoleService.rename(actor, String(roleId), name, description));
}

export async function deleteRole(roleId: string, moveToId: string | null): Promise<RoleResult> {
  return run((actor) => RoleService.remove(actor, String(roleId), moveToId ? String(moveToId) : null));
}
