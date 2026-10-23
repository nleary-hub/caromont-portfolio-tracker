import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { DisplayName } from "@/lib/auth/DisplayName";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";
import { Db } from "@/lib/db/Db";
import { RoleAssignment, type RoleCheck, type RoleOption } from "@/lib/people/RoleAssignment";
import { OwnerLock } from "@/lib/permissions/OwnerLock";
import { Permissions, type PermissionUser } from "@/lib/permissions/Permissions";
import { ROLE_DEFAULTS, roleSeed } from "@/lib/permissions/RoleDefaults";

type Env = Record<string, string | undefined>;

/** A stored person (app_user) with the lines and departments they hold. */
export interface StoredPerson {
  email: string;
  name: string | null;
  roleId: string | null;
  firstSignInAt: Date | null;
  createdAt: Date;
  /** Line ids they hold, and a short label for the Department column. */
  lineIds: string[];
  departmentLabel: string | null;
  hasPassword: boolean;
}

/**
 * The storage PeopleRoleService needs. Every write is one transaction that also appends a user_role_history row
 * (append-only: migration 0069 blocks UPDATE and DELETE on it).
 */
export interface PeopleRoleStore {
  roles(): Promise<{ id: string; name: string; rank: number; allLines: boolean }[]>;
  roleKeys(roleId: string): Promise<string[] | null>;
  people(): Promise<StoredPerson[]>;
  person(email: string): Promise<StoredPerson | null>;
  /** Sets app_user.roleId and appends the history row. */
  setRole(email: string, fromRoleId: string | null, toRoleId: string, actor: string, id: string): Promise<void>;
  /** Creates the pending app_user with its role and appends history. False when the email already exists. */
  invite(email: string, name: string | null, roleId: string, actor: string, id: string): Promise<boolean>;
  /** Removes a pending (never signed in, no lines, no password) person and appends history. False when not pending. */
  revoke(email: string, fromRoleId: string | null, actor: string, id: string): Promise<boolean>;
  /** AI cost per email since the date (the People AI usage column). */
  aiCost(since: Date): Promise<Record<string, number>>;
}

export interface PersonRow {
  email: string;
  name: string;
  initials: string;
  pending: boolean;
  invitedAt: string;
  firstSignInAt: string | null;
  department: string;
  roleId: string;
  roleName: string;
  owner: boolean;
  you: boolean;
  canChange: boolean;
  canRevoke: boolean;
  aiCostUsd: number;
}

export interface PeopleDirectoryData {
  people: PersonRow[];
  /** Roles the viewer may hand out (picker and Invite user), highest first. */
  assignable: RoleOption[];
  canInvite: boolean;
  actorRoleName: string;
  departmentCount: number;
}

export type PeopleResult = { ok: true; message: string } | { ok: false; message: string };

/** People > roles and invites. Every read and write resolves the actor through the permission engine. */
export class PeopleRoleService {
  static readonly INVALID_EMAIL = "Enter a valid email.";
  static readonly NOT_ALLOWED_EMAIL = "That email can't sign in to the tracker. Ask the owner to allow it first.";
  static readonly DUPLICATE = "That person is already listed.";
  static readonly NOT_PENDING = "Only pending invites with no line access can be revoked.";
  static readonly NOT_FOUND = "Not found.";
  static readonly AI_CAP_EXAMPLE_USD = 10;

  static normalize(email: unknown): string {
    return typeof email === "string" ? email.trim().toLowerCase() : "";
  }

  static async roleOptions(store: PeopleRoleStore): Promise<(RoleOption & { allLines: boolean })[]> {
    const stored = await store.roles().catch(() => []);
    const list = stored.length ? stored : ROLE_DEFAULTS.map((r) => ({ id: r.id, name: r.name, rank: r.rank, allLines: r.allLines }));
    return list.map((r) => ({ ...r, description: RoleAssignment.description(r.id) })).sort((a, b) => b.rank - a.rank);
  }

  /** The viewer with their role, rank and keys from the database (seeded defaults when the role has no rows). */
  static async actor(viewer: Viewer, store: PeopleRoleStore, env: Env = process.env): Promise<PermissionUser & { allLines: boolean; lineIds: string[] }> {
    const me = await store.person(PeopleRoleService.normalize(viewer.email));
    const roleId = Permissions.roleIdFor({ isAdmin: viewer.isAdmin || AdminPolicy.isAdmin(viewer.email, env), roleId: me?.roleId ?? null });
    const roles = await PeopleRoleService.roleOptions(store);
    const role = roles.find((r) => r.id === roleId);
    const keys = (await store.roleKeys(roleId).catch(() => null)) ?? roleSeed(roleId)?.keys ?? [];
    const allLines = OwnerLock.isOwnerViewer(viewer, env) || viewer.isAdmin || (role?.allLines ?? false);
    return { ...viewer, roleId, rank: role?.rank ?? roleSeed(roleId)?.rank ?? 0, keys: [...keys], allLines, lineIds: me?.lineIds ?? [] };
  }

  private static sharesLine(actor: { allLines: boolean; lineIds: string[] }, target: StoredPerson | null): boolean {
    if (actor.allLines) return true;
    return Boolean(target && target.lineIds.some((id) => actor.lineIds.includes(id)));
  }

  static initials(name: string): string {
    const parts = name.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
  }

  /** The People table: people the viewer may see (Admins and the Owner see everyone; others share a line). */
  static async directory(viewer: Viewer | null, store: PeopleRoleStore, env: Env = process.env, now: Date = new Date()): Promise<PeopleDirectoryData | null> {
    if (!viewer) return null;
    const actor = await PeopleRoleService.actor(viewer, store, env);
    if (!Permissions.can(actor, "people.view", env)) return null;
    const roles = await PeopleRoleService.roleOptions(store);
    const stored = await store.people();
    const byEmail = new Map(stored.map((p) => [p.email, p]));
    // Owners and ADMIN_EMAILS admins listed by exact email show up before their first sign-in.
    for (const email of [...OwnerPolicy.ownerEmails(env), ...AdminPolicy.fromEnv(env).exactEmails()]) {
      if (!byEmail.has(email) && AdminPolicy.isAdmin(email, env)) byEmail.set(email, { email, name: null, roleId: null, firstSignInAt: null, createdAt: now, lineIds: [], departmentLabel: null, hasPassword: false });
    }
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const cost = await store.aiCost(since).catch(() => ({}) as Record<string, number>);
    const me = PeopleRoleService.normalize(viewer.email);
    const rows: PersonRow[] = [];
    for (const p of byEmail.values()) {
      const owner = OwnerLock.isLocked(p.email, env);
      const envAdmin = AdminPolicy.isAdmin(p.email, env);
      if (!PeopleRoleService.sharesLine(actor, p) && p.email !== me) continue;
      const roleId = RoleAssignment.roleIdOf(p, env);
      const name = DisplayName.of(p.name, p.email);
      const pending = !p.firstSignInAt && !envAdmin;
      const target = { email: p.email, roleId: p.roleId };
      rows.push({
        email: p.email,
        name,
        initials: PeopleRoleService.initials(name),
        pending,
        invitedAt: p.createdAt.toISOString(),
        firstSignInAt: p.firstSignInAt?.toISOString() ?? null,
        department: envAdmin || owner ? "All lines" : p.departmentLabel ?? "No lines yet",
        roleId: owner ? "owner" : roleId,
        roleName: owner ? "Owner" : roles.find((r) => r.id === roleId)?.name ?? roleId,
        owner,
        you: p.email === me,
        canChange: !owner && RoleAssignment.canActOn(actor, target, roles, env),
        canRevoke: pending && !owner && !p.hasPassword && p.lineIds.length === 0 && Permissions.can(actor, "people.user.add", env) && RoleAssignment.canActOn(actor, target, roles, env),
        aiCostUsd: cost[p.email] ?? 0,
      });
    }
    const rank = (r: PersonRow) => (r.owner ? 1000 : roles.find((x) => x.id === r.roleId)?.rank ?? 0);
    rows.sort((a, b) => Number(b.pending) - Number(a.pending) || rank(b) - rank(a) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
    const assignable = RoleAssignment.assignable(actor, roles, env).map(({ id, name, rank, description }) => ({ id, name, rank, description }));
    const departments = new Set(rows.map((r) => r.department).filter((d) => d !== "All lines" && d !== "No lines yet"));
    const actorRole = OwnerLock.isOwnerViewer(viewer, env) ? "Owner" : roles.find((r) => r.id === actor.roleId)?.name ?? "Viewer";
    return { people: rows, assignable, canInvite: Permissions.can(actor, "people.user.add", env) && assignable.length > 0, actorRoleName: actorRole, departmentCount: departments.size };
  }

  /** Change a person's role. Strict rank rule and the Owner lock, then one transaction with a history row. */
  static async assignRole(viewer: Viewer | null, emailIn: unknown, roleIdIn: unknown, store: PeopleRoleStore, env: Env = process.env): Promise<PeopleResult> {
    if (!viewer) return { ok: false, message: PeopleRoleService.NOT_FOUND };
    const email = PeopleRoleService.normalize(emailIn);
    const roleId = typeof roleIdIn === "string" ? roleIdIn : "";
    if (OwnerLock.isLocked(email, env)) return { ok: false, message: RoleAssignment.OWNER_LOCKED };
    const actor = await PeopleRoleService.actor(viewer, store, env);
    const roles = await PeopleRoleService.roleOptions(store);
    const target = await store.person(email);
    if (!target) return { ok: false, message: PeopleRoleService.NOT_FOUND };
    if (!PeopleRoleService.sharesLine(actor, target)) return { ok: false, message: PeopleRoleService.NOT_FOUND };
    const check: RoleCheck = RoleAssignment.checkAssign(actor, target, roleId, roles, env);
    if (!check.ok) return check;
    const from = RoleAssignment.roleIdOf(target, env);
    const role = roles.find((r) => r.id === roleId)!;
    const name = DisplayName.of(target.name, target.email);
    if (from === roleId && target.roleId === roleId) return { ok: true, message: `${name} is already ${role.name}.` };
    await store.setRole(email, from, roleId, PeopleRoleService.normalize(viewer.email), randomUUID());
    return { ok: true, message: `${name} is now ${role.name}.` };
  }

  /**
   * Invite user: a pending person with a role. Sign-in is unchanged: the email must already be allowed to sign in
   * (ALLOWED_EMAILS), exactly like Add user. No email is sent; they show as Pending until they first sign in.
   */
  static async invite(viewer: Viewer | null, input: { email?: unknown; name?: unknown; roleId?: unknown }, store: PeopleRoleStore, env: Env = process.env): Promise<PeopleResult> {
    if (!viewer) return { ok: false, message: PeopleRoleService.NOT_FOUND };
    const email = PeopleRoleService.normalize(input?.email);
    const roleId = typeof input?.roleId === "string" ? input.roleId : "";
    const name = typeof input?.name === "string" ? input.name.trim().slice(0, 120) || null : null;
    if (OwnerLock.isLocked(email, env)) return { ok: false, message: RoleAssignment.OWNER_LOCKED };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, message: PeopleRoleService.INVALID_EMAIL };
    const actor = await PeopleRoleService.actor(viewer, store, env);
    const roles = await PeopleRoleService.roleOptions(store);
    const check = RoleAssignment.checkInvite(actor, email, roleId, roles, env);
    if (!check.ok) return check;
    if (!EmailAllowlist.isAllowed(email, env)) return { ok: false, message: PeopleRoleService.NOT_ALLOWED_EMAIL };
    if (await store.person(email)) return { ok: false, message: PeopleRoleService.DUPLICATE };
    const created = await store.invite(email, name, roleId, PeopleRoleService.normalize(viewer.email), randomUUID());
    if (!created) return { ok: false, message: PeopleRoleService.DUPLICATE };
    const role = roles.find((r) => r.id === roleId)!;
    return { ok: true, message: `Invited ${name ?? email} as ${role.name}. No email is sent; they show as Pending until they first sign in.` };
  }

  /** Revoke a pending invite (never signed in, no lines, no password). Same rank rule; a history row records it. */
  static async revoke(viewer: Viewer | null, emailIn: unknown, store: PeopleRoleStore, env: Env = process.env): Promise<PeopleResult> {
    if (!viewer) return { ok: false, message: PeopleRoleService.NOT_FOUND };
    const email = PeopleRoleService.normalize(emailIn);
    if (OwnerLock.isLocked(email, env)) return { ok: false, message: RoleAssignment.OWNER_LOCKED };
    const actor = await PeopleRoleService.actor(viewer, store, env);
    if (!Permissions.can(actor, "people.user.add", env)) return { ok: false, message: RoleAssignment.NOT_ALLOWED };
    const roles = await PeopleRoleService.roleOptions(store);
    const target = await store.person(email);
    if (!target) return { ok: false, message: PeopleRoleService.NOT_FOUND };
    const check = RoleAssignment.checkTarget(actor, target, roles, env);
    if (!check.ok) return check;
    if (target.firstSignInAt || target.lineIds.length || target.hasPassword) return { ok: false, message: PeopleRoleService.NOT_PENDING };
    const done = await store.revoke(email, RoleAssignment.roleIdOf(target, env), PeopleRoleService.normalize(viewer.email), randomUUID());
    return done ? { ok: true, message: `Revoked the invite for ${DisplayName.of(target.name, target.email)}.` } : { ok: false, message: PeopleRoleService.NOT_PENDING };
  }
}

type PrismaPeople = Pick<PrismaClient, "appUser" | "role" | "rolePermission" | "userRoleHistory" | "aiUsageLog" | "$transaction">;

/** The Prisma-backed store. */
export class PrismaPeopleRoleStore implements PeopleRoleStore {
  constructor(private readonly db: PrismaPeople = Db.client as unknown as PrismaPeople) {}

  async roles() {
    return this.db.role.findMany({ select: { id: true, name: true, rank: true, allLines: true }, orderBy: { rank: "desc" } });
  }

  async roleKeys(roleId: string) {
    const rows = await this.db.rolePermission.findMany({ where: { roleId }, select: { permission: true } });
    return rows.length ? rows.map((r) => r.permission) : null;
  }

  private static toPerson(u: {
    email: string; name: string | null; roleId: string | null; firstSignInAt: Date | null; createdAt: Date; password: unknown;
    access: { serviceLineId: string; allDepartments: boolean; serviceLine: { name: string }; departments: { department: { name: string } }[] }[];
  }): StoredPerson {
    const depts = u.access.flatMap((a) => (a.allDepartments === false ? a.departments.map((d) => d.department.name) : []));
    const lines = u.access.filter((a) => a.allDepartments !== false).map((a) => a.serviceLine.name);
    const labels = [...depts, ...lines];
    const label = labels.length ? labels[0] + (labels.length > 1 ? ` +${labels.length - 1}` : "") : null;
    return { email: u.email, name: u.name, roleId: u.roleId, firstSignInAt: u.firstSignInAt, createdAt: u.createdAt, lineIds: u.access.map((a) => a.serviceLineId), departmentLabel: label, hasPassword: Boolean(u.password) };
  }

  private static readonly INCLUDE = {
    password: { select: { email: true } },
    access: { include: { serviceLine: { select: { name: true } }, departments: { include: { department: { select: { name: true } } } } } },
  } as const;

  async people() {
    const rows = await this.db.appUser.findMany({ include: PrismaPeopleRoleStore.INCLUDE });
    return rows.map((u) => PrismaPeopleRoleStore.toPerson(u));
  }

  async person(email: string) {
    const u = await this.db.appUser.findUnique({ where: { email }, include: PrismaPeopleRoleStore.INCLUDE });
    return u ? PrismaPeopleRoleStore.toPerson(u) : null;
  }

  async setRole(email: string, fromRoleId: string | null, toRoleId: string, actor: string, id: string) {
    await this.db.$transaction([
      this.db.appUser.update({ where: { email }, data: { roleId: toRoleId } }),
      this.db.userRoleHistory.create({ data: { id, email, fromRoleId, toRoleId, actor } }),
    ]);
  }

  async invite(email: string, name: string | null, roleId: string, actor: string, id: string) {
    try {
      await this.db.$transaction([
        this.db.appUser.create({ data: { email, name, roleId, addedBy: actor } }),
        this.db.userRoleHistory.create({ data: { id, email, fromRoleId: null, toRoleId: roleId, actor } }),
      ]);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") return false;
      throw e;
    }
  }

  async revoke(email: string, fromRoleId: string | null, actor: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const removed = await tx.appUser.deleteMany({ where: { email, firstSignInAt: null, access: { none: {} }, password: null } });
      if (removed.count === 0) return false;
      await tx.userRoleHistory.create({ data: { id, email, fromRoleId, toRoleId: null, actor } });
      return true;
    });
  }

  async aiCost(since: Date) {
    const rows = await this.db.aiUsageLog.groupBy({ by: ["userEmail"], where: { createdAt: { gte: since } }, _sum: { costUsd: true } });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.userEmail] = Number(r._sum.costUsd ?? 0);
    return out;
  }
}
