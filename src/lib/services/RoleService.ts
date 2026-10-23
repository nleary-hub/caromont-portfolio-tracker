import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { OwnerLock } from "@/lib/permissions/OwnerLock";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import { RoleDescriptions, type RawDb } from "@/lib/permissions/RoleDescriptions";
import { RoleEditPolicy } from "@/lib/permissions/RoleEditPolicy";
import { SYSTEM_ROLE_DESCRIPTIONS } from "@/lib/permissions/RoleLabels";

type Env = Record<string, string | undefined>;
type RoleDb = Pick<PrismaClient, "role" | "rolePermission" | "roleHistory" | "userRoleHistory" | "appUser"> & RawDb;
export type RoleTxDb = RoleDb & { $transaction<T>(fn: (tx: RoleDb) => Promise<T>): Promise<T> };

export type RoleResult = { ok: true; message: string; roleId?: string } | { ok: false; message: string };

export interface RoleUser { email: string; name: string }
export interface RoleRow {
  id: string;
  name: string;
  description: string;
  rank: number;
  isSystem: boolean;
  keys: string[];
  users: RoleUser[];
  /** Below the actor's rank: editable, duplicable, deletable (custom only) and assignable. */
  editable: boolean;
}
export interface RolesData {
  roles: RoleRow[];
  /** Keys the actor may turn on (Owner lock plus grant limit). */
  grantable: string[];
  ownerCount: number;
  /** False until migration 0070 is applied: the editor hides the description field. */
  descriptions: boolean;
}

const NAME_MAX = 40;
const DESCRIPTION_MAX = 80;

/**
 * Roles editor (Admin > Roles), PR 3 of 6. Every mutation re-resolves the actor from the database, checks through the
 * engine (RoleEditPolicy over Permissions) inside one transaction, and appends to role_history (and user_role_history
 * when people move). History is insert-only; the tables' triggers refuse UPDATE and DELETE.
 */
export class RoleService {
  /** The signed-in viewer with their role's rank and stored keys (seeded defaults when the row is missing). */
  static async actorFor(viewer: Viewer | null | undefined, db: Pick<RoleDb, "appUser" | "role"> = Db.client, env: Env = process.env): Promise<PermissionUser | null> {
    if (!viewer) return null;
    if (OwnerLock.isOwnerViewer(viewer, env)) return { ...viewer };
    const user = await db.appUser.findUnique({ where: { email: viewer.email }, select: { roleId: true } });
    const roleId = Permissions.roleIdFor({ isAdmin: viewer.isAdmin, roleId: user?.roleId ?? null });
    const role = await db.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
    if (!role) return { ...viewer, roleId };
    return { ...viewer, roleId, rank: role.rank, keys: role.permissions.map((p) => p.permission) };
  }

  static async load(actor: PermissionUser, db: RoleDb = Db.client, env: Env = process.env): Promise<RolesData> {
    const [roles, people, notes, descriptions] = await Promise.all([
      db.role.findMany({ include: { permissions: true }, orderBy: [{ isSystem: "desc" }, { rank: "desc" }, { name: "asc" }] }),
      db.appUser.findMany({ select: { email: true, name: true, roleId: true }, orderBy: [{ createdAt: "asc" }, { email: "asc" }] }),
      RoleDescriptions.all(db),
      RoleDescriptions.enabled(db),
    ]);
    const byRole = new Map<string, RoleUser[]>();
    for (const p of people) {
      if (OwnerLock.isLocked(p.email, env)) continue;
      const id = RoleService.effectiveRoleId(p.email, p.roleId, env);
      byRole.set(id, [...(byRole.get(id) ?? []), { email: p.email, name: p.name?.trim() || p.email.split("@")[0] }]);
    }
    return {
      roles: roles.map((r) => ({
        id: r.id,
        name: r.name,
        description: notes.get(r.id) ?? SYSTEM_ROLE_DESCRIPTIONS[r.id] ?? "",
        rank: r.rank,
        isSystem: r.isSystem,
        keys: r.permissions.map((p) => p.permission),
        users: byRole.get(r.id) ?? [],
        editable: RoleEditPolicy.canEdit(actor, r, env),
      })),
      grantable: RoleEditPolicy.grantableKeys(actor, env),
      ownerCount: 1,
      descriptions,
    };
  }

  /** ADMIN_EMAILS stays a floor (matrix 11.5): an env admin counts as Admin, no stored role counts as Viewer. */
  private static effectiveRoleId(email: string, roleId: string | null, env: Env): string {
    const admins = (env.ADMIN_EMAILS ?? "").split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
    return Permissions.roleIdFor({ isAdmin: admins.includes(email.toLowerCase()), roleId });
  }

  static async saveKeys(actor: PermissionUser, roleId: string, keys: readonly string[], db: RoleTxDb = Db.client as unknown as RoleTxDb, env: Env = process.env): Promise<RoleResult> {
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== "string")) return { ok: false, message: RoleEditPolicy.NOT_FOUND };
    return db.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
      if (!role) return { ok: false, message: RoleEditPolicy.NOT_FOUND };
      const current = role.permissions.map((p) => p.permission);
      const next = [...new Set(keys)];
      const problem = RoleEditPolicy.checkSave(actor, { id: role.id, rank: role.rank, keys: current }, next, env);
      if (problem) return { ok: false, message: problem };
      const added = next.filter((k) => !current.includes(k));
      const removed = current.filter((k) => !next.includes(k));
      if (added.length === 0 && removed.length === 0) return { ok: true, message: "No changes." };
      if (removed.length) await tx.rolePermission.deleteMany({ where: { roleId, permission: { in: removed } } });
      if (added.length) await tx.rolePermission.createMany({ data: added.map((permission) => ({ roleId, permission })) });
      await RoleService.history(tx, roleId, "keys", { added, removed }, actor.email);
      return { ok: true, message: "Saved." };
    });
  }

  static async create(actor: PermissionUser, name: unknown, description: unknown, db: RoleTxDb = Db.client as unknown as RoleTxDb, env: Env = process.env): Promise<RoleResult> {
    if (!RoleEditPolicy.canOpen(actor, env)) return { ok: false, message: RoleEditPolicy.NOT_FOUND };
    const clean = RoleService.cleanName(name);
    if (!clean.ok) return clean;
    const rank = Math.min(15, Permissions.rankOf(actor, env) - 1);
    if (rank < 1) return { ok: false, message: RoleEditPolicy.RANK_MESSAGE };
    return RoleService.insert(actor, clean.value, RoleService.cleanDescription(description), rank, [], { from: null }, db);
  }

  static async duplicate(actor: PermissionUser, sourceId: string, db: RoleTxDb = Db.client as unknown as RoleTxDb, env: Env = process.env): Promise<RoleResult> {
    const source = await db.role.findUnique({ where: { id: sourceId }, include: { permissions: true } });
    if (!source || !RoleEditPolicy.canEdit(actor, source, env)) return { ok: false, message: RoleEditPolicy.NOT_FOUND };
    const keys = source.permissions.map((p) => p.permission);
    const problem = RoleEditPolicy.checkSave(actor, { id: "_new", rank: source.rank, keys: [] }, keys, env);
    if (problem) return { ok: false, message: problem };
    const taken = new Set((await db.role.findMany({ select: { name: true } })).map((r) => r.name.toLowerCase()));
    let name = `${source.name} copy`.slice(0, NAME_MAX);
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${source.name} copy ${i}`.slice(0, NAME_MAX);
    const description = (await RoleDescriptions.get(db, source.id)) ?? SYSTEM_ROLE_DESCRIPTIONS[source.id] ?? null;
    return RoleService.insert(actor, name, description, source.rank, keys, { from: source.id }, db);
  }

  static async rename(actor: PermissionUser, roleId: string, name: unknown, description: unknown, db: RoleTxDb = Db.client as unknown as RoleTxDb, env: Env = process.env): Promise<RoleResult> {
    const clean = RoleService.cleanName(name);
    if (!clean.ok) return clean;
    return db.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id: roleId } });
      if (!role || !RoleEditPolicy.canEdit(actor, role, env)) return { ok: false, message: RoleEditPolicy.NOT_FOUND };
      const enabled = await RoleDescriptions.enabled(tx);
      const currentDescription = enabled ? await RoleDescriptions.get(tx, roleId) : null;
      const nextDescription = role.isSystem || !enabled ? currentDescription : RoleService.cleanDescription(description);
      const clash = await tx.role.findFirst({ where: { name: { equals: clean.value, mode: "insensitive" }, NOT: { id: roleId } } });
      if (clash) return { ok: false, message: "A role with that name already exists." };
      if (clean.value === role.name && nextDescription === currentDescription) return { ok: true, message: "No changes." };
      if (clean.value !== role.name) await tx.role.update({ where: { id: roleId }, data: { name: clean.value }, select: { id: true } });
      if (nextDescription !== currentDescription) await RoleDescriptions.set(tx, roleId, nextDescription);
      await RoleService.history(tx, roleId, "rename", { from: role.name, to: clean.value, description: nextDescription }, actor.email);
      return { ok: true, message: "Saved.", roleId };
    });
  }

  /**
   * Deletes a custom role. People holding it move first to `moveToId`, which must rank below the actor; moving them
   * needs people.role.assign. System roles are never deleted.
   */
  static async remove(actor: PermissionUser, roleId: string, moveToId: string | null, db: RoleTxDb = Db.client as unknown as RoleTxDb, env: Env = process.env): Promise<RoleResult> {
    return db.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id: roleId } });
      if (!role || !RoleEditPolicy.canEdit(actor, role, env)) return { ok: false, message: RoleEditPolicy.NOT_FOUND };
      if (role.isSystem) return { ok: false, message: "System roles can't be deleted." };
      const holders = await tx.appUser.findMany({ where: { roleId }, select: { email: true } });
      let target: { id: string; rank: number } | null = null;
      if (holders.length > 0) {
        if (!moveToId || moveToId === roleId) return { ok: false, message: "Pick a role to move these users to." };
        target = await tx.role.findUnique({ where: { id: moveToId }, select: { id: true, rank: true } });
        if (!target || RoleEditPolicy.assignable(actor, [target], env).length === 0) return { ok: false, message: "You can only move users to a role below your own." };
        for (const h of holders) {
          if (!Permissions.canAssignRole(actor, { ...target, keys: [] }, h.email, env)) return { ok: false, message: "You can only move users to a role below your own." };
        }
        await tx.appUser.updateMany({ where: { roleId }, data: { roleId: target.id } });
        await tx.userRoleHistory.createMany({ data: holders.map((h) => ({ id: randomUUID(), email: h.email, fromRoleId: roleId, toRoleId: target!.id, actor: actor.email })) });
      }
      await RoleService.history(tx, roleId, "delete", { name: role.name, movedTo: target?.id ?? null, moved: holders.length }, actor.email);
      await tx.role.delete({ where: { id: roleId }, select: { id: true } });
      return { ok: true, message: "Role deleted." };
    });
  }

  private static async insert(actor: PermissionUser, name: string, description: string | null, rank: number, keys: string[], detail: Record<string, unknown>, db: RoleTxDb): Promise<RoleResult> {
    return db.$transaction(async (tx) => {
      const clash = await tx.role.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
      if (clash) return { ok: false, message: "A role with that name already exists." };
      const id = `custom-${randomUUID().slice(0, 8)}`;
      await tx.role.create({ data: { id, name, rank, isSystem: false, allLines: false }, select: { id: true } });
      if (description) await RoleDescriptions.set(tx, id, description);
      if (keys.length) await tx.rolePermission.createMany({ data: keys.map((permission) => ({ roleId: id, permission })) });
      await RoleService.history(tx, id, "create", { ...detail, name, rank, keys }, actor.email);
      return { ok: true, message: "Role created.", roleId: id };
    });
  }

  /** Append-only: the only write to role_history is an insert. */
  private static async history(tx: Pick<RoleDb, "roleHistory">, roleId: string, action: string, detail: Record<string, unknown>, actor: string): Promise<void> {
    await tx.roleHistory.create({ data: { id: randomUUID(), roleId, action, detail: detail as object, actor } });
  }

  private static cleanName(name: unknown): { ok: true; value: string } | { ok: false; message: string } {
    const value = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
    if (!value) return { ok: false, message: "Enter a role name." };
    if (value.length > NAME_MAX) return { ok: false, message: `Use ${NAME_MAX} characters or fewer.` };
    if (value.toLowerCase() === "owner") return { ok: false, message: "A role with that name already exists." };
    return { ok: true, value };
  }

  private static cleanDescription(description: unknown): string | null {
    const value = typeof description === "string" ? description.trim().replace(/\s+/g, " ").slice(0, DESCRIPTION_MAX) : "";
    return value || null;
  }
}
