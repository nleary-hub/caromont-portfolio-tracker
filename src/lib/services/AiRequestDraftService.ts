import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiRequestDraftModel, type AiRequestDraft, type AiRequestDuplicate, type AiRequestExisting, type AiRequestLists, type AiRequestTemplate } from "@/lib/ai/request/AiRequestDraftModel";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { MilestoneEdit } from "@/lib/domain/MilestoneRules";
import { AiActionService } from "@/lib/services/AiActionService";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiToolsService, type AiToolLineResult, type AiToolsDb } from "@/lib/services/AiToolsService";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;
type Row = Record<string, unknown>;

export type AiRequestDraftResult =
  | {
      ok: true;
      proposalId: string;
      draft: AiRequestDraft;
      duplicates: AiRequestDuplicate[];
      templates: AiRequestTemplate[];
      departments: { id: string; name: string }[];
      requesters: string[];
    }
  | { ok: false; message: string };

/**
 * Item 7: Request to draft project. One call on the request_to_project routed model with the shared context, the
 * line's templates and People lists; every value is checked against those lists in code, plus a code-side duplicate
 * check. Saves nothing: the project is created only from the review card, through the normal create with the
 * template's milestones in the same transaction and the ai:request_to_project history tag.
 */
export class AiRequestDraftService {
  static readonly FEATURE = "request_to_project" as const;
  static readonly TEMPLATES_MAX = 40;

  /** The line's templates with their steps, in admin order. Tolerant: [] when the tables are missing. */
  static async templates(db: unknown, scope: ServiceLineScope): Promise<AiRequestTemplate[]> {
    const d = db as Record<string, { findMany(a: object): Promise<Row[]> } | undefined>;
    try {
      if (!d.milestoneTemplate || !d.milestoneTemplateItem) return [];
      const all = (await d.milestoneTemplate.findMany({ where: { serviceLineId: scope.id } }))
        .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
        .slice(0, AiRequestDraftService.TEMPLATES_MAX);
      if (!all.length) return [];
      const items = await d.milestoneTemplateItem.findMany({ where: { templateId: { in: all.map((t) => String(t.id)) } } });
      return all
        .map((t) => ({ id: String(t.id), name: String(t.name), steps: items.filter((i) => i.templateId === t.id).sort((a, b) => Number(a.position) - Number(b.position)).map((i) => String(i.name)) }))
        .filter((t) => t.steps.length > 0);
    } catch {
      return [];
    }
  }

  static async lists(db: unknown, scope: ServiceLineScope): Promise<AiRequestLists> {
    const people = await AiActionService.lists(db, scope);
    return { departments: people.departments, requesters: people.requesters, templates: await AiRequestDraftService.templates(db, scope) };
  }

  /** The listed projects with their REQ numbers (for the duplicate check). Tolerant: null REQ when unreadable. */
  static async existing(db: unknown, projects: readonly AiToolProject[]): Promise<AiRequestExisting[]> {
    const d = db as { project?: { findMany(a: object): Promise<Row[]> } };
    let rows: Row[] = [];
    try {
      rows = projects.length && d.project ? await d.project.findMany({ where: { id: { in: projects.map((p) => p.id) } }, select: { id: true, inforRequestNumber: true } }) : [];
    } catch {
      rows = [];
    }
    const req = new Map(rows.map((r) => [String(r.id), typeof r.inforRequestNumber === "number" ? r.inforRequestNumber : null]));
    return projects.map((p) => ({ ...p, inforRequestNumber: req.get(p.id) ?? null }));
  }

  static async propose(args: { db: AiToolsDb; viewer: Viewer | null; scope: ServiceLineScope; input: unknown; env?: Env; fetchImpl?: FetchLike; keys?: AiProviderKeySource; now?: () => Date }): Promise<AiRequestDraftResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const projects = await AiToolsService.projects(args.db, args.scope);
    const [context, lists, existing] = await Promise.all([
      AiToolsService.contextFor(args.db, args.scope, args.viewer, projects, args.now),
      AiRequestDraftService.lists(args.db, args.scope),
      AiRequestDraftService.existing(args.db, projects),
    ]);
    const r = await AiToolsService.call({
      db: args.db,
      viewer: args.viewer,
      feature: AiRequestDraftService.FEATURE,
      input: typeof args.input === "string" ? args.input : "",
      build: (input) => ({ system: AiRequestDraftModel.system(context, lists), user: `Project request:\n${input}`, maxTokens: AiRequestDraftModel.MAX_TOKENS }),
      env: args.env,
      fetchImpl: args.fetchImpl,
      keys: args.keys,
      now: args.now,
    });
    if (!r.ok) return { ok: false, message: r.message };
    const reply = AiRequestDraftModel.parse(r.text, lists, projects);
    if (!reply) {
      await r.log("failed");
      return { ok: false, message: AiToolsCopy.PARSE_FAILED };
    }
    const kept = JSON.stringify(reply.draft);
    await r.log("proposed", { outputLength: kept.length, suggestedText: AiPhiGuard.check(kept).ok ? kept : null });
    return {
      ok: true,
      proposalId: r.proposalId,
      draft: reply.draft,
      duplicates: AiRequestDraftModel.duplicates(reply.draft, existing, reply.duplicate),
      templates: [...lists.templates],
      departments: lists.departments.filter((d) => !d.archived && !d.deleted).map((d) => ({ id: d.id, name: d.name })),
      requesters: [...lists.requesters],
    };
  }

  /** Create from the reviewed (possibly edited) draft: values re-checked against the lists, template steps attached. */
  static async create(args: {
    db: AiToolsDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    proposalId: unknown;
    draft: unknown;
    write: (input: Record<string, string | null>, milestones: MilestoneEdit) => Promise<string>;
    env?: Env;
    now?: Date;
  }): Promise<AiToolLineResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const lists = await AiRequestDraftService.lists(args.db, args.scope);
    const d = AiRequestDraftModel.clean(args.draft, lists);
    if (!d) return { ok: false, message: AiToolsCopy.DRAFT_INVALID };
    const t = lists.templates.find((x) => x.id === d.templateId);
    const milestones: MilestoneEdit = { drafts: AiRequestDraftModel.steps(t, d.dueDate), applied: t ? { templateId: t.id, templateName: t.name, mode: "replace" } : null };
    return AiToolsService.applyDraft({ db: args.db, viewer: args.viewer, proposalId: args.proposalId, draft: d, create: () => args.write(AiRequestDraftModel.input(d), milestones), env: args.env, now: args.now });
  }
}
