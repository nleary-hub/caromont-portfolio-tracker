import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { DisplayName } from "@/lib/auth/DisplayName";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";
import { Db } from "@/lib/db/Db";
import { ServiceLine } from "@/lib/domain/ServiceLine";

type Env = Record<string, string | undefined>;
type Tx = Pick<Prisma.TransactionClient, "appUser" | "serviceLine" | "serviceLineAccessGrant" | "serviceLineAccessHistory">;

/** A line column in the Access grid: short code in the header, full name as its tooltip. */
export interface AccessLine {
  id: string;
  shortName: string;
  name: string;
}

/** One person in the Access grid. Admin rows are read-only ("All lines"). */
export interface AccessRow {
  email: string;
  name: string;
  isAdmin: boolean;
  /** Open lines this person has access rows for (empty for admins: they see every line). */
  lineIds: string[];
}

export interface AccessGrid {
  lines: AccessLine[];
  admins: AccessRow[];
  users: AccessRow[];
  /** Whether "Add user" is offered (see LineAccessService.CAN_ADD_BEFORE_SIGN_IN). */
  canAdd: boolean;
}

export type AccessResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Admin > People > Access (item 8): who may see which service line. Admin-only reads and writes (checked here on
 * every call); each change is logged to service_line_access_history in the same transaction.
 */
export class LineAccessService {
  /**
   * "Add user" decision: sign-in is the ALLOWED_EMAILS check on the email (Auth.js with JWT sessions, no user table or
   * provider account link), and access rows are keyed by that same lowercased email. So an admin can give an email
   * access before its first sign-in, and it applies the moment that person signs in.
   */
  static readonly CAN_ADD_BEFORE_SIGN_IN = true;

  static normalize(email: unknown): string {
    return typeof email === "string" ? email.trim().toLowerCase() : "";
  }

  static isValidEmail(email: string): boolean {
    return /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)+$/.test(email) && email.length <= 254;
  }

  static displayName(row: { email: string; name?: string | null }): string {
    return DisplayName.nameOrNull(row.name, row.email) ?? DisplayName.fromEmail(row.email);
  }

  /**
   * Record the signed-in person (first page load after sign-in) so they show up in the Access grid. Keeps the
   * identity provider's display name current. Never grants anything.
   */
  static async touch(viewer: Viewer & { name?: string | null }, db: Pick<Prisma.TransactionClient, "appUser"> = Db.client): Promise<void> {
    const email = LineAccessService.normalize(viewer.email);
    if (!email) return;
    const name = DisplayName.nameOrNull(viewer.name, email);
    const now = new Date();
    const found = await db.appUser.findUnique({ where: { email } });
    if (!found) {
      try {
        await db.appUser.create({ data: { email, name, firstSignInAt: now } });
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e; // a parallel request recorded them first
      }
      return;
    }
    const data: { name?: string; firstSignInAt?: Date } = {};
    if (name && found.name !== name) data.name = name;
    if (!found.firstSignInAt) data.firstSignInAt = now;
    if (Object.keys(data).length) await db.appUser.update({ where: { email }, data });
  }

  /** touch() that never breaks a page: a failed write is logged and ignored. */
  static async touchQuietly(viewer: Viewer & { name?: string | null }): Promise<void> {
    if (!Db.isConfigured()) return;
    await LineAccessService.touch(viewer).catch((e) => console.error("Could not record the signed-in user", e));
  }

  /** Every open line (default first, then A to Z) and every person, admins first then A to Z. */
  static async grid(viewer: Viewer | null, db: Pick<PrismaClient, "appUser" | "serviceLine"> = Db.client, env: Env = process.env): Promise<AccessGrid> {
    AdminPolicy.assertAdmin(viewer);
    const [lineRows, users] = await Promise.all([
      db.serviceLine.findMany({ where: { archivedAt: null, deletedAt: null }, include: ServiceLineAccess.INCLUDE }),
      db.appUser.findMany({ include: { access: true } }),
    ]);
    const lines = ServiceLine.sortForSwitcher(lineRows.map((r) => ServiceLineAccess.toScope(r))).map(({ id, shortName, name }) => ({ id, shortName, name }));
    const open = new Set(lines.map((l) => l.id));
    const rows = new Map<string, AccessRow>();
    for (const u of users) {
      const isAdmin = AdminPolicy.isAdmin(u.email, env);
      rows.set(u.email, { email: u.email, name: LineAccessService.displayName(u), isAdmin, lineIds: isAdmin ? [] : u.access.map((a) => a.serviceLineId).filter((id) => open.has(id)) });
    }
    // Admins listed by exact email in ADMIN_EMAILS show up even before their first sign-in.
    for (const email of AdminPolicy.fromEnv(env).exactEmails()) {
      if (!rows.has(email) && AdminPolicy.isAdmin(email, env)) rows.set(email, { email, name: DisplayName.fromEmail(email), isAdmin: true, lineIds: [] });
    }
    const byName = (a: AccessRow, b: AccessRow) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.email.localeCompare(b.email);
    const all = [...rows.values()];
    return {
      lines,
      admins: all.filter((r) => r.isAdmin).sort(byName),
      users: all.filter((r) => !r.isAdmin).sort(byName),
      canAdd: LineAccessService.CAN_ADD_BEFORE_SIGN_IN,
    };
  }

  /** Check or uncheck one cell. Idempotent. The last-line confirm is the page's job; the server allows it. */
  static async setAccess(viewer: Viewer | null, emailIn: unknown, serviceLineId: unknown, on: boolean, db: PrismaClient = Db.client, env: Env = process.env): Promise<AccessResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = LineAccessService.normalize(emailIn);
    if (!email || typeof serviceLineId !== "string" || AdminPolicy.isAdmin(email, env)) return { ok: false, message: LineAccessCopy.SAVE_ERROR };
    return db.$transaction(async (tx: Tx) => {
      const user = await tx.appUser.findUnique({ where: { email } });
      const line = await tx.serviceLine.findUnique({ where: { id: serviceLineId } });
      if (!user || !line || !ServiceLineAccess.isOpen(line)) return { ok: false as const, message: LineAccessCopy.SAVE_ERROR };
      const name = LineAccessService.displayName(user);
      const key = { email_serviceLineId: { email, serviceLineId } };
      const existing = await tx.serviceLineAccessGrant.findUnique({ where: key });
      if (on && !existing) {
        await tx.serviceLineAccessGrant.create({ data: { email, serviceLineId, grantedBy: viewer.email } });
        await tx.serviceLineAccessHistory.create({ data: { email, serviceLineId, action: "granted", changedBy: viewer.email } });
      } else if (!on && existing) {
        await tx.serviceLineAccessGrant.delete({ where: key });
        await tx.serviceLineAccessHistory.create({ data: { email, serviceLineId, action: "revoked", changedBy: viewer.email } });
      }
      return { ok: true as const, message: on ? LineAccessCopy.grantedToast(name, line.shortName) : LineAccessCopy.revokedToast(name, line.shortName) };
    });
  }

  /** "Add user": an email that can sign in (ALLOWED_EMAILS), not listed yet; starts with no lines. */
  static async addUser(viewer: Viewer | null, emailIn: unknown, db: PrismaClient = Db.client, env: Env = process.env): Promise<AccessResult> {
    AdminPolicy.assertAdmin(viewer);
    const email = LineAccessService.normalize(emailIn);
    if (!LineAccessService.isValidEmail(email)) return { ok: false, message: LineAccessCopy.INVALID_EMAIL };
    const listedAdmin = AdminPolicy.fromEnv(env).exactEmails().includes(email) && AdminPolicy.isAdmin(email, env);
    if (listedAdmin) return { ok: false, message: LineAccessCopy.DUPLICATE_EMAIL };
    if (!EmailAllowlist.isAllowed(email, env)) return { ok: false, message: LineAccessCopy.NOT_ALLOWED_EMAIL };
    return db.$transaction(async (tx: Tx) => {
      if (await tx.appUser.findUnique({ where: { email } })) return { ok: false as const, message: LineAccessCopy.DUPLICATE_EMAIL };
      await tx.appUser.create({ data: { email, addedBy: viewer.email } });
      await tx.serviceLineAccessHistory.create({ data: { email, action: "user_added", changedBy: viewer.email } });
      return { ok: true as const, message: LineAccessCopy.addedToast(email) };
    });
  }
}
