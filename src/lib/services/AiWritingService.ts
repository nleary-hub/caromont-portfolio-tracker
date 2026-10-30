import { randomUUID } from "node:crypto";
import { AiRunMetrics } from "@/lib/ai/AiRunMetrics";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiNumberCheck } from "@/lib/ai/AiNumberCheck";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiPrompts, type AiFeature } from "@/lib/ai/AiPrompts";
import { AiGateway } from "@/lib/ai/AiGateway";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AppConfig } from "@/lib/config/AppConfig";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { type AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiModelService } from "@/lib/services/AiModelService";
import { type AiSettingsDb } from "./AiSettingsService";
import { AiWritingContext } from "./AiWritingContext";

type Env = Record<string, string | undefined>;

export type AiUsageEvent = "suggested" | "accepted" | "edited" | "accepted_with_override" | "discarded" | "blocked_phi" | "failed" | "test_succeeded" | "test_failed";

/** ai_usage_log.feature of a Test connection row (Admin > AI settings), next to draft_from_bullets and fit_for_report. */
export const AI_TEST_FEATURE = "test_connection";

export interface AiUsageRow {
  id: string;
  suggestionId: string;
  userEmail: string;
  /** Null for the New project form (no project yet). */
  projectId: string | null;
  feature: string;
  event: string;
  provider: string | null;
  model: string | null;
  inputLength: number;
  outputLength: number | null;
  numberCheckPassed: boolean | null;
  suggestedText: string | null;
  /** accepted_with_override only: how many numbers or dates were still not in the original (never the values). */
  unverifiedCount?: number | null;
  /** Item D (0059): on the run row (suggested, proposed, failed): provider-counted tokens, latency and estimated cost. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  latencyMs?: number | null;
  costUsd?: number | null;
  createdAt: Date;
}

/** Usage log and project reads (plus the settings slice). Tests pass an in-memory fake. */
export interface AiWritingDb extends AiSettingsDb {
  aiUsageLog: {
    create(args: { data: AiUsageRow }): Promise<unknown>;
    findFirst(args: { where: { suggestionId: string; userEmail: string; event?: string | { in: string[] } } }): Promise<AiUsageRow | null>;
    count(args: { where: { userEmail: string; event: { in: string[] }; createdAt: { gte: Date } } }): Promise<number>;
  };
  project: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string; serviceLineId: string; departmentId: string | null; archivedAt: Date | null } | null>;
  };
}

/** What the editor gets back. Never carries settings or the key. */
export type AiSuggestResult =
  | { ok: true; suggestionId: string; feature: AiFeature; text: string; limit: number; numbers: { ok: boolean; missing: string[] }; phiOk: boolean }
  | { ok: false; kind: "off" | "not_allowed" | "empty" | "phi" | "rate" | "timeout" | "provider"; message: string };

/** accepted_with_override: "Use this text" after Edit with the number check still failing and the box ticked. */
export type AiOutcome = "accepted" | "edited" | "accepted_with_override" | "discarded";

/** The outcomes that put the suggestion's text (as accepted or edited) into the note field (usage log, admin audit). */
const USED: readonly string[] = ["accepted", "edited", "accepted_with_override"];
const OUTCOMES: readonly string[] = [...USED, "discarded"];
/** Upper bound for the override's unverified count (a suggestion is at most 2,000 characters). */
const UNVERIFIED_MAX = 1000;

/**
 * The writing assistant (update-note editor): guard, call, check, log. It returns text only: it never writes to the
 * project, its history, milestones, reports, PDFs or handoff.json. The note changes only when the user saves the form.
 */
export class AiWritingService {
  /** Provider calls (suggested or failed) per user per minute. */
  static readonly RATE_LIMIT = 10;
  static readonly RATE_WINDOW_MS = 60_000;
  /** One request at a time per user on this instance (the DB count covers the rest). */
  private static readonly inFlight = new Set<string>();

  /** The viewer may edit this project: admin (editing is admin-only today), project in the active line and their departments. */
  static async canEdit(db: AiWritingDb, viewer: Viewer, projectId: string | null, scope: Pick<ServiceLineScope, "id" | "departmentLimit">): Promise<boolean> {
    // The New project form (null): creating a project is admin-only, so any admin may draft its first note.
    if (projectId === null) return viewer.isAdmin;
    if (!viewer.isAdmin || typeof projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(projectId)) return false;
    const p = await db.project.findUnique({ where: { id: projectId } });
    return Boolean(p) && !p!.archivedAt && ServiceLineAccess.inScope(p, scope) && DepartmentAccess.allows(scope, p!.departmentId);
  }

  static async suggest(args: {
    db: AiWritingDb;
    viewer: Viewer;
    scope: Pick<ServiceLineScope, "id" | "departmentLimit">;
    /** Null: the New project form. */
    projectId: string | null;
    feature: unknown;
    text: unknown;
    env?: Env;
    fetchImpl?: FetchLike;
    now?: () => Date;
    /** PR B: the provider keys (tests inject a fake; the app reads the Provider keys card's storage). */
    keys?: AiProviderKeySource;
  }): Promise<AiSuggestResult> {
    const { db, viewer, scope, projectId } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    const feature = AiPrompts.parseFeature(args.feature);
    const text = typeof args.text === "string" ? args.text.slice(0, AppConfig.NOTE_MAX_LENGTH) : "";
    if (!feature) return { ok: false, kind: "not_allowed", message: AiCopy.NOT_ALLOWED };
    if (!text.trim()) return { ok: false, kind: "empty", message: AiCopy.EMPTY_INPUT };
    if (!(await AiWritingService.canEdit(db, viewer, projectId, scope))) return { ok: false, kind: "not_allowed", message: AiCopy.NOT_ALLOWED };

    // PR B: Draft and Fit have their own rows (toggle and env kill switch, on by default, like the other text features).
    if (!(await AiModelService.featureOn(db, feature, env))) return { ok: false, kind: "off", message: AiCopy.unavailable(env) };
    // Item 4a: the shared guard chain (settings, feature runtime with key, allowlist). Fails closed.
    const resolved = await AiGateway.resolve({ db, feature, env, keys: args.keys });
    if (!resolved.ok) return resolved.refusal === "off" ? { ok: false, kind: "off", message: AiCopy.unavailable(env) } : { ok: false, kind: "provider", message: AiCopy.MODEL_NOT_ALLOWED };
    const config = resolved.config;

    const suggestionId = randomUUID();
    const base = { suggestionId, userEmail: viewer.email, projectId, feature, provider: config.provider, model: config.model, inputLength: text.length };
    // Item D: the call's tokens, latency and estimated cost, written on the run row once the call is back.
    let run: Partial<AiUsageRow> = {};
    const log = (event: AiUsageEvent, extra: Partial<AiUsageRow> = {}) =>
      db.aiUsageLog.create({ data: { id: randomUUID(), ...base, event, outputLength: null, numberCheckPassed: null, suggestedText: null, createdAt: now(), ...run, ...extra } });

    // PHI guard first: nothing is sent, and the blocked text is not stored.
    const phi = AiPhiGuard.check(text);
    if (!phi.ok) {
      await log("blocked_phi");
      return { ok: false, kind: "phi", message: AiCopy.phiBlocked(phi.kinds) };
    }

    if (!(await AiGateway.rateOk({ db, viewer, inFlight: AiWritingService.inFlight, events: ["suggested", "failed"], windowMs: AiWritingService.RATE_WINDOW_MS, limit: AiWritingService.RATE_LIMIT, now })))
      return { ok: false, kind: "rate", message: AiCopy.RATE_LIMITED };

    AiWritingService.inFlight.add(viewer.email);
    try {
      // Item 9: the project's facts and last 3 updates keep names, dates and terms consistent (null = text alone).
      const facts = await AiWritingContext.load({ db, scope, viewer, projectId, now });
      const result = await AiGateway.complete(config, AiPrompts.build(feature, text, facts), args.fetchImpl);
      run = AiRunMetrics.of(result, await AiModelService.priceOf(db, config.model));
      if (!result.ok) {
        await log("failed");
        // Kind and status only: no provider text is logged. The editor gets a fixed message.
        console.error("AI writing assistant: provider call failed", { kind: result.kind, status: result.status ?? null });
        return {
          ok: false,
          kind: result.kind === "timeout" ? "timeout" : "provider",
          message: result.kind === "timeout" ? AiCopy.TIMEOUT : result.kind === "length" ? AiCopy.OUT_OF_REPLY_LENGTH : AiCopy.PROVIDER_ERROR,
        };
      }
      const suggestion = AiPrompts.clean(result.text);
      const numbers = AiNumberCheck.check(text, suggestion);
      const phiOut = AiPhiGuard.check(suggestion);
      await log("suggested", { outputLength: suggestion.length, numberCheckPassed: numbers.ok, suggestedText: phiOut.ok ? suggestion : null });
      return {
        ok: true,
        suggestionId,
        feature,
        text: suggestion,
        limit: AiPrompts.limit(feature),
        numbers: numbers.ok ? { ok: true, missing: [] } : { ok: false, missing: numbers.missing },
        phiOk: phiOut.ok,
      };
    } finally {
      AiWritingService.inFlight.delete(viewer.email);
    }
  }

  /**
   * Accept, Edit (use edited text, with or without the number-check override) or Discard: one usage-log row, nothing else. In particular no ProjectHistory row, so
   * a discard can't set Changed or reset Stale. Only the user who got the suggestion can record it, once.
   */
  static async recordOutcome(db: AiWritingDb, viewer: Viewer, suggestionId: unknown, outcome: unknown, now: Date = new Date(), unverifiedCount?: unknown): Promise<boolean> {
    if (typeof suggestionId !== "string" || typeof outcome !== "string" || !OUTCOMES.includes(outcome)) return false;
    // The override row carries the count of numbers and dates the user confirmed by hand (1 or more), never the values.
    const override = outcome === "accepted_with_override";
    if (override && !(Number.isInteger(unverifiedCount) && (unverifiedCount as number) >= 1 && (unverifiedCount as number) <= UNVERIFIED_MAX)) return false;
    const suggested = await db.aiUsageLog.findFirst({ where: { suggestionId, userEmail: viewer.email, event: "suggested" } });
    if (!suggested) return false;
    const done = await db.aiUsageLog.findFirst({ where: { suggestionId, userEmail: viewer.email, event: { in: [...OUTCOMES] } } });
    if (done) return done.event === outcome;
    await db.aiUsageLog.create({
      data: {
        id: randomUUID(),
        suggestionId,
        userEmail: viewer.email,
        projectId: suggested.projectId,
        feature: suggested.feature,
        event: outcome,
        provider: suggested.provider,
        model: suggested.model,
        inputLength: suggested.inputLength,
        outputLength: suggested.outputLength,
        numberCheckPassed: suggested.numberCheckPassed,
        suggestedText: null,
        unverifiedCount: override ? (unverifiedCount as number) : null,
        createdAt: now,
      },
    });
    return true;
  }

  /**
   * Test connection on Admin > AI settings: a tiny prompt with the saved settings. Never returns the key. When `log` is
   * given, one ai_usage_log row records the call with metadata only (feature test_connection, test_succeeded or
   * test_failed, who, when, provider, model, lengths): never the key, the prompt or the reply.
   */
  static async testConnection(
    config: AiRuntimeConfig,
    fetchImpl?: FetchLike,
    log?: { db: Pick<AiWritingDb, "aiUsageLog">; viewer: Pick<Viewer, "email">; now?: () => Date },
  ): Promise<{ ok: true; ms: number } | { ok: false; message: string }> {
    const prompt = { system: "Reply with the single word OK.", user: "Connection test.", maxTokens: AiPrompts.TEST_MAX_TOKENS };
    const r = await AiProviderClient.complete(config, prompt, fetchImpl);
    // A 200 with no text still proves the endpoint, model and key work. Running out of tokens is reported plainly instead,
    // because Draft and Fit would hit the same limit.
    const ok = r.ok || r.kind === "empty";
    if (log) {
      try {
        await log.db.aiUsageLog.create({
          data: {
            id: randomUUID(),
            suggestionId: randomUUID(),
            userEmail: log.viewer.email,
            projectId: null,
            feature: AI_TEST_FEATURE,
            event: ok ? "test_succeeded" : "test_failed",
            provider: config.provider,
            model: config.model,
            inputLength: prompt.user.length,
            outputLength: r.ok ? r.text.length : null,
            numberCheckPassed: null,
            suggestedText: null,
            unverifiedCount: null,
            createdAt: (log.now ?? (() => new Date()))(),
          },
        });
      } catch (e) {
        // Logging must not change the result the admin sees; the error name only (no content).
        console.error("AI test connection: usage log failed", (e as Error)?.name);
      }
    }
    if (ok) return { ok: true, ms: r.ms };
    // r.message is the fixed AiProviderError string (provider name, HTTP status, class); no provider text.
    return { ok: false, message: r.message };
  }
}
