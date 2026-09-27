import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { PeopleService } from "@/lib/services/PeopleService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidationError } from "@/lib/validation/ProjectValidator";

export type PeopleFieldResult = { ok: true } | { ok: false; error: string };

/**
 * The drawer's people fields (owner, requester, contracts lead, department): the server side of
 * setProjectPeopleField. Only admins may edit them (the drawer editor is admin-only and ProjectService checks
 * again). A new name picked with "Add 'X'" in the Owner or Requester combobox joins the line's list only when
 * the viewer is an admin (PeopleService.rememberPerson); otherwise only the project value would change.
 */
export class ProjectPeopleForms {
  static readonly UNKNOWN_FIELD = "Unknown field.";
  static readonly NOT_AUTHORIZED = "Not authorized.";
  static readonly INVALID = "Invalid value.";
  static readonly FAILED = "Could not save the change.";

  static async setField(viewer: Viewer | null, projectId: string, field: string, value: string, db: PrismaClient = Db.client, scope?: ServiceLineScope): Promise<PeopleFieldResult> {
    if (!ProjectService.isPeopleField(field)) return { ok: false, error: ProjectPeopleForms.UNKNOWN_FIELD };
    if (!viewer?.isAdmin) return { ok: false, error: ProjectPeopleForms.NOT_AUTHORIZED };
    const text = String(value ?? "");
    try {
      const line = scope ?? (await ServiceLineAccess.activeFor(viewer, db));
      await ProjectService.setPeopleField(projectId, field, text, viewer, db, line);
      if (field === "owner" || field === "physicianChampion") {
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
