import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import { DepartmentCopy, DepartmentValidationError, type DepartmentField } from "@/lib/domain/DepartmentRules";
import { ContractsLeadRules, ContractsLeadValidationError } from "@/lib/people/ContractsLeadRules";
import { DepartmentNotFoundError, DepartmentRestoreConflictError, DepartmentService } from "@/lib/services/DepartmentService";
import { PeopleService } from "@/lib/services/PeopleService";

/** Result of a Departments or People admin action (toast text, or per-field errors). */
export type AdminListResult = { ok: true; message: string } | { ok: false; message: string; errors?: Partial<Record<DepartmentField, string>> };

/**
 * Departments and People admin actions for the viewer's active line. Server Actions only resolve the viewer and
 * revalidate; the services check admin again and write the history.
 */
export class DepartmentForms {
  static readonly NOT_AUTHORIZED = "Not authorized.";
  static readonly FAILED = "Couldn't save the change. Try again.";
  static readonly GONE = "That department no longer exists. Refresh the page.";

  static async save(viewer: Viewer | null, input: { id?: unknown; name?: unknown; shortName?: unknown }, db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v, scope) => {
      await DepartmentService.save(scope, input, v, db);
      return { ok: true, message: DepartmentCopy.SAVED_TOAST };
    });
  }

  static async reorder(viewer: Viewer | null, ids: readonly unknown[], db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v, scope) => {
      await DepartmentService.reorder(scope, ids, v, db);
      return { ok: true, message: DepartmentCopy.MOVED_TOAST };
    });
  }

  static async archive(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v, scope) => {
      const name = await DepartmentService.archive(scope, id, v, db);
      return { ok: true, message: DepartmentCopy.archivedToast(name) };
    });
  }

  static async unarchive(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v, scope) => {
      const name = await DepartmentService.unarchive(scope, id, v, db);
      return { ok: true, message: DepartmentCopy.unarchivedToast(name) };
    });
  }

  static async remove(viewer: Viewer | null, id: string, input: { confirmName?: unknown; moveTo?: unknown }, db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v, scope) => {
      const r = await DepartmentService.remove(scope, id, input, v, db);
      return { ok: true, message: DepartmentCopy.deletedToast(r.name, r.moved, r.to) };
    });
  }

  static async restore(viewer: Viewer | null, id: string, db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v) => {
      const name = await DepartmentService.restore(id, v, db);
      return { ok: true, message: DepartmentCopy.restoredToast(name) };
    });
  }

  static async addContractsLead(viewer: Viewer | null, name: unknown, db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v, scope) => ({ ok: true, message: ContractsLeadRules.addedToast(await PeopleService.addContractsLead(scope, name, v, db)) }));
  }

  static async removeContractsLead(viewer: Viewer | null, name: string, db: PrismaClient = Db.client): Promise<AdminListResult> {
    return DepartmentForms.run(viewer, db, async (v, scope) => {
      await PeopleService.removeContractsLead(scope, name, v, db);
      return { ok: true, message: ContractsLeadRules.removedToast(name) };
    });
  }

  private static async run(
    viewer: Viewer | null,
    db: PrismaClient,
    work: (viewer: Viewer, scope: Awaited<ReturnType<typeof ServiceLineAccess.activeFor>>) => Promise<AdminListResult>,
  ): Promise<AdminListResult> {
    if (!viewer?.isAdmin) return { ok: false, message: DepartmentForms.NOT_AUTHORIZED };
    try {
      return await work(viewer, await ServiceLineAccess.activeFor(viewer, db));
    } catch (e) {
      if (e instanceof DepartmentValidationError) return { ok: false, message: Object.values(e.errors)[0] ?? DepartmentForms.FAILED, errors: e.errors };
      if (e instanceof ContractsLeadValidationError) return { ok: false, message: e.error, errors: { name: e.error } };
      if (e instanceof DepartmentRestoreConflictError) return { ok: false, message: DepartmentCopy.RESTORE_CONFLICT };
      if (e instanceof DepartmentNotFoundError) return { ok: false, message: DepartmentForms.GONE };
      console.error("Department or people action failed", e);
      return { ok: false, message: DepartmentForms.FAILED };
    }
  }
}
