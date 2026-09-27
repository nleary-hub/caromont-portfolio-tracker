"use server";

import { revalidatePath } from "next/cache";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ClosedPagesCopy } from "@/lib/closed/ClosedPagesCopy";
import { ProjectService } from "@/lib/services/ProjectService";

export type RestoreActionResult = { ok: true; name: string; statusLabel: string } | { ok: false; error: string };

/**
 * Cancelled page "Restore to active". Admin only: re-checked here from the session (a Server Action is reachable by
 * direct POST) and again in ProjectService. Runs in the viewer's active service line; anything else is "not found".
 */
export async function restoreCancelledProject(projectId: string): Promise<RestoreActionResult> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, error: ClosedPagesCopy.RESTORE_ERROR };
  if (typeof projectId !== "string" || !projectId) return { ok: false, error: ClosedPagesCopy.RESTORE_ERROR };
  try {
    const scope = await ServiceLineAccess.activeFor(viewer);
    const { project, target } = await ProjectService.restoreFromCancelled(projectId, viewer, undefined, scope);
    for (const path of ["/", "/completed", "/cancelled", "/admin/audit"]) revalidatePath(path);
    return { ok: true, name: project.name, statusLabel: ProjectStatusInfo.label(target.status) };
  } catch (e) {
    console.error("Restore to active failed", e);
    return { ok: false, error: ClosedPagesCopy.RESTORE_ERROR };
  }
}
