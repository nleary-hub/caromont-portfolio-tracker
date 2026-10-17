import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { AiTemplateCopy as C } from "@/lib/ai/AiTemplateCopy";
import { AiTemplateModel, type AiTemplateDesired, type AiTemplateMode, type AiTemplateOp, type AiTemplateRow } from "@/lib/ai/AiTemplateModel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiModelService } from "@/lib/services/AiModelService";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { MilestoneTemplateService, type TemplateDto } from "@/lib/services/MilestoneTemplateService";
import { AiToolsService, type AiToolFailure, type AiToolsDb, type AiToolUsageRow } from "./AiToolsService";

type Env = Record<string, string | undefined>;
type Scope = Pick<ServiceLineScope, "id">;

export type AiTemplateProposeResult = { ok: true; proposalId: string; mode: AiTemplateMode; templateId: string | null; rows: AiTemplateRow[] } | AiToolFailure;
export type AiTemplateApplyResult = { ok: true; templateId: string; templates: TemplateDto[] } | { ok: false; message: string };

/**
 * The Template AI assistant: the AI proposes a template (Draft) or a diff to one template (Edit with AI); an admin reviews
 * each row and applies all or some. Nothing saves until Apply. Every write goes through MilestoneTemplateService, so each is
 * admin-checked, validated and appended to milestone_template_history. Template writes never touch project milestones.
 * Uses the shared AI tools guards (AiToolsService.call): the per-feature toggle, the admin-selected chat model with no
 * fallback, the rate limit, and one ai_usage_log row per call.
 */
export class AiTemplateService {
  static readonly FEATURE = "template_ai" as const;

  static async propose(args: {
    db: AiToolsDb;
    viewer: Viewer | null;
    mode: AiTemplateMode;
    input: unknown;
    /** The template being edited (edit mode), as stored now. */
    current: TemplateDto | null;
    env?: Env;
    fetchImpl?: FetchLike;
    now?: () => Date;
    /** PR B: the provider keys (tests inject a fake). */
    keys?: AiProviderKeySource;
  }): Promise<AiTemplateProposeResult> {
    const { mode, current } = args;
    if (mode === "edit" && !current) return { ok: false, kind: "denied", message: AiCopy.NOT_AUTHORIZED };
    const r = await AiToolsService.call({
      ...args,
      feature: AiTemplateService.FEATURE,
      input: typeof args.input === "string" ? args.input : "",
      build: (input) => AiTemplateModel.build(mode, input, current),
    });
    if (!r.ok) return r;
    const proposal = AiTemplateModel.parse(r.text, mode);
    if (!proposal) {
      await r.log("failed");
      return { ok: false, kind: "parse", message: AiToolsCopy.PARSE_FAILED };
    }
    const rows = AiTemplateModel.diff(mode === "edit" ? current : null, proposal);
    const changed = rows.filter(AiTemplateModel.changed);
    if (mode === "draft" ? !proposal.steps.length : !changed.length) {
      await r.log("failed", { outputLength: 0 });
      return { ok: false, kind: "empty", message: mode === "draft" ? C.EMPTY_DRAFT : C.NO_CHANGES };
    }
    const kept = JSON.stringify(proposal);
    await r.log("proposed", { outputLength: changed.length, suggestedText: AiPhiGuard.check(kept).ok ? kept : null });
    return { ok: true, proposalId: r.proposalId, mode, templateId: current?.id ?? null, rows };
  }

  /**
   * Apply the admin's chosen rows (sent as the resulting template). Re-checks admin, the toggle, that this admin got the
   * proposal and has not applied it yet, and MilestoneRules; then writes through MilestoneTemplateService. One "applied" row.
   */
  static async apply(args: {
    db: AiToolsDb;
    templateDb: PrismaClient;
    viewer: Viewer | null;
    scope: Scope;
    proposalId: unknown;
    templateId: unknown;
    desired: unknown;
    env?: Env;
    now?: Date;
  }): Promise<AiTemplateApplyResult> {
    const { db, viewer, scope } = args;
    const env = args.env ?? process.env;
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    if (typeof args.proposalId !== "string" || !/^[0-9a-f-]{36}$/i.test(args.proposalId)) return { ok: false, message: C.APPLY_FAILED };
    const row = await db.aiUsageLog.findFirst({ where: { suggestionId: args.proposalId, userEmail: viewer.email, event: "proposed", feature: AiTemplateService.FEATURE } });
    if (!row) return { ok: false, message: C.APPLY_FAILED };
    if (!(await AiModelService.featureOn(db, AiTemplateService.FEATURE, env))) return { ok: false, message: AiToolsCopy.FEATURE_OFF };
    if (await db.aiUsageLog.findFirst({ where: { suggestionId: args.proposalId, userEmail: viewer.email, event: { in: ["applied", "rejected"] } } })) return { ok: false, message: C.APPLY_FAILED };
    const desired = AiTemplateModel.readDesired(args.desired);
    if (!desired) return { ok: false, message: C.APPLY_FAILED };
    const errors = AiTemplateModel.check(desired);
    if (errors.length) return { ok: false, message: C.FINAL_INVALID };

    const templates = await MilestoneTemplateService.list(args.templateDb, scope);
    const current = args.templateId === null ? null : (templates.find((t) => t.id === args.templateId) ?? undefined);
    if (current === undefined) return { ok: false, message: C.TEMPLATE_CHANGED };
    const ops = AiTemplateModel.ops(current, desired);
    if (!ops) return { ok: false, message: C.TEMPLATE_CHANGED };
    let templateId: string;
    try {
      // One transaction for the whole apply (CTO, PR #75): all or nothing, history rows included, each tagged with applyId.
      const meta = { applyId: randomUUID(), source: "ai" as const };
      templateId = await MilestoneTemplateService.batch(args.templateDb, meta, (tx) => AiTemplateService.execute(ops, current?.id ?? null, viewer, tx, scope));
    } catch (e) {
      console.error("Template AI: apply failed", (e as Error)?.name);
      return { ok: false, message: C.APPLY_FAILED };
    }
    await AiTemplateService.decision(db, row, "applied", ops.length, args.now);
    return { ok: true, templateId, templates: await MilestoneTemplateService.list(args.templateDb, scope) };
  }

  /** Discard: one "rejected" row. Nothing changes. */
  static async discard(db: AiToolsDb, viewer: Viewer | null, proposalId: unknown, now?: Date): Promise<{ ok: boolean }> {
    if (!viewer?.isAdmin || typeof proposalId !== "string") return { ok: false };
    const row = await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: "proposed", feature: AiTemplateService.FEATURE } });
    if (!row) return { ok: false };
    if (await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: { in: ["applied", "rejected"] } } })) return { ok: false };
    await AiTemplateService.decision(db, row, "rejected", null, now);
    return { ok: true };
  }

  /** Runs the ops through MilestoneTemplateService (each call writes its own history row). Returns the template id. */
  static async execute(ops: readonly AiTemplateOp[], templateId: string | null, admin: Viewer, db: PrismaClient, scope: Scope): Promise<string> {
    let id = templateId;
    const newIds = new Map<number, string>();
    for (const op of ops) {
      if (op.op === "create") id = (await MilestoneTemplateService.create(op.name, admin, db, scope)).id;
      else if (op.op === "rename") await MilestoneTemplateService.rename(id!, op.name, admin, db, scope);
      else if (op.op === "removeItem") await MilestoneTemplateService.removeItem(op.id, admin, db, scope);
      else if (op.op === "renameItem") await MilestoneTemplateService.renameItem(op.id, op.name, admin, db, scope);
      else if (op.op === "addItem") newIds.set(op.index, (await MilestoneTemplateService.addItem(id!, op.name, admin, db, scope)).id);
      else await MilestoneTemplateService.reorderItems(id!, op.order.map((o) => o.id ?? newIds.get(o.index)!), admin, db, scope);
    }
    return id!;
  }

  private static decision(db: AiToolsDb, proposed: AiToolUsageRow, event: "applied" | "rejected", outputLength: number | null, now: Date = new Date()) {
    return db.aiUsageLog.create({
      data: {
        id: randomUUID(),
        suggestionId: proposed.suggestionId,
        userEmail: proposed.userEmail,
        projectId: null,
        feature: proposed.feature,
        event,
        provider: proposed.provider,
        model: proposed.model,
        inputLength: proposed.inputLength,
        outputLength,
        numberCheckPassed: null,
        suggestedText: null,
        unverifiedCount: null,
        lineIndex: 0,
        createdAt: now,
      },
    });
  }
}

export type { AiTemplateDesired };
