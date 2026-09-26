"use server";

import { revalidatePath } from "next/cache";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ProjectService } from "@/lib/services/ProjectService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";

export type AdminActionResult = { ok: true } | { ok: false; error: string };

/**
 * Admin-only mutations. Server Actions are reachable by direct POST, so every action resolves
 * the viewer from the session and re-checks ADMIN_EMAILS itself (the services check again).
 */
class AdminAction {
  static async run(label: string, fn: (admin: Viewer) => Promise<unknown>): Promise<AdminActionResult> {
    const viewer = await CurrentViewer.get();
    if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
    try {
      AdminPolicy.assertAdmin(viewer);
      await fn(viewer);
      revalidatePath("/");
      revalidatePath("/admin/audit");
      return { ok: true };
    } catch (e) {
      console.error(`Admin action failed: ${label}`, e);
      return { ok: false, error: "Could not save the change." };
    }
  }
}

export async function saveViewSettings(context: string, value: unknown): Promise<AdminActionResult> {
  if (!ViewSettings.isContext(context)) return { ok: false, error: "Unknown view." };
  return AdminAction.run("saveViewSettings", (admin) => ViewSettingsService.update(context, value, { changedBy: admin.email }));
}

export async function setProjectHidden(projectId: string, context: string, hidden: boolean): Promise<AdminActionResult> {
  if (!ViewSettings.isContext(context)) return { ok: false, error: "Unknown view." };
  return AdminAction.run("setProjectHidden", (admin) => ProjectService.setHidden(projectId, context, Boolean(hidden), admin));
}

export async function deleteProject(projectId: string): Promise<AdminActionResult> {
  return AdminAction.run("deleteProject", (admin) => ProjectService.softDelete(projectId, admin));
}

export async function restoreProject(projectId: string): Promise<AdminActionResult> {
  return AdminAction.run("restoreProject", (admin) => ProjectService.restore(projectId, admin));
}

/** Form wrapper for the audit page (fields: projectId). */
export async function restoreProjectForm(formData: FormData): Promise<void> {
  await restoreProject(String(formData.get("projectId") ?? ""));
}

/** Form wrapper for the audit page (fields: projectId, context). */
export async function unhideProjectForm(formData: FormData): Promise<void> {
  await setProjectHidden(String(formData.get("projectId") ?? ""), String(formData.get("context") ?? ""), false);
}
