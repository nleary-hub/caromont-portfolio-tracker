"use server";

import { revalidatePath } from "next/cache";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ProjectFormModel, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";
import { ProjectPeopleForms } from "@/lib/services/ProjectPeopleForms";
import { ProjectArchivedError, ProjectNotFoundError, ProjectService, type MilestoneEdit } from "@/lib/services/ProjectService";
import { MilestoneService, type MilestoneStepDto } from "@/lib/services/MilestoneService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { LineLayoutService } from "@/lib/services/LineLayoutService";
import { ProjectValidationError, type FieldErrors } from "@/lib/validation/ProjectValidator";
import { Db } from "@/lib/db/Db";
import { AiWritingService, type AiWritingDb } from "@/lib/services/AiWritingService";

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
export async function saveProjectForm(projectId: string, changes: Partial<ProjectFormValues>, milestones?: unknown, meta?: unknown): Promise<ProjectFormResult> {
  return ProjectFormAction.run("saveProjectForm", async (admin, scope) => {
    const values = ProjectFormAction.values(changes);
    // AI-assisted tag on the note row: only when the note is in this save and this admin really used that suggestion.
    const suggestionId = meta && typeof meta === "object" ? (meta as { aiSuggestionId?: unknown }).aiSuggestionId : undefined;
    const aiAssisted = values.note !== undefined && suggestionId !== undefined && (await AiWritingService.wasUsed(Db.client as unknown as AiWritingDb, admin, String(projectId), suggestionId));
    return ProjectService.saveForm(
      String(projectId),
      ProjectFormModel.toInput(values),
      admin,
      undefined,
      ProjectFormAction.milestones(milestones),
      scope,
      { aiAssisted },
    );
  });
}

/** Drawer Milestones autosave: one checklist change, saved immediately. Returns the stored steps. */
export async function saveProjectMilestones(projectId: string, milestones: unknown): Promise<MilestoneSaveActionResult> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
  const edit = ProjectFormAction.milestones(milestones);
  if (!edit) return { ok: false, error: "Nothing to save." };
  try {
    const scope = await ServiceLineAccess.activeFor(viewer);
    const steps = await ProjectService.saveMilestones(String(projectId), edit, viewer, undefined, scope);
    revalidatePath("/");
    revalidatePath("/admin/audit");
    const people = ServiceLine.peopleNames(scope);
    return { ok: true, steps: steps.map((s) => MilestoneService.toDto(s, people)) };
  } catch (e) {
    if (e instanceof ProjectValidationError) return { ok: false, error: Object.values(e.errors).flat()[0] ?? "Invalid milestone." };
    if (e instanceof ProjectNotFoundError || e instanceof ProjectArchivedError) return { ok: false, error: "This project was deleted or no longer exists." };
    console.error("Admin action failed: saveProjectMilestones", e);
    return { ok: false, error: "Could not save the change." };
  }
}

export type MilestoneSaveActionResult = { ok: true; steps: MilestoneStepDto[] } | { ok: false; error: string };

/** Create a project from the New project drawer (name and department required), with its checklist. */
export async function createProjectFromForm(values: Partial<ProjectFormValues>, milestones?: unknown, meta?: unknown): Promise<ProjectFormResult> {
  return ProjectFormAction.run("createProjectFromForm", async (admin, scope) => {
    const parsed = ProjectFormAction.values(values);
    // AI-assisted: a note drafted in this New project form with a suggestion this admin accepted (null project).
    const suggestionId = meta && typeof meta === "object" ? (meta as { aiSuggestionId?: unknown }).aiSuggestionId : undefined;
    const aiAssisted = Boolean(parsed.note) && suggestionId !== undefined && (await AiWritingService.wasUsed(Db.client as unknown as AiWritingDb, admin, null, suggestionId));
    return ProjectService.createFromForm(ProjectFormModel.toInput(parsed), admin, undefined, ProjectFormAction.milestones(milestones), scope, { aiAssisted });
  });
}

export async function saveViewSettings(context: string, value: unknown): Promise<AdminActionResult> {
  if (!ViewSettings.isContext(context)) return { ok: false, error: "Unknown view." };
  // View settings are shared by every service line.
  return AdminAction.run("saveViewSettings", (admin) => ViewSettingsService.update(context, value, { changedBy: admin.email }));
}

/** Line layout (active line): column order and width shares; null resets the columns. */
export async function saveColumnLayout(columns: unknown): Promise<AdminActionResult> {
  return AdminAction.run("saveColumnLayout", (admin, scope) => LineLayoutService.setColumns(columns ?? null, admin, undefined, scope));
}

/** Line layout (active line): one department's manual row order. */
export async function saveRowOrder(area: string, ids: unknown): Promise<AdminActionResult> {
  return AdminAction.run("saveRowOrder", (admin, scope) => LineLayoutService.setRowOrder(String(area), ids, admin, undefined, scope));
}

/** Line layout (active line): back to the report order in every department. */
export async function resetRowOrder(): Promise<AdminActionResult> {
  return AdminAction.run("resetRowOrder", (admin, scope) => LineLayoutService.resetRows(admin, undefined, scope));
}

export async function setProjectHidden(projectId: string, context: string, hidden: boolean): Promise<AdminActionResult> {
  if (!ViewSettings.isContext(context)) return { ok: false, error: "Unknown view." };
  return AdminAction.run("setProjectHidden", (admin, scope) => ProjectService.setHidden(projectId, context, Boolean(hidden), admin, undefined, scope));
}

export async function setProjectPeopleField(projectId: string, field: string, value: string): Promise<AdminActionResult> {
  const result = await ProjectPeopleForms.setField(await CurrentViewer.get(), projectId, field, value);
  if (result.ok) revalidatePath("/");
  return result;
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
