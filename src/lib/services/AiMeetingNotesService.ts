import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import type { AiActionLine, AiActionRefusal } from "@/lib/ai/actions/AiActionModel";
import { AiMeetingNotesModel, type AiUnmatchedNote } from "@/lib/ai/notes/AiMeetingNotesModel";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiActionService, type AiActionDb, type AiActionPorts } from "@/lib/services/AiActionService";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiToolsService } from "@/lib/services/AiToolsService";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export type AiMeetingNotesResult =
  | { ok: true; proposal: { proposalId: string; lines: AiActionLine[]; summary: string } | null; refused: AiActionRefusal[]; drafts: { proposalId: string; draft: unknown }[]; unmatched: AiUnmatchedNote[]; message: string | null }
  | { ok: false; message: string };

/**
 * Meeting notes item: Meeting notes to updates on the shared context and action layer. One model call on the
 * meeting_notes routed model; the change lines go through AiActionService.propose (checked against the stored projects
 * and the line's lists, one confirm card with Apply all), new projects become drafts (created only from their card), and
 * notes that match nothing are listed. One run row per call; the proposal rows are the action layer's.
 */
export class AiMeetingNotesService {
  static readonly FEATURE = "meeting_notes" as const;
  static readonly PREFIX_MAX = 6000;

  static async process(args: { db: AiActionDb; viewer: Viewer | null; scope: ServiceLineScope; notes: unknown; /** Placement or playbook context sent before the notes (which rows, planned follow-ups). Ends with "Meeting notes:" when given. */ prefix?: string | null; projects: readonly AiToolProject[]; ports: AiActionPorts; env?: Env; fetchImpl?: FetchLike; keys?: AiProviderKeySource; now?: () => Date }): Promise<AiMeetingNotesResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const notes = typeof args.notes === "string" ? args.notes.replace(/\r\n/g, "\n").trim() : "";
    if (!notes) return { ok: false, message: AiCopy.EMPTY_INPUT };
    const context = await AiToolsService.contextFor(args.db, args.scope, args.viewer, args.projects, args.now);
    const prefix = typeof args.prefix === "string" ? args.prefix.trim().slice(0, AiMeetingNotesService.PREFIX_MAX) : "";
    const room = AiToolsService.INPUT_MAX - prefix.length - 32;
    const user = prefix ? `${prefix}${/Meeting notes:$/.test(prefix) ? "" : "\nMeeting notes:"}\n${notes.slice(0, room)}` : `Meeting notes:\n${notes.slice(0, room)}`;
    const r = await AiToolsService.call({ db: args.db, viewer: args.viewer, feature: AiMeetingNotesService.FEATURE, input: user, build: (input) => ({ system: AiMeetingNotesModel.system(context), user: input, maxTokens: AiMeetingNotesModel.MAX_TOKENS }), env: args.env, fetchImpl: args.fetchImpl, keys: args.keys, now: args.now });
    if (!r.ok) return { ok: false, message: r.message };
    const reply = AiMeetingNotesModel.parse(r.text);
    if (!reply) {
      await r.log("failed");
      return { ok: false, message: AiToolsCopy.PARSE_FAILED };
    }
    await r.log("suggested", { outputLength: null, inputLength: notes.length });

    let proposal: { proposalId: string; lines: AiActionLine[]; summary: string } | null = null;
    let refused: AiActionRefusal[] = [];
    let message: string | null = null;
    if (reply.changes.length) {
      const p = await AiActionService.propose({ db: args.db, viewer: args.viewer, scope: args.scope, projects: args.projects, feature: AiMeetingNotesService.FEATURE, changes: reply.changes, env: args.env, now: args.now?.() });
      if (p.ok) {
        proposal = { proposalId: p.proposalId, lines: p.lines, summary: p.summary };
        refused = p.refused;
      } else {
        refused = p.refused ?? [];
        message = p.message;
      }
    }
    const drafts: { proposalId: string; draft: unknown }[] = [];
    for (const np of reply.newProjects) {
      const t = await AiActionService.runTool({ name: "draft_project", args: np, db: args.db, viewer: args.viewer, scope: args.scope, feature: AiMeetingNotesService.FEATURE, projects: args.projects, ports: args.ports, env: args.env, now: args.now });
      if (t.draft) drafts.push(t.draft);
      else reply.unmatched.push({ text: String(np.name ?? ""), why: AiMeetingNotesService.draftWhy(t.output) });
    }
    if (!proposal && !drafts.length && !reply.unmatched.length && !refused.length) message = message ?? AiToolsCopy.NO_CHANGES;
    return { ok: true, proposal, refused, drafts, unmatched: reply.unmatched, message };
  }

  private static draftWhy(output: string): string {
    try {
      return String((JSON.parse(output) as { error?: unknown }).error ?? AiToolsCopy.DRAFT_INVALID);
    } catch {
      return AiToolsCopy.DRAFT_INVALID;
    }
  }
}
