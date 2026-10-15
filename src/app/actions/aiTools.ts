"use server";

import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiToolsService, type AiToolLineResult, type AiToolProposeResult, type AiToolsDb } from "@/lib/services/AiToolsService";
import { ProjectService } from "@/lib/services/ProjectService";
import type { ProjectInput } from "@/lib/validation/ProjectValidator";

/**
 * Server Functions of the AI tools page. Each resolves the viewer and the active line from the session (they are
 * reachable by direct POST). Propose saves nothing. Apply saves one line through ProjectService.update.
 */
async function context() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin || !Db.isConfigured()) return null;
  return { viewer, scope: await ServiceLineAccess.activeFor(viewer), db: Db.client as unknown as AiToolsDb };
}

export async function proposeAiToolChanges(feature: string, input: string, projectId: string | null = null): Promise<AiToolProposeResult> {
  try {
    const c = await context();
    const f = AiFeatureFlags.parseToolFeature(feature);
    if (!c || !f) return { ok: false, kind: "denied", message: AiCopy.NOT_AUTHORIZED };
    return await AiToolsService.proposeChanges({ ...c, feature: f, input, projectId: projectId === null ? null : String(projectId) });
  } catch (e) {
    console.error("AI tools failed: propose", (e as Error)?.name);
    return { ok: false, kind: "provider", message: AiToolsCopy.PROVIDER_ERROR };
  }
}

export async function applyAiToolLine(proposalId: string, line: number, projectId: string, field: string, value: string): Promise<AiToolLineResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiToolsService.applyLine({
      db: c.db,
      viewer: c.viewer,
      proposalId,
      line,
      projectId,
      field,
      value,
      save: async (id, patch) => {
        await ProjectService.update(id, patch as Partial<ProjectInput>, { changedBy: c.viewer.email, comment: null }, Db.client, c.scope);
      },
    });
    if (r.ok) revalidatePath("/");
    return r;
  } catch (e) {
    console.error("AI tools failed: apply", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.APPLY_FAILED };
  }
}

export async function rejectAiToolLine(proposalId: string, line: number): Promise<AiToolLineResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiToolsService.rejectLine(c.db, c.viewer, proposalId, line);
  } catch {
    return { ok: false, message: AiToolsCopy.APPLY_FAILED };
  }
}
