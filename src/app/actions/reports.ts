"use server";

import { revalidatePath } from "next/cache";
import { AdminPolicy } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ReportLog } from "@/lib/report/ReportLog";
import { FreezeService } from "@/lib/services/FreezeService";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";

export type FreezeNowState = { ok: boolean; message: string } | null;

/** Admin "Freeze now" (manual backstop for the biweekly cron). Re-checks ADMIN_EMAILS itself. */
export async function freezeNow(): Promise<FreezeNowState> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, message: "Not authorized." };
  try {
    AdminPolicy.assertAdmin(viewer);
    const result = await FreezeService.run({ trigger: "manual", actor: viewer.email });
    revalidatePath("/reports");
    const delivery = result.delivery ? ` Delivery: ${result.delivery.status.replace("_", " ")}.` : "";
    return { ok: result.outcome !== "refused", message: `${result.message}${delivery}` };
  } catch (e) {
    ReportLog.error("freeze.manual.failed", { error: e instanceof Error ? e.message : String(e) });
    return { ok: false, message: "Freeze failed. See the server logs." };
  }
}

/** Admin toggle for the status and flag key page (applies to the next freeze and to drafts). */
export async function setShowKeyPageForm(form: FormData): Promise<void> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return;
  try {
    await ReportOptionsService.update({ showKeyPage: form.get("showKeyPage") === "on" }, viewer);
    revalidatePath("/reports");
  } catch (e) {
    ReportLog.error("report_options.update.failed", { error: e instanceof Error ? e.message : String(e) });
  }
}
