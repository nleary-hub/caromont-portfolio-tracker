"use server";

import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import { AiActionPortsLive } from "@/lib/services/AiActionPortsLive";
import { AiActionService, type AiActionDb, type AiActionSource, type AiApplyResult, type AiProposeResult, type AiUndoResult } from "@/lib/services/AiActionService";
import { AiBulkEditService, type AiBulkEditResult } from "@/lib/services/AiBulkEditService";
import { AiCommandService, type AiCommandResult } from "@/lib/services/AiCommandService";
import { AiDependencySuggestService, type AiDependencySuggestResult } from "@/lib/services/AiDependencySuggestService";
import { AiMeetingNotesService, type AiMeetingNotesResult } from "@/lib/services/AiMeetingNotesService";
import { AiNextStepService, type AiNextStepResult } from "@/lib/services/AiNextStepService";
import { AiRequestDraftService, type AiRequestDraftResult } from "@/lib/services/AiRequestDraftService";
import { ProjectService } from "@/lib/services/ProjectService";
import type { ProjectInput } from "@/lib/validation/ProjectValidator";
import { AiToolsService } from "@/lib/services/AiToolsService";

/**
 * Item B: Server Functions of the shared AI action layer. Each resolves the viewer and the active line from the session
 * (reachable by direct POST), re-checks admin, and applies only lines stored with the proposal. Every write goes
 * through the normal project services (AiActionPortsLive).
 */
async function context() {
  const viewer = await OwnerGate.ownerViewer();
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

/** Voice and command bar item: one typed message to the command bar (the browser keeps the conversation). */
export async function runAiCommand(turns: unknown): Promise<AiCommandResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiCommandService.run({ ...c, turns });
    if (r.ok && r.changed) refresh();
    return r;
  } catch (e) {
    console.error("AI actions failed: command", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

/** Meeting notes item: rough notes to checked change lines, drafts for new projects, and the notes that matched nothing. */
export async function processAiMeetingNotes(notes: string, prefix: string | null = null): Promise<AiMeetingNotesResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiMeetingNotesService.process({ ...c, notes: String(notes ?? "").slice(0, AiToolsService.INPUT_MAX), prefix: typeof prefix === "string" ? prefix : null });
  } catch (e) {
    console.error("AI actions failed: meeting notes", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

/** Item 4: plain-English bulk edit (a filter and one change; the lines come back as one confirm card). */
export async function proposeAiBulkEdit(text: string, onlyIds: string[] | null = null): Promise<AiBulkEditResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const ids = Array.isArray(onlyIds) ? onlyIds.filter((x) => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500) : null;
    return await AiBulkEditService.propose({ ...c, input: String(text ?? "").slice(0, AiToolsService.INPUT_MAX), onlyIds: ids });
  } catch (e) {
    console.error("AI actions failed: bulk edit", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

/** Item 6: next-step suggestion for one project, from its milestone plan and template. */
export async function suggestAiNextStep(projectId: string): Promise<AiNextStepResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiNextStepService.suggest({ db: c.db, viewer: c.viewer, scope: c.scope, projectId });
  } catch (e) {
    console.error("AI actions failed: next step", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
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

/** Item 7: Request to draft project (template match, named people pre-filled, duplicate check). Saves nothing. */
export async function proposeAiRequestDraft(text: string): Promise<AiRequestDraftResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiRequestDraftService.propose({ db: c.db, viewer: c.viewer, scope: c.scope, input: String(text ?? "").slice(0, AiToolsService.INPUT_MAX) });
  } catch (e) {
    console.error("AI actions failed: request draft", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

/** Item 7: Create project from the reviewed request draft: the normal create plus the template's milestones, one transaction. */
export async function createAiRequestDraft(proposalId: string, draft: unknown) {
  try {
    const c = await context();
    if (!c) return { ok: false as const, message: AiCopy.NOT_AUTHORIZED };
    const r = await AiRequestDraftService.create({
      db: c.db,
      viewer: c.viewer,
      scope: c.scope,
      proposalId,
      draft,
      write: async (input, milestones) =>
        (await ProjectService.createWithMilestones(input as unknown as ProjectInput, milestones, { changedBy: c.viewer.email, comment: AiToolsService.historyComment("request_to_project") }, Db.client, c.scope)).id,
    });
    if (r.ok) refresh();
    return r;
  } catch (e) {
    console.error("AI actions failed: request create", (e as Error)?.name);
    return { ok: false as const, message: AiToolsCopy.APPLY_FAILED };
  }
}

/** Item 7: the request matches an existing project: turn it into change lines for that project only (meeting notes on one row). */
export async function updateFromAiRequest(projectId: string, text: string): Promise<AiMeetingNotesResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const projects = c.projects.filter((p) => p.id === projectId);
    if (!projects.length) return { ok: false, message: AiCopy.PROJECT_GONE };
    const r = await AiMeetingNotesService.process({ ...c, projects, notes: String(text ?? "").slice(0, AiToolsService.INPUT_MAX), prefix: AiToolsCopy.REQUEST_UPDATE_PREFIX });
    return r.ok ? { ...r, drafts: [] } : r;
  } catch (e) {
    console.error("AI actions failed: request update", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
  }
}

/** Item 8: AI blocker suggestions (one project from the drawer, or every project from Admin > Dependencies). Saves nothing. */
export async function suggestAiBlockers(projectId: string | null): Promise<AiDependencySuggestResult> {
  try {
    const c = await context();
    if (!c) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    return await AiDependencySuggestService.suggest({ db: c.db, viewer: c.viewer, scope: c.scope, projectId: typeof projectId === "string" ? projectId : null });
  } catch (e) {
    console.error("AI actions failed: blocker suggestions", (e as Error)?.name);
    return { ok: false, message: AiToolsCopy.PROVIDER_ERROR };
  }
}
