import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { MilestoneEdit } from "@/lib/domain/MilestoneRules";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { OwnerNameLists } from "@/lib/people/OwnerNameLists";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

type NamesDb = Pick<PrismaClient, "milestoneOwnerName">;
type StepsDb = Pick<PrismaClient, "milestoneOwnerName" | "projectMilestone">;
type LineScope = Pick<ServiceLineScope, "id" | "owners" | "requesters" | "contractsLeads">;

/**
 * Server side of the name lists (migration 0036). Owner and Requester names typed on a project reuse the spelling
 * already on any of the line's lists. A milestone owner typed in that is on no list is saved to the line's
 * milestone-owner list (milestone_owner_names), never to Owners, Requesters or Contracts leads; there is no prompt.
 * The unique index on (serviceLineId, nameKey) makes two admins typing the same new name at once end with one row.
 */
export class OwnerNamesService {
  /** Stored step ids are uuids; the drawer's "legacy" placeholder step is not. */
  private static readonly UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** The line's milestone-owner list, A to Z. */
  static async milestoneOwners(lineId: string, db: NamesDb = Db.client): Promise<string[]> {
    const rows = await db.milestoneOwnerName.findMany({ where: { serviceLineId: lineId }, select: { name: true } });
    return PeopleDirectory.merge(rows.map((r) => r.name));
  }

  /** Same, but an empty list when the table can't be read (the dashboard still loads). */
  static async milestoneOwnersOrEmpty(lineId: string, db: NamesDb = Db.client): Promise<string[]> {
    try {
      return await OwnerNamesService.milestoneOwners(lineId, db);
    } catch (e) {
      console.error("Could not load the milestone owner list", e);
      return [];
    }
  }

  /** Milestone Owner picker options: every list of the line together (OwnerNameLists.combined). */
  static async pickerOptions(scope: LineScope, db: NamesDb = Db.client): Promise<string[]> {
    return OwnerNameLists.combined(scope, await OwnerNamesService.milestoneOwnersOrEmpty(scope.id, db));
  }

  /**
   * A project Owner or Requester value as typed: the saved spelling when the name is on any list, else the value
   * unchanged (blank, built-in options and new names pass through; PeopleService.rememberPerson adds a new one).
   */
  static async savedSpelling(scope: LineScope, raw: string, db: NamesDb = Db.client): Promise<string> {
    const r = OwnerNameLists.resolve(scope, await OwnerNamesService.milestoneOwnersOrEmpty(scope.id, db), raw);
    return r.kind === "listed" ? r.name : raw;
  }

  /** Save one new name to the milestone-owner list (or find the row that won a race) and return its stored spelling. */
  static async addMilestoneOwner(lineId: string, name: string, viewer: Viewer, db: NamesDb = Db.client): Promise<string> {
    const nameKey = OwnerNameLists.key(name);
    await db.milestoneOwnerName.createMany({ data: [{ serviceLineId: lineId, name: PeopleDirectory.normalizeName(name), nameKey, createdBy: viewer.email }], skipDuplicates: true });
    const row = await db.milestoneOwnerName.findUnique({ where: { serviceLineId_nameKey: { serviceLineId: lineId, nameKey } }, select: { name: true } });
    return row?.name ?? PeopleDirectory.normalizeName(name);
  }

  /**
   * Before a checklist save: each step's owner gets its saved spelling, a typed name on no list joins the
   * milestone-owner list, and the returned scope offers every list as the owners MilestoneService checks against.
   * Steps without an owner change and steps keeping their stored owner are left exactly as they are.
   */
  static async prepareMilestones<S extends LineScope>(scope: S, edit: MilestoneEdit | null, viewer: Viewer, db: StepsDb = Db.client): Promise<{ edit: MilestoneEdit | null; scope: S }> {
    if (!edit) return { edit, scope };
    const milestoneOwners = await OwnerNamesService.milestoneOwners(scope.id, db);
    const ids = edit.drafts.map((d) => d.id).filter((id): id is string => typeof id === "string" && OwnerNamesService.UUID.test(id));
    const stored = ids.length ? await db.projectMilestone.findMany({ where: { id: { in: ids } }, select: { id: true, owner: true } }) : [];
    const kept = new Map(stored.map((s) => [s.id, s.owner]));
    const added: string[] = [];
    const drafts = [];
    for (const d of edit.drafts) {
      // No owner change, or the step keeps the owner it has (even one on no list): left exactly as it is.
      if (d.owner === undefined || d.owner === null || (d.id && kept.get(d.id) === d.owner)) {
        drafts.push(d);
        continue;
      }
      const r = OwnerNameLists.resolve(scope, [...milestoneOwners, ...added], d.owner);
      if (r.kind === "blank") drafts.push({ ...d, owner: null });
      else if (r.kind === "listed") drafts.push({ ...d, owner: r.name });
      else if (r.kind === "new") {
        const saved = await OwnerNamesService.addMilestoneOwner(scope.id, r.name, viewer, db);
        added.push(saved);
        drafts.push({ ...d, owner: saved });
      } else drafts.push(d);
    }
    return { edit: { ...edit, drafts }, scope: { ...scope, owners: OwnerNameLists.combined(scope, [...milestoneOwners, ...added]) } };
  }
}
