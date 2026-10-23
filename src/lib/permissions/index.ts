export * from "@/lib/permissions/PermissionKeys";
export * from "@/lib/permissions/RoleDefaults";
export { OwnerLock } from "@/lib/permissions/OwnerLock";
export { Permissions, type PermissionUser, type RoleRef } from "@/lib/permissions/Permissions";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";

/** Shorthand for Permissions.can. */
export const can = (user: PermissionUser | null | undefined, key: string): boolean => Permissions.can(user, key);
