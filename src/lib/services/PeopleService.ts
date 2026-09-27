import type { PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ContractsLeadRules, ContractsLeadValidationError } from "@/lib/people/ContractsLeadRules";
import { PeopleDirectory, type PeopleRole } from "@/lib/people/PeopleDirectory";
import { PeopleListRules, PeopleListValidationError } from "@/lib/people/PeopleListRules";
import { ProjectService } from "@/lib/services/ProjectService";
import { ServiceLineService } from "@/lib/services/ServiceLineService";

export interface PersonRow {
  name: string;
  /** Projects of the line (not deleted) that use this name (for a locked row: that use the built-in option). */
  projects: number;
  /** Built-in option ("To assign", "Not applicable"): always offered, can't be renamed or removed. */
  locked: boolean;
}

export interface PeopleLists {
  owners: PersonRow[];
  requesters: PersonRow[];
}

type PeopleScope = Pick<ServiceLineScope, "id" | "owners" | "requesters">;

export interface ContractsLeadRow {
  name: string;
  /** Projects of the line (not deleted) that list this lead. */
  projects: number;
}

/**
 * Admin > People: Owners and Requesters (item 5) and Contracts leads, the active line's pick-lists. Every change
 * goes through ServiceLineService (admin-only, audited in service_line_history). Removing a name never touches
 * projects: they keep the name they have. Renaming an owner or requester also updates the line's projects.
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

  /**
   * Owners and Requesters sections: the locked rows first (with the projects using each built-in option), then the
   * list A to Z. Counts ignore case and spacing and skip deleted projects.
   */
  static async lists(scope: PeopleScope, admin: Viewer, db: Pick<PrismaClient, "project"> = Db.client): Promise<PeopleLists> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.project.findMany({
      where: { archivedAt: null, ...ServiceLineAccess.where(scope) },
      select: { owner: true, physicianChampion: true, requesterNotApplicable: true },
    });
    const blank = (v: string | null) => PeopleDirectory.normalizeName(v) === "";
    const count = (values: (string | null)[], name: string) => values.filter((v) => PeopleListRules.sameName(v, name)).length;
    const owners = rows.map((r) => r.owner);
    const requesters = rows.map((r) => r.physicianChampion);
    return {
      owners: [
        { name: PeopleListRules.locked("owner")[0], projects: rows.filter((r) => blank(r.owner)).length, locked: true },
        ...PeopleService.sorted(scope.owners).map((name) => ({ name, projects: count(owners, name), locked: false })),
      ],
      requesters: [
        { name: PeopleListRules.locked("requester")[0], projects: rows.filter((r) => blank(r.physicianChampion) && r.requesterNotApplicable).length, locked: true },
        { name: PeopleListRules.locked("requester")[1], projects: rows.filter((r) => blank(r.physicianChampion) && !r.requesterNotApplicable).length, locked: true },
        ...PeopleService.sorted(scope.requesters).map((name) => ({ name, projects: count(requesters, name), locked: false })),
      ],
    };
  }

  /** Adds a name to the owner or requester list (stored A to Z). Throws PeopleListValidationError with the field message. */
  static async addPerson(scope: PeopleScope, role: PeopleRole, raw: unknown, admin: Viewer, db: PrismaClient = Db.client): Promise<string> {
    AdminPolicy.assertAdmin(admin);
    const list = PeopleService.listOf(scope, role);
    const name = PeopleListRules.parse(role, raw, list);
    await ServiceLineService.setPeopleList(scope.id, role, PeopleService.sorted([...list, name]), admin, db);
    return name;
  }

  /**
   * Renames a list name and, in the same transaction, every project of the line (not deleted) that uses it. The
   * new name may differ only in case. Returns the new name and how many projects changed.
   */
  static async renamePerson(scope: PeopleScope, role: PeopleRole, name: string, raw: unknown, admin: Viewer, db: PrismaClient = Db.client): Promise<{ name: string; projects: number }> {
    AdminPolicy.assertAdmin(admin);
    const list = PeopleService.listOf(scope, role);
    if (!list.includes(name)) throw new PeopleListValidationError(PeopleListRules.notListed(role, name));
    const next = PeopleListRules.parse(role, raw, list, name);
    if (next === name) throw new PeopleListValidationError(PeopleListRules.RENAME_UNCHANGED);
    const field = role === "owner" ? "owner" : "physicianChampion";
    return db.$transaction(async (tx) => {
      const projects = await ProjectService.renamePerson(tx, scope, field, name, next, admin);
      await ServiceLineService.writePeopleList(tx, scope.id, role, PeopleService.sorted(list.map((n) => (n === name ? next : n))), admin);
      return { name: next, projects };
    });
  }

  /** Removes a name from the list. Projects keep it; the combobox shows it with "Not on list". */
  static async removePerson(scope: PeopleScope, role: PeopleRole, name: string, admin: Viewer, db: PrismaClient = Db.client): Promise<void> {
    AdminPolicy.assertAdmin(admin);
    const list = PeopleService.listOf(scope, role);
    const next = list.filter((n) => n !== name);
    if (next.length === list.length) throw new PeopleListValidationError(PeopleListRules.notListed(role, name));
    await ServiceLineService.setPeopleList(scope.id, role, next, admin, db);
  }

  /**
   * The combobox "Add 'X'" path: a name saved on a project that is not on the line's list joins it, so the next
   * project offers it too. Blank, built-in and blocked names are skipped. Returns whether the list changed.
   */
  static async rememberPerson(scope: PeopleScope, role: PeopleRole, raw: string, admin: Viewer, db: PrismaClient = Db.client): Promise<boolean> {
    AdminPolicy.assertAdmin(admin);
    const name = PeopleDirectory.normalizeName(raw);
    const list = PeopleService.listOf(scope, role);
    if (!name || PeopleDirectory.isSentinel(name) || PeopleDirectory.isBlocked(name) || name.length > PeopleListRules.NAME_MAX) return false;
    if (list.some((n) => PeopleListRules.sameName(n, name))) return false;
    await ServiceLineService.setPeopleList(scope.id, role, PeopleService.sorted([...list, name]), admin, db);
    return true;
  }

  private static listOf(scope: PeopleScope, role: PeopleRole): string[] {
    return [...(role === "owner" ? scope.owners : scope.requesters)];
  }

  private static sorted(names: readonly string[]): string[] {
    return [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  }
}
