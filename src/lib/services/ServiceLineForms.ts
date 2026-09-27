import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess, ServiceLineAccessError } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import { ServiceLineCopy, ServiceLineValidationError, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ServiceLineNotFoundError, ServiceLineService } from "@/lib/services/ServiceLineService";

export type ServiceLineErrorKey = "name" | "shortName" | "confirm" | "_form";

/** Result of any service line admin action. `switchedTo` is set when the viewer's active line changed (toast). */
export type ServiceLineActionResult =
  | { ok: true; message: string; line?: ServiceLineScope; switchedTo?: string }
  | { ok: false; message: string; errors?: Partial<Record<ServiceLineErrorKey, string>> };

/**
 * Handles the service line admin actions (Service lines page, switcher, Settings). Server Actions only resolve
 * the viewer and revalidate; ServiceLineService checks admin again and writes the history.
 */
export class ServiceLineForms {
  static readonly NOT_AUTHORIZED = "Not authorized.";
  static readonly FAILED = "Could not save the change.";

  static async save(viewer: Viewer | null, input: { id?: unknown; name?: unknown; shortName?: unknown }, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    return ServiceLineForms.run(viewer, async (v) => {
      const id = typeof input.id === "string" && input.id ? input.id : null;
      const line = id ? await ServiceLineService.update(id, input, v, db) : await ServiceLineService.create(input, v, db);
      return { ok: true, message: id ? "Saved." : `${line.name} created.`, line };
    });
  }

  static async archive(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    return ServiceLineForms.run(viewer, async (v) => {
      const wasActive = await ServiceLineForms.isActive(v, id, db);
      await ServiceLineService.archive(id, v, db);
      return ServiceLineForms.afterLeaving(v, wasActive, "Archived.", db);
    });
  }

  static async unarchive(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    return ServiceLineForms.run(viewer, async (v) => {
      await ServiceLineService.unarchive(id, v, db);
      return { ok: true, message: "Unarchived." };
    });
  }

  static async remove(viewer: Viewer | null, id: string, confirmName: unknown, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    return ServiceLineForms.run(viewer, async (v) => {
      const wasActive = await ServiceLineForms.isActive(v, id, db);
      await ServiceLineService.softDelete(id, String(confirmName ?? ""), v, db);
      return ServiceLineForms.afterLeaving(v, wasActive, "Deleted.", db);
    });
  }

  static async restore(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    return ServiceLineForms.run(viewer, async (v) => {
      await ServiceLineService.restore(id, v, db);
      return { ok: true, message: "Restored." };
    });
  }

  static async switchTo(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    return ServiceLineForms.run(viewer, async (v) => {
      const line = await ServiceLineAccess.setActive(v, id, db);
      return { ok: true, message: ServiceLineCopy.switchedToast(line.shortName), line, switchedTo: line.shortName };
    });
  }

  static async departments(viewer: Viewer | null, id: string, departments: readonly unknown[], db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    return ServiceLineForms.run(viewer, async (v) => ({ ok: true, message: "Saved.", line: await ServiceLineService.setDepartments(id, departments, v, db) }));
  }

  static async contractsLeads(viewer: Viewer | null, id: string, text: unknown, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    // One name per line in the textarea.
    const leads = String(text ?? "").split(/\r?\n/);
    return ServiceLineForms.run(viewer, async (v) => ({ ok: true, message: "Saved.", line: await ServiceLineService.setContractsLeads(id, leads, v, db) }));
  }

  private static async isActive(viewer: Viewer, id: string, db: PrismaClient): Promise<boolean> {
    return (await ServiceLineAccess.activeFor(viewer, db)).id === id;
  }

  /** Archiving or deleting the active line switches the viewer to the default line ("Switched to CVPSL"). */
  private static async afterLeaving(viewer: Viewer, wasActive: boolean, message: string, db: PrismaClient): Promise<ServiceLineActionResult> {
    if (!wasActive) return { ok: true, message };
    const line = await ServiceLineAccess.defaultLine(db);
    await ServiceLineAccess.setActive(viewer, line.id, db);
    return { ok: true, message: ServiceLineCopy.switchedToast(line.shortName), switchedTo: line.shortName };
  }

  private static async run(viewer: Viewer | null, work: (viewer: Viewer) => Promise<ServiceLineActionResult>): Promise<ServiceLineActionResult> {
    if (!viewer?.isAdmin) return { ok: false, message: ServiceLineForms.NOT_AUTHORIZED };
    try {
      return await work(viewer);
    } catch (e) {
      if (e instanceof ServiceLineValidationError) {
        return { ok: false, message: e.errors._form ?? "Fix the fields below.", errors: e.errors };
      }
      if (e instanceof ServiceLineNotFoundError || e instanceof ServiceLineAccessError) return { ok: false, message: "That service line is not available." };
      console.error("Service line action failed", e);
      return { ok: false, message: ServiceLineForms.FAILED };
    }
  }
}

