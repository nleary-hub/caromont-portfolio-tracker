"use server";

import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { DependencyCopy } from "@/lib/projects/DependencyCopy";
import {
  BlockerInputError,
  DependencyAccessError,
  DependencyRuleError,
  ProjectDependencyService,
  type BlockerInput,
  type DependencyInput,
  type DependencyView,
} from "@/lib/services/ProjectDependencyService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/** `kind`: "rule" = a rejected edge (cycle, duplicate, self: the project picker gets the red ring); "input" = a refused value. */
export type DependencyActionResult = { ok: true; view: DependencyView } | { ok: false; error: string; kind?: "rule" | "input" | "access" | "save" };

type Viewer = NonNullable<Awaited<ReturnType<typeof CurrentViewer.get>>>;
type Scope = Awaited<ReturnType<typeof ServiceLineAccess.activeFor>>;

/**
 * Drawer "Dependencies & blockers" section. Server Actions are reachable by direct POST, so each one resolves the
 * viewer and the active line itself; the service checks edit access again (admins of the line only). Loading is also
 * open read-only to a signed-in viewer who may open the project (same rule as History). A project or blocker out of
 * reach gets the generic answer; anything unexpected gets the save error.
 */
class DependencyAction {
  static async run(label: string, projectId: string, fn?: (s: { viewer: Viewer; scope: Scope }) => Promise<unknown>): Promise<DependencyActionResult> {
    const viewer = await CurrentViewer.get();
    if (!viewer) return { ok: false, error: "Not authorized.", kind: "access" };
    if (fn && !viewer.isAdmin) return { ok: false, error: "Not authorized.", kind: "access" };
    try {
      const scope = await ServiceLineAccess.activeFor(viewer);
      if (fn) {
        await fn({ viewer, scope });
        revalidatePath("/");
      }
      return { ok: true, view: await ProjectDependencyService.view(viewer, scope, String(projectId), Db.client, { readOnly: await DependencyAction.mayOpen(viewer, String(projectId)) }) };
    } catch (e) {
      if (e instanceof DependencyRuleError) return { ok: false, error: e.message, kind: "rule" };
      if (e instanceof BlockerInputError) return { ok: false, error: e.message, kind: "input" };
      if (e instanceof DependencyAccessError) return { ok: false, error: "This project was deleted or no longer exists.", kind: "access" };
      console.error(`Dependency action failed: ${label}`, e);
      return { ok: false, error: fn ? DependencyCopy.SAVE_ERROR : DependencyCopy.LOAD_ERROR, kind: "save" };
    }
  }

  /** Admins are checked by the service (edit rule). Others: the project must be one they can open on the dashboard. */
  private static async mayOpen(viewer: Viewer, projectId: string): Promise<boolean> {
    if (viewer.isAdmin) return false;
    const p = await Db.client.project.findUnique({ where: { id: projectId } });
    if (!p) return false;
    return VisibilityPolicy.isViewable(p, await ViewSettingsService.get("dashboard", Db.client));
  }
}

export async function loadProjectDependencies(projectId: string): Promise<DependencyActionResult> {
  return DependencyAction.run("load", projectId);
}

export async function addProjectDependency(projectId: string, blockedById: string, input: DependencyInput = {}): Promise<DependencyActionResult> {
  return DependencyAction.run("add", projectId, ({ viewer, scope }) => ProjectDependencyService.addDependency(viewer, scope, String(projectId), String(blockedById), input));
}

export async function updateProjectDependency(projectId: string, blockedById: string, input: DependencyInput): Promise<DependencyActionResult> {
  return DependencyAction.run("update", projectId, ({ viewer, scope }) => ProjectDependencyService.updateDependency(viewer, scope, String(projectId), String(blockedById), input));
}

/**
 * Soft-remove "projectId is blocked by blockedById". `viewFor` is the drawer's project (a Blocking row removes the
 * edge stored on the other project, then reloads this drawer).
 */
export async function removeProjectDependency(projectId: string, blockedById: string, viewFor?: string): Promise<DependencyActionResult> {
  return DependencyAction.run("remove", viewFor ?? projectId, ({ viewer, scope }) => ProjectDependencyService.removeDependency(viewer, scope, String(projectId), String(blockedById)));
}

export async function addProjectBlocker(projectId: string, input: BlockerInput): Promise<DependencyActionResult> {
  return DependencyAction.run("addBlocker", projectId, ({ viewer, scope }) => ProjectDependencyService.addBlocker(viewer, scope, String(projectId), input));
}

export async function updateProjectBlocker(projectId: string, blockerId: string, input: BlockerInput): Promise<DependencyActionResult> {
  return DependencyAction.run("updateBlocker", projectId, ({ viewer, scope }) => ProjectDependencyService.updateBlocker(viewer, scope, String(projectId), String(blockerId), input));
}

export async function resolveProjectBlocker(projectId: string, blockerId: string, resolution: string): Promise<DependencyActionResult> {
  return DependencyAction.run("resolveBlocker", projectId, ({ viewer, scope }) => ProjectDependencyService.resolveBlocker(viewer, scope, String(projectId), String(blockerId), resolution));
}

/** Completion banner "Clear": removes a dependency whose blocker is Complete (history says it was cleared). */
export async function clearCompletedDependency(projectId: string, blockedById: string): Promise<DependencyActionResult> {
  return DependencyAction.run("clearCompleted", projectId, ({ viewer, scope }) => ProjectDependencyService.clearCompleted(viewer, scope, String(projectId), String(blockedById)));
}

/** Completion banner "Dismiss": per person, until the pair is added again. */
export async function dismissCompletionPrompt(projectId: string, blockedById: string): Promise<DependencyActionResult> {
  return DependencyAction.run("dismissPrompt", projectId, ({ viewer, scope }) => ProjectDependencyService.dismissPrompt(viewer, scope, String(projectId), String(blockedById)));
}
