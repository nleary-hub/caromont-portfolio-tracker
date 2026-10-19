import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiActionLine, AiActionRefusal } from "@/lib/ai/actions/AiActionModel";
import { AiNextStepModel, type AiNextStep, type AiNextStepTemplate } from "@/lib/ai/nextstep/AiNextStepModel";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiActionService, type AiActionDb } from "@/lib/services/AiActionService";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiToolsService } from "@/lib/services/AiToolsService";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;
type Row = Record<string, unknown>;

export type AiNextStepResult =
  | { ok: true; suggestion: AiNextStep; template: string | null; proposal: { proposalId: string; lines: AiActionLine[]; summary: string } | null; refused: AiActionRefusal[]; message: string | null }
  | { ok: false; message: string };

const ALREADY = /\bis already\b|\balready (done|an open)\b/;

/**
 * Item 6: next-step suggestion for one project (row "..." menu and the drawer). Reads the project's full context and
 * the template its milestones came from, asks the next_step routed model which milestone is really next, and turns
 * the answer into checked change lines (move it up, add it, its owner and due date) on the shared confirm card.
 * The action for this week is shown only. Saves nothing until Apply.
 */
export class AiNextStepService {
  static readonly FEATURE = "next_step" as const;

  /** The template(s) behind the project's milestones; all of the line's templates when none is linked (tolerant). */
  static async templates(db: unknown, scope: ServiceLineScope, templateIds: readonly string[]): Promise<{ linked: string | null; list: AiNextStepTemplate[] }> {
    const d = db as Record<string, { findMany(a: object): Promise<Row[]> } | undefined>;
    try {
      if (!d.milestoneTemplate || !d.milestoneTemplateItem) return { linked: null, list: [] };
      const all = await d.milestoneTemplate.findMany({ where: { serviceLineId: scope.id } });
      const pick = templateIds.length ? all.filter((t) => templateIds.includes(String(t.id))) : all.slice(0, 12);
      if (!pick.length) return { linked: null, list: [] };
      const items = await d.milestoneTemplateItem.findMany({ where: { templateId: { in: pick.map((t) => String(t.id)) } } });
      const list = pick.map((t) => ({ name: String(t.name), steps: items.filter((i) => i.templateId === t.id).sort((a, b) => Number(a.position) - Number(b.position)).map((i) => String(i.name)) }));
      return { linked: templateIds.length ? (list[0]?.name ?? null) : null, list };
    } catch {
      return { linked: null, list: [] };
    }
  }

  static async suggest(args: { db: AiActionDb; viewer: Viewer | null; scope: ServiceLineScope; projectId: unknown; env?: Env; fetchImpl?: FetchLike; keys?: AiProviderKeySource; now?: () => Date }): Promise<AiNextStepResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    if (typeof args.projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(args.projectId)) return { ok: false, message: AiToolsCopy.PICK_PROJECT };
    const projects = await AiToolsService.projects(args.db, args.scope, args.projectId);
    if (!projects.length) return { ok: false, message: AiCopy.PROJECT_GONE };
    const [state] = await AiActionService.load(args.db, args.scope, projects);
    const ids = [...new Set(state.steps.map((s) => s.sourceTemplateId).filter((x): x is string => Boolean(x)))];
    const t = await AiNextStepService.templates(args.db, args.scope, ids);
    const context = await AiToolsService.contextFor(args.db, args.scope, args.viewer, projects, args.now);
    const r = await AiToolsService.call({ db: args.db, viewer: args.viewer, feature: AiNextStepService.FEATURE, projectId: args.projectId, input: AiToolsCopy.NEXT_INSTRUCTION, build: (input) => ({ system: AiNextStepModel.system(context, t.list), user: input, maxTokens: AiNextStepModel.MAX_TOKENS }), env: args.env, fetchImpl: args.fetchImpl, keys: args.keys, now: args.now });
    if (!r.ok) return { ok: false, message: r.message };
    const today = DateOnly.inZone(args.now?.() ?? new Date());
    const s = AiNextStepModel.parse(r.text, today);
    if (!s) {
      await r.log("failed");
      return { ok: false, message: AiToolsCopy.PARSE_FAILED };
    }
    await r.log("suggested", { outputLength: null });
    const changes = AiNextStepModel.changes("P1", s, state.steps);
    if (!changes.length) return { ok: true, suggestion: s, template: t.linked, proposal: null, refused: [], message: AiToolsCopy.NEXT_ALREADY };
    const p = await AiActionService.propose({ db: args.db, viewer: args.viewer, scope: args.scope, projects, feature: AiNextStepService.FEATURE, changes, env: args.env, now: args.now?.() });
    const refused = (p.ok ? p.refused : (p.refused ?? [])).filter((x) => !ALREADY.test(x.why));
    if (!p.ok) return { ok: true, suggestion: s, template: t.linked, proposal: null, refused, message: refused.length ? p.message : AiToolsCopy.NEXT_ALREADY };
    return { ok: true, suggestion: s, template: t.linked, proposal: { proposalId: p.proposalId, lines: p.lines, summary: p.summary }, refused, message: null };
  }
}
