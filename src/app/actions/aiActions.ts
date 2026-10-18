"use server";

import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiActionPortsLive } from "@/lib/services/AiActionPortsLive";
import { AiActionService, type AiActionDb, type AiActionSource, type AiApplyResult, type AiProposeResult, type AiUndoResult } from "@/lib/services/AiActionService";
import { AiToolsService } from "@/lib/services/AiToolsService";

/**
 * Item B: Server Functions of the shared AI action layer. Each resolves the viewer and the active line from the session
 * (reachable by direct POST), re-checks admin, and applies only lines stored with the proposal. Every write goes
 * through the normal project services (AiActionPortsLive).
 */
async function context() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin || !Db.isConfigured()) return null;
  const scope = await ServiceLineAccess.activeFor(viewer);
  const db = Db.client as unknown as AiActionDb;
  return { viewer, scope, db, projects: await AiToolsService.projects(db, scope), ports: AiActionPortsLive.of(viewer, scope) };
}

function source(raw: unknown): AiActionSource | null {
  return raw === "command" ? "command" : AiFeatureFlags.parseReviewableTool(raw);
}

/** The command bar runs as Quick capture (its toggle and usage rows); its history tag says "command". */
function featureOf(s: AiActionSource) {
  return s === "command" ? ("quick_capture" as const) : s;
}

function refresh() {
  revalidatePath("/");
  revalidatePath("/admin/audit");
}

/** One tool call (voice chat in the browser, the command bar). Returns the model's tool output and what the screen needs. */
export async function runAiActionTool(from: string, name: string, args: string) {
  try {
    const c = await context();
    const s = source(from);
    if (!c || !s) return { output: JSON.stringify({ ok: false, error: AiCopy.NOT_AUTHORIZED }) };
    const r = await AiActionService.runTool({ ...c, name, args: String(args ?? "").slice(0, AiToolsService.INPUT_MAX), feature: featureOf(s), source: s });
    if (r.changed) refresh();
    return r;
  } catch (e) {
    console.error("AI actions failed: tool", (e as Error)?.name);
    return { output: JSON.stringify({ ok: false, error: AiToolsCopy.APPLY_FAILED }) };
  }
}

export async function proposeAiActions(from: string, changes: unknown): Promise<AiProposeResult> {
  try {
    const c = await context();
    const s = source(from);
    if (!c || !s) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiActionService.propose({ ...c, feature: featureOf(s), changes });
  } catch (e) {
    console.error("AI actions failed: propose", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PARSE_FAILED };
  }
}

/** Apply all (lines = "all") or chosen lines of one proposal, after the person confirmed. */
export async function applyAiActions(proposalId: string, lines: number[] | "all", from: string | null = null): Promise<AiApplyResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiActionService.apply({ ...c, proposalId, lines, source: source(from) ?? undefined });
    if (r.ok && r.applied.length) refresh();
    return r;
  } catch (e) {
    console.error("AI actions failed: apply", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.APPLY_FAILED };
  }
}

export async function rejectAiActions(proposalId: string, lines: number[] | "all") {
  try {
    const c = await context();
    if (!c) return { ok: false as const, message: AiCopy.NOT_AUTHORIZED };
    return await AiActionService.reject({ ...c, proposalId, lines });
  } catch {
    return { ok: false as const, message: AiToolsCopy.APPLY_FAILED };
  }
}

export async function undoLastAiApply(): Promise<AiUndoResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiActionService.undoLast(c);
    if (r.ok && r.undone.length) refresh();
    return r;
  } catch (e) {
    console.error("AI actions failed: undo", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.APPLY_FAILED };
  }
}
