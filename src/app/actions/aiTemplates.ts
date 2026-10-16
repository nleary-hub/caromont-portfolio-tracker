"use server";

import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiTemplateCopy } from "@/lib/ai/AiTemplateCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiTemplateService, type AiTemplateApplyResult, type AiTemplateProposeResult } from "@/lib/services/AiTemplateService";
import type { AiToolsDb } from "@/lib/services/AiToolsService";
import { MilestoneTemplateService } from "@/lib/services/MilestoneTemplateService";

/**
 * Server Functions of the Template AI assistant. Each resolves the admin and the active line from the session (they are
 * reachable by direct POST). Propose saves nothing. Apply writes only through MilestoneTemplateService.
 */
async function context() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin || !Db.isConfigured()) return null;
  return { viewer, scope: await ServiceLineAccess.activeFor(viewer), db: Db.client as unknown as AiToolsDb };
}

export async function proposeAiTemplate(mode: string, input: string, templateId: string | null = null): Promise<AiTemplateProposeResult> {
  try {
    const c = await context();
    if (!c || (mode !== "draft" && mode !== "edit")) return { ok: false, kind: "denied", message: AiCopy.NOT_AUTHORIZED };
    const current = mode === "edit" ? ((await MilestoneTemplateService.list(undefined, c.scope)).find((t) => t.id === String(templateId)) ?? null) : null;
    return await AiTemplateService.propose({ db: c.db, viewer: c.viewer, mode, input, current });
  } catch (e) {
    console.error("Template AI failed: propose", (e as Error)?.name);
    return { ok: false, kind: "provider", message: AiToolsCopy.PROVIDER_ERROR };
  }
}

export async function applyAiTemplate(proposalId: string, templateId: string | null, desired: unknown): Promise<AiTemplateApplyResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiTemplateService.apply({ db: c.db, templateDb: Db.client, viewer: c.viewer, scope: c.scope, proposalId, templateId: templateId === null ? null : String(templateId), desired });
    if (r.ok) {
      revalidatePath("/admin/templates");
      revalidatePath("/");
    }
    return r;
  } catch (e) {
    console.error("Template AI failed: apply", (e as Error)?.name);
    return { ok: false, message: AiTemplateCopy.APPLY_FAILED };
  }
}

export async function discardAiTemplate(proposalId: string): Promise<{ ok: boolean }> {
  try {
    const c = await context();
    if (!c) return { ok: false };
    return await AiTemplateService.discard(c.db, c.viewer, proposalId);
  } catch {
    return { ok: false };
  }
}
