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
    const result = await ServiceLineForms.run(viewer, async (v) => {
      await ServiceLineService.restore(id, v, db);
      return { ok: true, message: "Restored." };
    });
    // A line created after the delete may have taken the name or short name; say so plainly on the Audit page.
    if (!result.ok && result.errors && (result.errors.name || result.errors.shortName)) return { ...result, message: ServiceLineCopy.RESTORE_CONFLICT };
    return result;
  }

  /** The switcher: any signed-in viewer, to a line they may use (admins: any open line; others: their lines). */
  static async switchTo(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<ServiceLineActionResult> {
    if (!viewer) return { ok: false, message: ServiceLineForms.NOT_AUTHORIZED };
    try {
      const line = await ServiceLineAccess.setActive(viewer, String(id ?? ""), db);
      return { ok: true, message: ServiceLineCopy.switchedToast(line.shortName), line, switchedTo: line.shortName };
    } catch (e) {
      if (e instanceof ServiceLineAccessError) return { ok: false, message: "That service line is not available." };
      console.error("Service line switch failed", e);
      return { ok: false, message: ServiceLineForms.FAILED };
    }
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
        return { ok: false, message: e.errors._form ?? ServiceLineCopy.FORM_ERROR, errors: e.errors };
      }
      if (e instanceof ServiceLineNotFoundError || e instanceof ServiceLineAccessError) return { ok: false, message: "That service line is not available." };
      console.error("Service line action failed", e);
      return { ok: false, message: ServiceLineForms.FAILED };
    }
  }
}

