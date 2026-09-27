"use server";

import { revalidatePath } from "next/cache";
import { AdminPolicy } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ReportLog } from "@/lib/report/ReportLog";
import { FreezeService } from "@/lib/services/FreezeService";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { ReportOptionsForm, type ReportOptionsFormState } from "@/lib/services/ReportOptionsForm";
import { YearEndReportService } from "@/lib/services/YearEndReportService";
import { TotalsGridPlacement } from "@/lib/domain/TotalsGridPlacement";
import { YearEndCopy } from "@/lib/report/YearEndReportData";

export type FreezeNowState = { ok: boolean; message: string } | null;

/** Admin "Freeze now" (manual backstop for the biweekly cron). Re-checks ADMIN_EMAILS itself. */
export async function freezeNow(): Promise<FreezeNowState> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, message: "Not authorized." };
  try {
    AdminPolicy.assertAdmin(viewer);
    // Freeze is the scheduled report: always the default line (CVPSL), whatever line the admin has open.
    const result = await FreezeService.run({ trigger: "manual", actor: viewer.email });
    revalidatePath("/reports");
    const delivery = result.delivery ? ` Delivery: ${result.delivery.status.replace("_", " ")}.` : "";
    return { ok: result.outcome !== "refused", message: `${result.message}${delivery}` };
  } catch (e) {
    ReportLog.error("freeze.manual.failed", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: "Freeze failed. See the server logs." };
  }
}

/** Admin report freeze options (applies to the next freeze and to drafts). */
export async function setShowKeyPageForm(form: FormData): Promise<void> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return;
  try {
    const scope = await ServiceLineAccess.activeFor(viewer);
    const totalsGrid = form.get("totalsGrid");
    await ReportOptionsService.update(
      {
        showKeyPage: form.get("showKeyPage") === "on",
        ...(totalsGrid !== null ? { totalsGrid: TotalsGridPlacement.normalize(totalsGrid) } : {}),
      },
      viewer,
      undefined,
      scope,
    );
    revalidatePath("/reports");
    revalidatePath("/admin/settings");
  } catch (e) {
    ReportLog.error("report_options.update.failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

/** Admin "Report" settings: departments in report and totals grid placement (applies to the next freeze and to drafts). */
export async function saveReportOptions(_prev: ReportOptionsFormState, form: FormData): Promise<ReportOptionsFormState> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, message: ReportOptionsForm.NOT_AUTHORIZED };
  const scope = await ServiceLineAccess.activeFor(viewer);
  const state = await ReportOptionsForm.submit(viewer, { departments: form.getAll("departments"), totalsGrid: form.get("totalsGrid") }, undefined, scope);
  if (state?.ok) {
    revalidatePath("/admin/settings");
    revalidatePath("/reports");
  }
  return state;
}

export type YearEndActionResult = { ok: true; id: string; fileName: string } | { ok: false; message: string };

/** Admin "Year-end report": render and store the PDF for the active line (never emailed or scheduled). */
export async function generateYearEndReport(fiscalYear: string): Promise<YearEndActionResult> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, message: "Not authorized." };
  try {
    const scope = await ServiceLineAccess.activeFor(viewer);
    const entry = await YearEndReportService.generate(viewer, String(fiscalYear), scope);
    ReportLog.info("year_end.generated", { id: entry.id, fiscalYear: entry.fiscalYear, serviceLineId: scope.id });
    revalidatePath("/reports");
    return { ok: true, id: entry.id, fileName: entry.fileName };
  } catch (e) {
    ReportLog.error("year_end.failed", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: YearEndCopy.ERROR };
  }
}
