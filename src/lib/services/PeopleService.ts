import type { PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ContractsLeadRules, ContractsLeadValidationError } from "@/lib/people/ContractsLeadRules";
import { ServiceLineService } from "@/lib/services/ServiceLineService";

export interface ContractsLeadRow {
  name: string;
  /** Projects of the line (not deleted) that list this lead. */
  projects: number;
}

/**
 * Admin > People (this PR: the Contracts leads section). The list is the line's contracts lead pick-list; every
 * change goes through ServiceLineService.setContractsLeads, so it is admin-only and audited as before. Removing a
 * name never touches projects: they keep the lead they have.
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
}
