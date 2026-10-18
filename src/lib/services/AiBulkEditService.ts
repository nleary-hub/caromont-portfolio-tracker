import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import type { AiBulkSummary } from "@/lib/ai/AiBulkEdit";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import type { AiActionLine, AiActionRefusal } from "@/lib/ai/actions/AiActionModel";
import { AiBulkEditFull } from "@/lib/ai/bulk/AiBulkEditFull";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiActionService, type AiActionDb } from "@/lib/services/AiActionService";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiToolsService } from "@/lib/services/AiToolsService";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export type AiBulkEditResult =
  | { ok: true; bulk: AiBulkSummary; proposal: { proposalId: string; lines: AiActionLine[]; summary: string } | null; refused: AiActionRefusal[]; already: number; message: string | null }
  | { ok: false; message: string };

const ALREADY = /\bis already\b|\balready (done|an open)\b/;

/**
 * Item 4: plain-English bulk edit on the shared context (A) and action layer (B). One model call on the bulk_edit
 * routed model (D) returns a filter and one action; this service picks the projects (optionally only the selected
 * ones), proposes one line per project through AiActionService.propose (pick-list checks, history tag ai:bulk_edit,
 * Apply all on the C card) and returns the filter in plain words for the preview. Saves nothing to projects.
 */
export class AiBulkEditService {
  static readonly FEATURE = "bulk_edit" as const;

  static async propose(args: { db: AiActionDb; viewer: Viewer | null; scope: ServiceLineScope; projects: readonly AiToolProject[]; input: unknown; onlyIds?: readonly string[] | null; env?: Env; fetchImpl?: FetchLike; keys?: AiProviderKeySource; now?: () => Date }): Promise<AiBulkEditResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const input = typeof args.input === "string" ? args.input.trim() : "";
    if (!input) return { ok: false, message: AiToolsCopy.INPUT_EMPTY };
    const only = args.onlyIds?.length ? new Set(args.onlyIds.filter((x) => typeof x === "string")) : null;
    const context = await AiToolsService.contextFor(args.db, args.scope, args.viewer, args.projects, args.now);
    const r = await AiToolsService.call({ db: args.db, viewer: args.viewer, feature: AiBulkEditService.FEATURE, input, build: (t) => ({ system: AiBulkEditFull.system(context), user: t, maxTokens: AiBulkEditFull.MAX_TOKENS }), env: args.env, fetchImpl: args.fetchImpl, keys: args.keys, now: args.now });
    if (!r.ok) return { ok: false, message: r.message };
    const plan = AiBulkEditFull.parse(r.text);
    if (!plan) {
      await r.log("failed");
      return { ok: false, message: AiToolsCopy.BULK_UNREADABLE };
    }
    await r.log("suggested", { outputLength: null, suggestedText: JSON.stringify(plan).slice(0, 2000) });
    const state = await AiActionService.load(args.db, args.scope, args.projects);
    const lists = await AiActionService.lists(args.db, args.scope);
    const today = (args.now?.() ?? new Date()).toISOString().slice(0, 10);
    const { changes, matched } = AiBulkEditFull.changes(plan, state, today, lists, only);
    const onlyCount = only ? only.size : null;
    if (!changes.length) return { ok: true, bulk: AiBulkEditFull.summary(plan, matched, 0, onlyCount), proposal: null, refused: [], already: 0, message: matched ? AiToolsCopy.BULK_NOTHING_TO_CHANGE : AiToolsCopy.BULK_NO_MATCH };
    const p = await AiActionService.propose({ db: args.db, viewer: args.viewer, scope: args.scope, projects: args.projects, feature: AiBulkEditService.FEATURE, changes, env: args.env, now: args.now?.() });
    const refusedAll = p.ok ? p.refused : (p.refused ?? []);
    const refused = refusedAll.filter((x) => !ALREADY.test(x.why));
    const already = refusedAll.length - refused.length;
    if (!p.ok) return { ok: true, bulk: AiBulkEditFull.summary(plan, matched, 0, onlyCount), proposal: null, refused, already, message: refused.length ? p.message : AiToolsCopy.BULK_NOTHING_TO_CHANGE };
    return { ok: true, bulk: AiBulkEditFull.summary(plan, matched, p.lines.length, onlyCount), proposal: { proposalId: p.proposalId, lines: p.lines, summary: p.summary }, refused, already, message: null };
  }
}
