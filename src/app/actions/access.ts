"use server";

import { revalidatePath } from "next/cache";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { LineAccessService, type AccessResult } from "@/lib/services/LineAccessService";

/**
 * Admin > People > Access. Server Actions are reachable by direct POST, so each resolves the viewer from the session
 * and re-checks admin (LineAccessService checks again).
 */
class AccessAction {
  static async run(work: () => Promise<AccessResult>, failure: string): Promise<AccessResult> {
    try {
      const result = await work();
      if (result.ok) {
        revalidatePath("/admin/people");
        revalidatePath("/", "layout"); // the person's switcher and pages change on their next request
      }
      return result;
    } catch (e) {
      console.error("Access change failed", e);
      return { ok: false, message: failure };
    }
  }
}

export async function setLineAccess(email: string, serviceLineId: string, on: boolean): Promise<AccessResult> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, message: LineAccessCopy.SAVE_ERROR };
  return AccessAction.run(() => LineAccessService.setAccess(viewer, email, serviceLineId, on === true), LineAccessCopy.SAVE_ERROR);
}

export async function addAccessUser(email: string): Promise<AccessResult> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, message: LineAccessCopy.SAVE_ERROR };
  return AccessAction.run(() => LineAccessService.addUser(viewer, email), LineAccessCopy.SAVE_ERROR);
}
