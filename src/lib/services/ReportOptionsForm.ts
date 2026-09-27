import type { DepartmentKey } from "@/lib/domain/ServiceAreaInfo";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { TotalsGridPlacement } from "@/lib/domain/TotalsGridPlacement";
import { ReportOptionsService, type ReportOptionsValue } from "@/lib/services/ReportOptionsService";
import { ReportColorScheme, type ReportColorsValue } from "@/lib/report/ReportColorScheme";

export type ReportOptionsFormState = { ok: true; message: string; value: ReportOptionsValue } | { ok: false; message: string } | null;

/** Handles the admin "Report" settings (departments in report, totals grid). The Server Action only resolves the viewer and revalidates. */
export class ReportOptionsForm {
  static readonly NOT_AUTHORIZED = "Not authorized.";

  /** Form fields to a patch: every checked "departments" value (at least one; none means all) and "totalsGrid". */
  static parse(input: { departments: unknown[]; totalsGrid: unknown }, options: readonly DepartmentKey[] = DepartmentFilter.OPTIONS): Pick<ReportOptionsValue, "departments" | "totalsGrid"> {
    return { departments: DepartmentFilter.normalize(input.departments, options), totalsGrid: TotalsGridPlacement.normalize(input.totalsGrid) };
  }

  /** Saves the report settings of `scope` (the admin's active line). */
  static async submit(
    viewer: Viewer | null,
    input: { departments: unknown[]; totalsGrid: unknown },
    db: PrismaClient = Db.client,
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<ReportOptionsFormState> {
    if (!viewer?.isAdmin) return { ok: false, message: ReportOptionsForm.NOT_AUTHORIZED };
    try {
      const value = await ReportOptionsService.update(ReportOptionsForm.parse(input, DepartmentFilter.optionsFor(scope)), viewer, db, scope);
      return { ok: true, message: "Saved. Applies to the next freeze and to drafts.", value };
    } catch (e) {
      console.error("Report options update failed", e);
      return { ok: false, message: "Could not save the change." };
    }
  }
}

export type ReportColorsFormState =
  | { ok: true; message: string; value: ReportColorsValue }
  | { ok: false; message: string; field?: "bar" | "band" }
  | null;

/** Handles Admin > Report contents > Report colors (department bars and the page 1 title band). */
export class ReportColorsForm {
  /**
   * Form fields to a value, or the first error. "bar" / "band" are a preset key ("none" too for the band) or
   * "custom", with the color in "barHex" / "bandHex". A custom color must be a hex color whose derived text meets AA.
   */
  static parse(input: { bar: unknown; barHex: unknown; band: unknown; bandHex: unknown }): { ok: true; value: ReportColorsValue } | { ok: false; message: string; field: "bar" | "band" } {
    const pick = (choice: unknown, hex: unknown, allowNone: boolean): { ok: true; key: string } | { ok: false; message: string } => {
      if (allowNone && choice === ReportColorScheme.NONE) return { ok: true, key: ReportColorScheme.NONE };
      if (ReportColorScheme.isPreset(choice)) return { ok: true, key: choice };
      if (choice !== ReportColorScheme.CUSTOM) return { ok: false, message: ReportColorScheme.COPY.invalid };
      const color = ReportColorScheme.hex(hex);
      if (!color) return { ok: false, message: ReportColorScheme.COPY.invalid };
      const check = ReportColorScheme.check(color);
      return check.ok ? { ok: true, key: color } : check;
    };
    const bar = pick(input.bar, input.barHex, false);
    if (!bar.ok) return { ok: false, message: bar.message, field: "bar" };
    const band = pick(input.band, input.bandHex, true);
    if (!band.ok) return { ok: false, message: band.message, field: "band" };
    return { ok: true, value: { bar: bar.key, band: band.key } };
  }

  /** Saves the colors of `scope` (the admin's active line): one report_options_history row (the audit), nothing else. */
  static async submit(
    viewer: Viewer | null,
    input: { bar: unknown; barHex: unknown; band: unknown; bandHex: unknown },
    db: PrismaClient = Db.client,
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<ReportColorsFormState> {
    if (!viewer?.isAdmin) return { ok: false, message: ReportOptionsForm.NOT_AUTHORIZED };
    const parsed = ReportColorsForm.parse(input);
    if (!parsed.ok) return parsed;
    try {
      const value = await ReportOptionsService.update({ colors: parsed.value }, viewer, db, scope);
      return { ok: true, message: ReportColorScheme.COPY.saved, value: value.colors };
    } catch (e) {
      console.error("Report colors update failed", e);
      return { ok: false, message: ReportColorScheme.COPY.failed };
    }
  }
}
