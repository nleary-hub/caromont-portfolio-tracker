import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { TotalsGridPlacement } from "@/lib/domain/TotalsGridPlacement";
import { ReportOptionsService, type ReportOptionsValue } from "@/lib/services/ReportOptionsService";

export type ReportOptionsFormState = { ok: true; message: string; value: ReportOptionsValue } | { ok: false; message: string } | null;

/** Handles the admin "Report" settings (departments in report, totals grid). The Server Action only resolves the viewer and revalidates. */
export class ReportOptionsForm {
  static readonly NOT_AUTHORIZED = "Not authorized.";

  /** Form fields to a patch: every checked "departments" value (at least one; none means all) and "totalsGrid". */
  static parse(input: { departments: unknown[]; totalsGrid: unknown }): Pick<ReportOptionsValue, "departments" | "totalsGrid"> {
    return { departments: DepartmentFilter.normalize(input.departments), totalsGrid: TotalsGridPlacement.normalize(input.totalsGrid) };
  }

  static async submit(viewer: Viewer | null, input: { departments: unknown[]; totalsGrid: unknown }, db: PrismaClient = Db.client): Promise<ReportOptionsFormState> {
    if (!viewer?.isAdmin) return { ok: false, message: ReportOptionsForm.NOT_AUTHORIZED };
    try {
      const value = await ReportOptionsService.update(ReportOptionsForm.parse(input), viewer, db);
      return { ok: true, message: "Saved. Applies to the next freeze and to drafts.", value };
    } catch (e) {
      console.error("Report options update failed", e);
      return { ok: false, message: "Could not save the change." };
    }
  }
}
