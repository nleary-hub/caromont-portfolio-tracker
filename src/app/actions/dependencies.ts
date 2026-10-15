"use server";

import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { DependencyAccessError, DependencyRuleError, ProjectDependencyService, type DependencyView } from "@/lib/services/ProjectDependencyService";

export type DependencyActionResult = { ok: true; view: DependencyView } | { ok: false; error: string };

/**
 * Drawer Dependencies section. Server Actions are reachable by direct POST, so each one resolves the viewer and the
 * active line itself; the service checks edit access again. A project or blocker out of reach gets the generic answer.
 */
class DependencyAction {
  static async run(label: string, projectId: string, fn?: (s: { viewer: NonNullable<Awaited<ReturnType<typeof CurrentViewer.get>>>; scope: Awaited<ReturnType<typeof ServiceLineAccess.activeFor>> }) => Promise<void>): Promise<DependencyActionResult> {
    const viewer = await CurrentViewer.get();
    if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
    try {
      const scope = await ServiceLineAccess.activeFor(viewer);
      if (fn) {
        await fn({ viewer, scope });
        revalidatePath("/");
      }
      return { ok: true, view: await ProjectDependencyService.view(viewer, scope, String(projectId)) };
    } catch (e) {
      if (e instanceof DependencyRuleError) return { ok: false, error: e.message };
      if (e instanceof DependencyAccessError) return { ok: false, error: "This project was deleted or no longer exists." };
      console.error(`Dependency action failed: ${label}`, e);
      return { ok: false, error: "Could not save the change." };
    }
  }
}

export async function loadProjectDependencies(projectId: string): Promise<DependencyActionResult> {
  return DependencyAction.run("load", projectId);
}

export async function addProjectDependency(projectId: string, blockedById: string): Promise<DependencyActionResult> {
  return DependencyAction.run("add", projectId, ({ viewer, scope }) => ProjectDependencyService.addLocked(viewer, scope, String(projectId), String(blockedById)));
}

export async function removeProjectDependency(projectId: string, blockedById: string): Promise<DependencyActionResult> {
  return DependencyAction.run("remove", projectId, ({ viewer, scope }) => ProjectDependencyService.remove(viewer, scope, String(projectId), String(blockedById)));
}
