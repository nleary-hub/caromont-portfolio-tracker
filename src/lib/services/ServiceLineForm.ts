import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ServiceLineValidationError, type ServiceLineField, type ServiceLineValue } from "@/lib/domain/ServiceLine";
import { ServiceLineService } from "@/lib/services/ServiceLineService";

export type ServiceLineFormState =
  | { ok: true; message: string; value: ServiceLineValue }
  | { ok: false; message: string; errors?: Partial<Record<ServiceLineField, string>> }
  | null;

/** Handles the admin "Service line" settings form. The Server Action only resolves the viewer and revalidates. */
export class ServiceLineForm {
  static readonly NOT_AUTHORIZED = "Not authorized.";

  static async submit(viewer: Viewer | null, input: { name?: unknown; shortName?: unknown }, db: PrismaClient = Db.client): Promise<ServiceLineFormState> {
    if (!viewer?.isAdmin) return { ok: false, message: ServiceLineForm.NOT_AUTHORIZED };
    try {
      const value = await ServiceLineService.update(input, viewer, db);
      return { ok: true, message: "Saved.", value };
    } catch (e) {
      if (e instanceof ServiceLineValidationError) return { ok: false, message: "Fix the fields below.", errors: e.errors };
      console.error("Service line settings update failed", e);
      return { ok: false, message: "Could not save the change." };
    }
  }
}
