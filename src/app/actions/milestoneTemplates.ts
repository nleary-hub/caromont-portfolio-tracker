"use server";

import { revalidatePath } from "next/cache";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { MilestoneTemplateService, TemplateNotFoundError, TemplateValidationError, type TemplateDto } from "@/lib/services/MilestoneTemplateService";

export type TemplateActionResult = { ok: true; templates: TemplateDto[]; createdId?: string } | { ok: false; error: string };

/**
 * Admin Templates page (autosave). Server Actions are reachable by direct POST, so each action resolves the
 * viewer and MilestoneTemplateService re-checks admin. Every change is audited in the service. The result
 * carries the fresh list so the page shows what was stored.
 */
class TemplateAction {
  static async run(label: string, fn: (admin: Viewer) => Promise<{ id: string } | void>): Promise<TemplateActionResult> {
    const viewer = await CurrentViewer.get();
    if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
    try {
      const created = await fn(viewer);
      revalidatePath("/admin/templates");
      revalidatePath("/");
      return { ok: true, templates: await MilestoneTemplateService.list(), ...(created ? { createdId: created.id } : {}) };
    } catch (e) {
      if (e instanceof TemplateValidationError) return { ok: false, error: e.message };
      if (e instanceof TemplateNotFoundError) return { ok: false, error: "This template was deleted. Reload the page." };
      console.error(`Template action failed: ${label}`, e);
      return { ok: false, error: "Could not save the change." };
    }
  }
}

export async function createTemplate(name: string): Promise<TemplateActionResult> {
  return TemplateAction.run("createTemplate", (admin) => MilestoneTemplateService.create(String(name ?? ""), admin));
}

export async function renameTemplate(id: string, name: string): Promise<TemplateActionResult> {
  return TemplateAction.run("renameTemplate", (admin) => MilestoneTemplateService.rename(String(id), String(name ?? ""), admin));
}

export async function deleteTemplate(id: string): Promise<TemplateActionResult> {
  return TemplateAction.run("deleteTemplate", (admin) => MilestoneTemplateService.remove(String(id), admin));
}

export async function reorderTemplates(ids: string[]): Promise<TemplateActionResult> {
  return TemplateAction.run("reorderTemplates", (admin) => MilestoneTemplateService.reorder((Array.isArray(ids) ? ids : []).map(String), admin));
}

export async function addTemplateItem(templateId: string, name: string): Promise<TemplateActionResult> {
  return TemplateAction.run("addTemplateItem", (admin) => MilestoneTemplateService.addItem(String(templateId), String(name ?? ""), admin));
}

export async function renameTemplateItem(itemId: string, name: string): Promise<TemplateActionResult> {
  return TemplateAction.run("renameTemplateItem", (admin) => MilestoneTemplateService.renameItem(String(itemId), String(name ?? ""), admin));
}

export async function deleteTemplateItem(itemId: string): Promise<TemplateActionResult> {
  return TemplateAction.run("deleteTemplateItem", (admin) => MilestoneTemplateService.removeItem(String(itemId), admin));
}

export async function reorderTemplateItems(templateId: string, itemIds: string[]): Promise<TemplateActionResult> {
  return TemplateAction.run("reorderTemplateItems", (admin) =>
    MilestoneTemplateService.reorderItems(String(templateId), (Array.isArray(itemIds) ? itemIds : []).map(String), admin),
  );
}
