"use server";

import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiPlaybookService, type AiPlaybookDb, type AiPlaybookResult } from "@/lib/services/AiPlaybookService";

/**
 * Meeting Playbook item: Server Functions. Each resolves the viewer and the active line from the session (reachable
 * by direct POST) and re-checks admin. Read-only for projects.
 */
export async function makeAiPlaybook(input: { meetingType: string; scope: unknown; length: number; focus: string }): Promise<AiPlaybookResult> {
  try {
    const viewer = await CurrentViewer.get();
    if (!viewer?.isAdmin || !Db.isConfigured()) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const scope = await ServiceLineAccess.activeFor(viewer);
    return await AiPlaybookService.generate({ db: Db.client as unknown as AiPlaybookDb, viewer, scope, meetingType: input?.meetingType, playbookScope: input?.scope, length: input?.length, focus: input?.focus });
  } catch (e) {
    console.error("AI playbook failed", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
  }
}
