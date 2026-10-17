import { randomUUID } from "node:crypto";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiInputs, type AiInput, type AiTranscriber } from "@/lib/ai/AiInput";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiPrompts } from "@/lib/ai/AiPrompts";
import { AiProviderClient, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiProviders } from "@/lib/ai/AiProviders";
import { AiReviewModel, type AiProposal } from "@/lib/ai/AiReviewModel";
import { AiReviewPrompts } from "@/lib/ai/AiReviewPrompts";
import { AppConfig } from "@/lib/config/AppConfig";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiFeatureRuntime, type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiSettingsService } from "./AiSettingsService";
import { AiWritingService, type AiUsageRow, type AiWritingDb } from "./AiWritingService";

type Env = Record<string, string | undefined>;
type Scope = Pick<ServiceLineScope, "id" | "departmentLimit">;

/** ai_usage_log.event values written by this layer (0038). */
export type AiReviewEvent = "proposed" | "applied" | "rejected" | "undone" | "failed";

export type AiProposeResult =
  | ({ ok: true } & AiProposal)
  | { ok: false; kind: "off" | "feature_off" | "denied" | "gone" | "empty" | "unsupported" | "rate" | "timeout" | "provider"; message: string };

export type AiDecisionResult = { ok: true } | { ok: false; message: string };

/** Events that count toward the shared per-user rate limit (the writing assistant's events plus proposals). */
const RATE_EVENTS = ["suggested", "failed", "proposed"];
const CLOSED = ["applied", "rejected"];

/**
 * The shared review-then-apply layer: the AI proposes, the user reviews a preview, and only an explicit Apply changes
 * anything. Built on the writing assistant's pieces (AI settings, the enabled ai_models allowlist, AiProviderClient, the
 * usage log and its 30-day retention, the rate limit). It never writes to Project, ProjectHistory, milestones,
 * snapshots, PDFs, report_artifacts or handoff.json: Apply only fills the edit form's draft, and the project changes
 * when the user saves the form through the normal save path (the same history row and Changed as a manual edit).
 * AiPhiGuard runs on the input and the proposal but is not a gate: it decides only whether the proposal text is kept
 * in the usage log.
 */
export class AiReviewApplyService {
  private static readonly inFlight = new Set<string>();

  /**
   * Same access as a manual edit: admin, project exists and is not archived, in the active line and the viewer's
   * departments. A project out of scope gets the same answer as a deleted one, so nothing leaks.
   */
  static async access(db: AiWritingDb, viewer: Viewer | null, projectId: unknown, scope: Scope): Promise<"ok" | "denied" | "gone"> {
    if (!viewer?.isAdmin) return "denied";
    if (projectId === null) return "ok"; // New project form: creating is admin-only.
    if (typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) return "gone";
    const p = await db.project.findUnique({ where: { id: projectId } });
    if (!p || p.archivedAt || !ServiceLineAccess.inScope(p, scope) || !DepartmentAccess.allows(scope, p.departmentId)) return "gone";
    return "ok";
  }

  static denial(a: "denied" | "gone"): string {
    return a === "denied" ? AiCopy.NOT_AUTHORIZED : AiCopy.PROJECT_GONE;
  }

  static async propose(args: {
    db: AiWritingDb;
    viewer: Viewer | null;
    scope: Scope;
    projectId: string | null;
    feature: unknown;
    /** The current field value (the note in the edit form). */
    current: unknown;
    /** What the user asked for: text today, audio later (the stub says unsupported). */
    input: AiInput | null;
    env?: Env;
    fetchImpl?: FetchLike;
    transcriber?: AiTranscriber;
    now?: () => Date;
    /** PR B: the provider keys (tests inject a fake; the app reads the Provider keys card's storage). */
    keys?: AiProviderKeySource;
  }): Promise<AiProposeResult> {
    const { db, viewer, scope, projectId } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    const feature = AiFeatureFlags.parseFeature(args.feature);
    if (!feature) return { ok: false, kind: "denied", message: AiCopy.NOT_AUTHORIZED };
    const access = await AiReviewApplyService.access(db, viewer, projectId, scope);
    if (access !== "ok") return { ok: false, kind: access, message: AiReviewApplyService.denial(access) };
    if (!(await AiModelService.featureOn(db, feature, env))) return { ok: false, kind: "feature_off", message: AiCopy.FEATURE_OFF };

    const instruction = await AiInputs.toText(args.input, AppConfig.NOTE_MAX_LENGTH, args.transcriber);
    if (!instruction.ok) {
      return instruction.reason === "unsupported"
        ? { ok: false, kind: "unsupported", message: AiCopy.AUDIO_UNSUPPORTED }
        : { ok: false, kind: "empty", message: AiCopy.INSTRUCTION_EMPTY };
    }
    const current = typeof args.current === "string" ? args.current.slice(0, AppConfig.NOTE_MAX_LENGTH) : "";

    const row = await AiSettingsService.row(db).catch(() => null);
    // PR B: the feature's own provider and model when an admin picked them; otherwise the AI settings, as before.
    const saved = row?.enabled ? await AiFeatureRuntime.config({ db, feature, settings: row, env, keys: args.keys }) : null;
    if (!saved) return { ok: false, kind: "off", message: AiCopy.UNAVAILABLE };
    // Allowlist = the models an admin turned on (ai_models). Never switched automatically.
    const config = { ...saved, allowedModels: await AiModelService.enabledIds(db, "chat") };
    if (!AiProviders.modelAllowed(config.model, config.allowedModels)) return { ok: false, kind: "provider", message: AiCopy.MODEL_NOT_ALLOWED };

    const user = viewer!.email;
    if (AiReviewApplyService.inFlight.has(user)) return { ok: false, kind: "rate", message: AiCopy.RATE_LIMITED };
    const recent = await db.aiUsageLog.count({ where: { userEmail: user, event: { in: RATE_EVENTS }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } } });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, kind: "rate", message: AiCopy.RATE_LIMITED };

    const proposalId = randomUUID();
    const inputLength = current.length + instruction.text.length;
    const log = (event: AiReviewEvent, extra: Partial<AiUsageRow> = {}) =>
      db.aiUsageLog.create({
        data: { id: randomUUID(), suggestionId: proposalId, userEmail: user, projectId, feature, event, provider: config.provider, model: config.model, inputLength, outputLength: null, numberCheckPassed: null, suggestedText: null, createdAt: now(), ...extra },
      });

    AiReviewApplyService.inFlight.add(user);
    try {
      const result = await AiProviderClient.complete(config, AiReviewPrompts.build(feature, current, instruction.text), args.fetchImpl);
      if (!result.ok) {
        await log("failed");
        console.error("AI review layer: provider call failed", { kind: result.kind, status: result.status, message: result.message });
        return {
          ok: false,
          kind: result.kind === "timeout" ? "timeout" : "provider",
          message: result.kind === "timeout" ? AiCopy.TIMEOUT : result.kind === "length" ? AiCopy.OUT_OF_REPLY_LENGTH : AiCopy.PROVIDER_ERROR,
        };
      }
      const after = AiPrompts.clean(result.text);
      const numbers = AiReviewModel.recheck(AiReviewModel.reference(current, instruction.text), after);
      await log("proposed", { outputLength: after.length, numberCheckPassed: numbers.ok, suggestedText: AiPhiGuard.check(after).ok ? after : null });
      return { ok: true, proposalId, feature, before: current, after, limit: AppConfig.NOTE_MAX_LENGTH, numbers };
    } finally {
      AiReviewApplyService.inFlight.delete(user);
    }
  }

  /**
   * Apply: re-checks access and the kill switch, then records one "applied" row. It writes nothing else; the caller
   * puts the text into the form draft. Only the user who got the proposal can apply it, once (a repeat is a no-op).
   */
  static async apply(db: AiWritingDb, viewer: Viewer | null, scope: Scope, proposalId: unknown, appliedText: unknown, env: Env = process.env, now: Date = new Date()): Promise<AiDecisionResult> {
    return AiReviewApplyService.decide(db, viewer, scope, proposalId, "applied", env, now, typeof appliedText === "string" ? appliedText.length : null);
  }

  /** Reject: one "rejected" row. Nothing changes. */
  static async reject(db: AiWritingDb, viewer: Viewer | null, scope: Scope, proposalId: unknown, env: Env = process.env, now: Date = new Date()): Promise<AiDecisionResult> {
    return AiReviewApplyService.decide(db, viewer, scope, proposalId, "rejected", env, now, null);
  }

  /** Undo after Apply (before the form is saved): one "undone" row. The form restores its own draft. */
  static async undo(db: AiWritingDb, viewer: Viewer | null, scope: Scope, proposalId: unknown, env: Env = process.env, now: Date = new Date()): Promise<AiDecisionResult> {
    return AiReviewApplyService.decide(db, viewer, scope, proposalId, "undone", env, now, null);
  }

  private static async decide(db: AiWritingDb, viewer: Viewer | null, scope: Scope, proposalId: unknown, event: "applied" | "rejected" | "undone", env: Env, now: Date, outputLength: number | null): Promise<AiDecisionResult> {
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    if (typeof proposalId !== "string" || !/^[0-9a-f-]{36}$/i.test(proposalId)) return { ok: false, message: AiCopy.APPLY_FAILED };
    const proposed = await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: "proposed" } });
    if (!proposed) return { ok: false, message: AiCopy.APPLY_FAILED };
    const feature = AiFeatureFlags.parseFeature(proposed.feature);
    if (!feature) return { ok: false, message: AiCopy.APPLY_FAILED };
    if (event === "applied" && !(await AiModelService.featureOn(db, feature, env))) return { ok: false, message: AiCopy.FEATURE_OFF };
    if (event !== "rejected") {
      const access = await AiReviewApplyService.access(db, viewer, proposed.projectId, scope);
      if (access !== "ok") return { ok: false, message: AiReviewApplyService.denial(access) };
    }
    if (event === "undone") {
      const applied = await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: "applied" } });
      if (!applied) return { ok: false, message: AiCopy.APPLY_FAILED };
      if (await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: "undone" } })) return { ok: true };
    } else {
      const closed = await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: { in: CLOSED } } });
      if (closed) return closed.event === event ? { ok: true } : { ok: false, message: AiCopy.APPLY_FAILED };
    }
    await db.aiUsageLog.create({
      data: {
        id: randomUUID(),
        suggestionId: proposalId,
        userEmail: viewer.email,
        projectId: proposed.projectId,
        feature: proposed.feature,
        event,
        provider: proposed.provider,
        model: proposed.model,
        inputLength: proposed.inputLength,
        outputLength: event === "applied" ? outputLength : null,
        numberCheckPassed: proposed.numberCheckPassed,
        suggestedText: null,
        unverifiedCount: null,
        createdAt: now,
      },
    });
    return { ok: true };
  }
}
