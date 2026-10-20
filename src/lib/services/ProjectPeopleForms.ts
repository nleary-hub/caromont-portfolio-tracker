import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { OwnerNamesService } from "@/lib/services/OwnerNamesService";
import { PeopleService } from "@/lib/services/PeopleService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidationError } from "@/lib/validation/ProjectValidator";

export type PeopleFieldResult = { ok: true } | { ok: false; error: string };

/**
 * The drawer's people fields (owner, requester, contracts lead, department): the server side of
 * setProjectPeopleField. Only admins may edit them (the drawer editor is admin-only and ProjectService checks
 * again). A new name picked with "Add 'X'" in the Owner or Requester combobox joins the line's list only when
 * the viewer is an admin (PeopleService.rememberPerson); otherwise only the project value would change. A typed name
 * that matches a name on any of the line's lists reuses that spelling first (OwnerNamesService.savedSpelling).
 */
export class ProjectPeopleForms {
  static readonly UNKNOWN_FIELD = "Unknown field.";
  static readonly NOT_AUTHORIZED = "Not authorized.";
  static readonly INVALID = "Invalid value.";
  static readonly FAILED = "Could not save the change.";
  /** Longest one-off contracts lead name. */
  static readonly ONCE_MAX = 80;

  /**
   * `once` (item 4, "Use once (don't save to list)"): the name is stored on this project only. Owner and requester
   * skip rememberPerson; a contracts lead not on the line's list is accepted for this save only (the list is not
   * changed; later saves keep it because an unchanged stored value is grandfathered).
   */
  static async setField(viewer: Viewer | null, projectId: string, field: string, value: string, db: PrismaClient = Db.client, scope?: ServiceLineScope, opts: { once?: boolean } = {}): Promise<PeopleFieldResult> {
    if (!ProjectService.isPeopleField(field)) return { ok: false, error: ProjectPeopleForms.UNKNOWN_FIELD };
    if (!viewer?.isAdmin) return { ok: false, error: ProjectPeopleForms.NOT_AUTHORIZED };
    let text = String(value ?? "");
    try {
      const line = scope ?? (await ServiceLineAccess.activeFor(viewer, db));
      // A typed name already on any of the line's lists (any case or spacing) is saved with that list's spelling.
      if (field === "owner" || field === "physicianChampion") text = await OwnerNamesService.savedSpelling(line, text, db);
      const once = opts.once === true;
      const name = text.trim().replace(/\s+/g, " ");
      if (once && field === "contractsLead" && (!name || name.length > ProjectPeopleForms.ONCE_MAX)) return { ok: false, error: ProjectPeopleForms.INVALID };
      const rulesScope = once && field === "contractsLead" ? { ...line, contractsLeads: [...line.contractsLeads, name] } : line;
      await ProjectService.setPeopleField(projectId, field, once && field === "contractsLead" ? name : text, viewer, db, rulesScope);
      if (!once && (field === "owner" || field === "physicianChampion")) {
        await PeopleService.rememberPerson(line, field === "owner" ? "owner" : "requester", text, viewer, db).catch((e) => console.error("Admin action failed: rememberPerson", e));
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof ProjectValidationError) return { ok: false, error: Object.values(e.errors).flat()[0] ?? ProjectPeopleForms.INVALID };
      console.error("Admin action failed: setProjectPeopleField", e);
      return { ok: false, error: ProjectPeopleForms.FAILED };
    }
  }
}
