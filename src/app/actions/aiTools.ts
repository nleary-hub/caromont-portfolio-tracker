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
      save: async (id, patch, meta) => {
        await ProjectService.update(id, patch as Partial<ProjectInput>, { changedBy: c.viewer.email, comment: meta.comment }, Db.client, c.scope);
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

/** Step 6: dictation. FormData with one "audio" file. Returns text for the person to read; saves nothing. */
export async function transcribeAiDictation(form: FormData): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiToolsService.transcribe({ db: c.db, viewer: c.viewer, audio: form.get("audio") });
  } catch (e) {
    console.error("AI tools failed: transcribe", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.DICTATION_FAILED };
  }
}

/** Step 7: Request to draft project. Saves nothing. */
export async function proposeAiProjectDraft(input: string) {
  try {
    const c = await context();
    if (!c) return { ok: false as const, kind: "denied" as const, message: AiCopy.NOT_AUTHORIZED };
    return await AiToolsService.proposeDraft({ db: c.db, viewer: c.viewer, input });
  } catch (e) {
    console.error("AI tools failed: draft", (e as Error)?.name);
    return { ok: false as const, kind: "provider" as const, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

/** Step 7: Create project from the reviewed draft, through ProjectService.create (validation and the created history row). */
export async function createAiProjectDraft(proposalId: string, draft: unknown): Promise<AiToolLineResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiToolsService.applyDraft({
      db: c.db,
      viewer: c.viewer,
      proposalId,
      draft,
      create: async (input) => (await ProjectService.create(input as unknown as ProjectInput, { changedBy: c.viewer.email, comment: null }, Db.client, c.scope)).id,
    });
    if (r.ok) revalidatePath("/");
    return r;
  } catch (e) {
    console.error("AI tools failed: create", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.APPLY_FAILED };
  }
}

/** Step 8: the pre-meeting brief. Shown in the app only; never emailed or saved. */
export async function makeAiMeetingBrief(focus: string) {
  try {
    const c = await context();
    if (!c) return { ok: false as const, kind: "denied" as const, message: AiCopy.NOT_AUTHORIZED };
    return await AiToolsService.proposeBrief({ ...c, input: focus });
  } catch (e) {
    console.error("AI tools failed: brief", (e as Error)?.name);
    return { ok: false as const, kind: "provider" as const, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

/** Step 9: suggested related-project links. Saves nothing. */
export async function proposeAiRelatedLinks(focus: string) {
  try {
    const c = await context();
    if (!c) return { ok: false as const, kind: "denied" as const, message: AiCopy.NOT_AUTHORIZED };
    return await AiToolsService.proposeLinks({ ...c, input: focus });
  } catch (e) {
    console.error("AI tools failed: links", (e as Error)?.name);
    return { ok: false as const, kind: "provider" as const, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

export async function confirmAiRelatedLink(proposalId: string, line: number, aId: string, bId: string, reason: string): Promise<AiToolLineResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiToolsService.applyLink({ ...c, proposalId, line, aId, bId, reason });
    if (r.ok) revalidatePath("/ai-tools");
    return r;
  } catch (e) {
    console.error("AI tools failed: link", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.APPLY_FAILED };
  }
}

export async function removeRelatedLink(id: string): Promise<AiToolLineResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiToolsService.removeLink(c.db, c.viewer, c.scope, id);
    if (r.ok) revalidatePath("/ai-tools");
    return r;
  } catch {
    return { ok: false, message: AiToolsCopy.APPLY_FAILED };
  }
}
