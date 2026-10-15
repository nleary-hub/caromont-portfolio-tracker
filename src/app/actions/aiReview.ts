"use server";

import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiInputs } from "@/lib/ai/AiInput";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiReviewApplyService, type AiDecisionResult, type AiProposeResult } from "@/lib/services/AiReviewApplyService";
import type { AiWritingDb } from "@/lib/services/AiWritingService";

/**
 * Server Functions of the review-then-apply layer. Each resolves the viewer and the active line from the session
 * (they are reachable by direct POST). None of them writes to a project: Apply fills the form draft only.
 */
async function context() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin || !Db.isConfigured()) return null;
  return { viewer, scope: await ServiceLineAccess.activeFor(viewer), db: Db.client as unknown as AiWritingDb };
}

export async function proposeAiChange(projectId: string | null, feature: string, current: string, input: unknown): Promise<AiProposeResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, kind: "denied", message: AiCopy.NOT_AUTHORIZED };
    return await AiReviewApplyService.propose({ ...c, projectId: projectId === null ? null : String(projectId), feature, current, input: AiInputs.parse(input) });
  } catch (e) {
    console.error("AI review layer failed: propose", (e as Error)?.name);
    return { ok: false, kind: "provider", message: AiCopy.PROVIDER_ERROR };
  }
}

export async function applyAiChange(proposalId: string, appliedText: string): Promise<AiDecisionResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiReviewApplyService.apply(c.db, c.viewer, c.scope, proposalId, appliedText);
  } catch (e) {
    console.error("AI review layer failed: apply", (e as Error)?.name);
    return { ok: false, message: AiCopy.APPLY_FAILED };
  }
}

export async function rejectAiChange(proposalId: string): Promise<AiDecisionResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiReviewApplyService.reject(c.db, c.viewer, c.scope, proposalId);
  } catch {
    return { ok: false, message: AiCopy.APPLY_FAILED };
  }
}

export async function undoAiChange(proposalId: string): Promise<AiDecisionResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiReviewApplyService.undo(c.db, c.viewer, c.scope, proposalId);
  } catch {
    return { ok: false, message: AiCopy.APPLY_FAILED };
  }
}
