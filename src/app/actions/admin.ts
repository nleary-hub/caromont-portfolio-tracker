"use server";

import { revalidatePath } from "next/cache";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ProjectFormModel, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";
import { ProjectArchivedError, ProjectNotFoundError, ProjectService, type MilestoneEdit } from "@/lib/services/ProjectService";
import { MilestoneService, type MilestoneStepDto } from "@/lib/services/MilestoneService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { ProjectValidationError, type FieldErrors } from "@/lib/validation/ProjectValidator";

export type AdminActionResult = { ok: true } | { ok: false; error: string };

/**
 * Admin-only mutations. Server Actions are reachable by direct POST, so every action resolves
 * the viewer from the session and re-checks ADMIN_EMAILS itself (the services check again).
 * Project actions run in the viewer's active service line: a project of another line is "not found".
 */
class AdminAction {
  static async run(label: string, fn: (admin: Viewer, scope: ServiceLineScope) => Promise<unknown>): Promise<AdminActionResult> {
    const viewer = await CurrentViewer.get();
    if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
    try {
      AdminPolicy.assertAdmin(viewer);
      await fn(viewer, await ServiceLineAccess.activeFor(viewer));
      revalidatePath("/");
      revalidatePath("/admin/audit");
      return { ok: true };
    } catch (e) {
      console.error(`Admin action failed: ${label}`, e);
      return { ok: false, error: "Could not save the change." };
    }
  }
}

/** Result of an edit form save or create: the project id, or a message plus per-field errors. */
export type ProjectFormResult = { ok: true; id: string } | { ok: false; error: string; fieldErrors?: FieldErrors };

/**
 * Drawer edit form and New project. Admin is re-checked here and again in ProjectService; every value
 * goes through ProjectValidator (form rules) on the server, and its field errors go back to the form.
 */
class ProjectFormAction {
  static async run(label: string, fn: (admin: Viewer, scope: ServiceLineScope) => Promise<{ id: string }>): Promise<ProjectFormResult> {
    const viewer = await CurrentViewer.get();
    if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
    try {
      const project = await fn(viewer, await ServiceLineAccess.activeFor(viewer));
      revalidatePath("/");
      revalidatePath("/admin/audit");
      return { ok: true, id: project.id };
    } catch (e) {
      if (e instanceof ProjectValidationError) return { ok: false, error: "Fix the highlighted fields.", fieldErrors: e.errors };
      if (e instanceof ProjectNotFoundError || e instanceof ProjectArchivedError) return { ok: false, error: "This project was deleted or no longer exists." };
      console.error(`Admin action failed: ${label}`, e);
      return { ok: false, error: "Could not save the change." };
    }
  }

  /** The drawer's checklist (drafts in order, plus the template applied in this edit), sanitized. Null = untouched. */
  static milestones(raw: unknown): MilestoneEdit | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as { drafts?: unknown; applied?: unknown };
    if (!Array.isArray(r.drafts)) return null;
    const a = (r.applied && typeof r.applied === "object" ? r.applied : null) as Record<string, unknown> | null;
    const applied =
      a && typeof a.templateId === "string" && typeof a.templateName === "string" && (a.mode === "replace" || a.mode === "append")
        ? { templateId: a.templateId, templateName: a.templateName.slice(0, 200), mode: a.mode as "replace" | "append" }
        : null;
    return { drafts: MilestoneRules.drafts(r.drafts), applied };
  }

  /** Only form fields, as strings (anything else in the payload is dropped). */
  static values(raw: unknown): Partial<ProjectFormValues> {
    const out: Partial<ProjectFormValues> = {};
    if (!raw || typeof raw !== "object") return out;
    for (const key of Object.keys(ProjectFormModel.empty()) as (keyof ProjectFormValues)[]) {
      const v = (raw as Record<string, unknown>)[key];
      if (v !== undefined && v !== null) out[key] = String(v);
    }
    return out;
  }
}

/**
 * Save the changed non-People fields of a project together with its checklist (one history entry).
 * `milestones` is omitted when the checklist was not touched.
 */
export async function saveProjectForm(projectId: string, changes: Partial<ProjectFormValues>, milestones?: unknown): Promise<ProjectFormResult> {
  return ProjectFormAction.run("saveProjectForm", (admin, scope) =>
    ProjectService.saveForm(
      String(projectId),
      ProjectFormModel.toInput(ProjectFormAction.values(changes)),
      admin,
      undefined,
      ProjectFormAction.milestones(milestones),
      scope,
    ),
  );
}

/** Drawer Milestones autosave: one checklist change, saved immediately. Returns the stored steps. */
export async function saveProjectMilestones(projectId: string, milestones: unknown): Promise<MilestoneSaveActionResult> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
  const edit = ProjectFormAction.milestones(milestones);
  if (!edit) return { ok: false, error: "Nothing to save." };
  try {
    const steps = await ProjectService.saveMilestones(String(projectId), edit, viewer, undefined, await ServiceLineAccess.activeFor(viewer));
    revalidatePath("/");
    revalidatePath("/admin/audit");
    return { ok: true, steps: steps.map((s) => MilestoneService.toDto(s)) };
  } catch (e) {
    if (e instanceof ProjectValidationError) return { ok: false, error: Object.values(e.errors).flat()[0] ?? "Invalid milestone." };
    if (e instanceof ProjectNotFoundError || e instanceof ProjectArchivedError) return { ok: false, error: "This project was deleted or no longer exists." };
    console.error("Admin action failed: saveProjectMilestones", e);
    return { ok: false, error: "Could not save the change." };
  }
}

export type MilestoneSaveActionResult = { ok: true; steps: MilestoneStepDto[] } | { ok: false; error: string };

/** Create a project from the New project drawer (name and department required), with its checklist. */
export async function createProjectFromForm(values: Partial<ProjectFormValues>, milestones?: unknown): Promise<ProjectFormResult> {
  return ProjectFormAction.run("createProjectFromForm", (admin, scope) =>
    ProjectService.createFromForm(ProjectFormModel.toInput(ProjectFormAction.values(values)), admin, undefined, ProjectFormAction.milestones(milestones), scope),
  );
}

export async function saveViewSettings(context: string, value: unknown): Promise<AdminActionResult> {
  if (!ViewSettings.isContext(context)) return { ok: false, error: "Unknown view." };
  // View settings are shared by every service line.
  return AdminAction.run("saveViewSettings", (admin) => ViewSettingsService.update(context, value, { changedBy: admin.email }));
}

export async function setProjectHidden(projectId: string, context: string, hidden: boolean): Promise<AdminActionResult> {
  if (!ViewSettings.isContext(context)) return { ok: false, error: "Unknown view." };
  return AdminAction.run("setProjectHidden", (admin, scope) => ProjectService.setHidden(projectId, context, Boolean(hidden), admin, undefined, scope));
}

export async function setProjectPeopleField(projectId: string, field: string, value: string): Promise<AdminActionResult> {
  if (!ProjectService.isPeopleField(field)) return { ok: false, error: "Unknown field." };
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
  try {
    await ProjectService.setPeopleField(projectId, field, String(value ?? ""), viewer, undefined, await ServiceLineAccess.activeFor(viewer));
  } catch (e) {
    if (e instanceof ProjectValidationError) return { ok: false, error: Object.values(e.errors).flat()[0] ?? "Invalid value." };
    console.error("Admin action failed: setProjectPeopleField", e);
    return { ok: false, error: "Could not save the change." };
  }
  revalidatePath("/");
  return { ok: true };
}

export async function deleteProject(projectId: string): Promise<AdminActionResult> {
  return AdminAction.run("deleteProject", (admin, scope) => ProjectService.softDelete(projectId, admin, undefined, undefined, scope));
}

export async function restoreProject(projectId: string): Promise<AdminActionResult> {
  return AdminAction.run("restoreProject", (admin, scope) => ProjectService.restore(projectId, admin, undefined, undefined, scope));
}

/** Form wrapper for the audit page (fields: projectId). */
export async function restoreProjectForm(formData: FormData): Promise<void> {
  await restoreProject(String(formData.get("projectId") ?? ""));
}

/** Form wrapper for the audit page (fields: projectId, context). */
export async function unhideProjectForm(formData: FormData): Promise<void> {
  await setProjectHidden(String(formData.get("projectId") ?? ""), String(formData.get("context") ?? ""), false);
}
