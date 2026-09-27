import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ContractsLeadRules, ContractsLeadValidationError } from "@/lib/people/ContractsLeadRules";
import { PeopleListRules, PeopleListValidationError, type PeopleListRole } from "@/lib/people/PeopleListRules";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { ServiceLineService } from "@/lib/services/ServiceLineService";

type Tx = Prisma.TransactionClient;

export interface ContractsLeadRow {
  name: string;
  /** Projects of the line (not deleted) that list this lead. */
  projects: number;
}

/** One editable name on the Owners or Requesters list. Locked built-ins are not rows. */
export interface PeopleOptionRow {
  name: string;
  /** Projects of the line (not deleted) whose owner or requester is this name, ignoring case. */
  projects: number;
}

/**
 * Admin > People. Owners and requesters are the line's curated lists (people_option, migration 0020). Contracts
 * leads stay the line's contractsLeads array. Removing a name never touches projects: they keep what they have.
 * Renaming an owner or requester updates every not-deleted project on the line that uses the name, and writes
 * ProjectHistory. Every list change is admin-only and appended to people_option_history (or service line history
 * for contracts leads).
 */
export class PeopleService {
  static async contractsLeads(scope: Pick<ServiceLineScope, "id" | "contractsLeads">, admin: Viewer, db: Pick<PrismaClient, "project"> = Db.client): Promise<ContractsLeadRow[]> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.project.findMany({ where: { archivedAt: null, contractsLead: { not: null }, ...ServiceLineAccess.where(scope) }, select: { contractsLead: true } });
    const count = (name: string) => rows.filter((r) => (r.contractsLead ?? "").toLowerCase() === name.toLowerCase()).length;
    return scope.contractsLeads.map((name) => ({ name, projects: count(name) }));
  }

  /** Adds a name at the end of the list. Throws ContractsLeadValidationError with the field message. */
  static async addContractsLead(scope: Pick<ServiceLineScope, "id" | "contractsLeads">, raw: unknown, admin: Viewer, db: PrismaClient = Db.client): Promise<string> {
    AdminPolicy.assertAdmin(admin);
    const name = ContractsLeadRules.parse(raw, scope.contractsLeads);
    await ServiceLineService.setContractsLeads(scope.id, [...scope.contractsLeads, name], admin, db);
    return name;
  }

  static async removeContractsLead(scope: Pick<ServiceLineScope, "id" | "contractsLeads">, name: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    const next = scope.contractsLeads.filter((n) => n !== name);
    if (next.length === scope.contractsLeads.length) throw new ContractsLeadValidationError(`${name} is not a contracts lead.`);
    await ServiceLineService.setContractsLeads(scope.id, next, admin, db);
  }

  /** Editable names for the People page, with how many live projects use each. Locked built-ins are not included. */
  static async options(scope: Pick<ServiceLineScope, "id">, role: PeopleListRole, admin: Viewer, db: PrismaClient = Db.client): Promise<PeopleOptionRow[]> {
    AdminPolicy.assertAdmin(admin);
    const [list, projects] = await Promise.all([
      db.peopleOption.findMany({ where: { serviceLineId: scope.id, role }, orderBy: { position: "asc" }, select: { name: true } }),
      db.project.findMany({ where: { archivedAt: null, ...ServiceLineAccess.where(scope) }, select: { owner: true, physicianChampion: true } }),
    ]);
    return list.map((row) => ({ name: row.name, projects: PeopleService.count(projects, role, row.name) }));
  }

  /**
   * Names the owner or requester combobox offers, in People-page order. Not derived from projects.
   * Sentinels are dropped. The dashboard calls this for admins only.
   */
  static async names(scope: Pick<ServiceLineScope, "id">, role: PeopleListRole, db: Pick<PrismaClient, "peopleOption"> = Db.client): Promise<string[]> {
    const rows = await db.peopleOption.findMany({ where: { serviceLineId: scope.id, role }, orderBy: { position: "asc" }, select: { name: true } });
    return PeopleDirectory.offer(rows.map((r) => r.name));
  }

  /** Adds a name at the end of the list. Throws PeopleListValidationError with the field message. */
  static async addOption(scope: Pick<ServiceLineScope, "id">, role: PeopleListRole, raw: unknown, admin: Viewer, db: PrismaClient = Db.client): Promise<string> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const existing = await PeopleService.rows(tx, scope.id, role);
      const name = PeopleListRules.parse(role, raw, existing.map((r) => r.name));
      const position = existing.reduce((max, r) => Math.max(max, r.position), 0) + 1;
      const row = await tx.peopleOption.create({ data: { serviceLineId: scope.id, role, name, position, updatedBy: admin.email } });
      await PeopleService.log(tx, scope.id, row.id, role, "added", null, { name }, admin);
      return name;
    });
  }

  /**
   * Renames the list row and every not-deleted project on the line that uses the old name (ignoring case).
   * Soft-deleted projects and frozen snapshots keep the old spelling. Returns the new name and how many
   * live projects listed the old one (the toast count).
   */
  static async renameOption(
    scope: Pick<ServiceLineScope, "id">,
    role: PeopleListRole,
    from: string,
    raw: unknown,
    admin: Viewer,
    db: PrismaClient = Db.client,
  ): Promise<{ name: string; projects: number }> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const existing = await PeopleService.rows(tx, scope.id, role);
      const row = existing.find((r) => PeopleService.same(r.name, from));
      if (!row) throw new PeopleListValidationError(PeopleListRules.missing(role, from));
      const name = PeopleListRules.parse(role, raw, existing.filter((r) => r.id !== row.id).map((r) => r.name), "rename");
      if (row.name !== name) {
        await tx.peopleOption.update({ where: { id: row.id }, data: { name, updatedBy: admin.email } });
        await PeopleService.log(tx, scope.id, row.id, role, "renamed", { name: row.name }, { name }, admin);
      }
      const field = PeopleListRules.field(role);
      const projects = await tx.project.findMany({
        where: { archivedAt: null, ...ServiceLineAccess.where(scope) },
        select: { id: true, owner: true, physicianChampion: true },
      });
      const hits = projects.filter((p) => PeopleService.same(p[field], row.name));
      const now = new Date();
      for (const p of hits) {
        const current = p[field];
        if (current === name) continue;
        await tx.project.update({ where: { id: p.id }, data: { [field]: name, updatedBy: admin.email } });
        await tx.projectHistory.create({
          data: { projectId: p.id, field, oldValue: current, newValue: name, changedAt: now, changedBy: admin.email, comment: null },
        });
      }
      return { name, projects: hits.length };
    });
  }

  /** Drops the name from the list. Projects that already use it keep it. */
  static async removeOption(scope: Pick<ServiceLineScope, "id">, role: PeopleListRole, name: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    await db.$transaction(async (tx) => {
      const existing = await PeopleService.rows(tx, scope.id, role);
      const row = existing.find((r) => r.name === name) ?? existing.find((r) => PeopleService.same(r.name, name));
      if (!row) throw new PeopleListValidationError(PeopleListRules.missing(role, name));
      await tx.peopleOption.delete({ where: { id: row.id } });
      await PeopleService.log(tx, scope.id, row.id, role, "removed", { name: row.name }, null, admin);
    });
  }

  private static async rows(tx: Tx, serviceLineId: string, role: PeopleListRole): Promise<{ id: string; name: string; position: number }[]> {
    return tx.peopleOption.findMany({ where: { serviceLineId, role }, orderBy: { position: "asc" }, select: { id: true, name: true, position: true } });
  }

  private static count(projects: readonly { owner: string | null; physicianChampion: string | null }[], role: PeopleListRole, name: string): number {
    const field = PeopleListRules.field(role);
    return projects.filter((p) => PeopleService.same(p[field], name)).length;
  }

  private static same(stored: string | null | undefined, name: string): boolean {
    const key = PeopleDirectory.normalizeName(stored).toLowerCase();
    return key !== "" && key === name.toLowerCase();
  }

  private static async log(
    tx: Tx,
    serviceLineId: string,
    peopleOptionId: string | null,
    role: PeopleListRole,
    action: string,
    oldValue: { name: string } | null,
    newValue: { name: string } | null,
    admin: Viewer,
  ): Promise<void> {
    await tx.peopleOptionHistory.create({
      data: {
        serviceLineId,
        peopleOptionId,
        role,
        action,
        oldValue: oldValue ?? undefined,
        newValue: newValue ?? undefined,
        changedBy: admin.email,
      },
    });
  }
}
