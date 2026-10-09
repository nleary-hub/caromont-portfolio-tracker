import { randomUUID } from "node:crypto";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiNumberCheck } from "@/lib/ai/AiNumberCheck";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiPrompts, type AiFeature } from "@/lib/ai/AiPrompts";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AppConfig } from "@/lib/config/AppConfig";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiSettingsService, type AiSettingsDb } from "./AiSettingsService";

type Env = Record<string, string | undefined>;

export type AiUsageEvent = "suggested" | "accepted" | "edited" | "accepted_with_override" | "discarded" | "blocked_phi" | "failed";

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
  }): Promise<AiSuggestResult> {
    const { db, viewer, scope, projectId } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    const feature = AiPrompts.parseFeature(args.feature);
    const text = typeof args.text === "string" ? args.text.slice(0, AppConfig.NOTE_MAX_LENGTH) : "";
    if (!feature) return { ok: false, kind: "not_allowed", message: AiCopy.NOT_ALLOWED };
    if (!text.trim()) return { ok: false, kind: "empty", message: AiCopy.EMPTY_INPUT };
    if (!(await AiWritingService.canEdit(db, viewer, projectId, scope))) return { ok: false, kind: "not_allowed", message: AiCopy.NOT_ALLOWED };

    const row = await AiSettingsService.row(db).catch(() => null);
    const config = row?.enabled ? AiSettingsService.runtime(row, env) : null;
    if (!config) return { ok: false, kind: "off", message: AiCopy.UNAVAILABLE };

    const suggestionId = randomUUID();
    const base = { suggestionId, userEmail: viewer.email, projectId, feature, provider: config.provider, model: config.model, inputLength: text.length };
    const log = (event: AiUsageEvent, extra: Partial<AiUsageRow> = {}) =>
      db.aiUsageLog.create({ data: { id: randomUUID(), ...base, event, outputLength: null, numberCheckPassed: null, suggestedText: null, createdAt: now(), ...extra } });

    // PHI guard first: nothing is sent, and the blocked text is not stored.
    const phi = AiPhiGuard.check(text);
    if (!phi.ok) {
      await log("blocked_phi");
      return { ok: false, kind: "phi", message: AiCopy.phiBlocked(phi.kinds) };
    }

    if (AiWritingService.inFlight.has(viewer.email)) return { ok: false, kind: "rate", message: AiCopy.RATE_LIMITED };
    const recent = await db.aiUsageLog.count({
      where: { userEmail: viewer.email, event: { in: ["suggested", "failed"] }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } },
    });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, kind: "rate", message: AiCopy.RATE_LIMITED };

    AiWritingService.inFlight.add(viewer.email);
    try {
      const result = await AiProviderClient.complete(config, AiPrompts.build(feature, text), args.fetchImpl);
      if (!result.ok) {
        await log("failed");
        // The provider's message stays on the server (scrubbed of the key); the editor gets a friendly one.
        console.error("AI writing assistant: provider call failed", { kind: result.kind, status: result.status, message: result.message });
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

  /** Test connection on Admin > AI settings: a tiny prompt with the saved settings. Never returns the key. */
  static async testConnection(config: AiRuntimeConfig, fetchImpl?: FetchLike): Promise<{ ok: true; ms: number } | { ok: false; message: string }> {
    const r = await AiProviderClient.complete(config, { system: "Reply with the single word OK.", user: "Connection test.", maxTokens: AiPrompts.TEST_MAX_TOKENS }, fetchImpl);
    // A 200 with no text still proves the endpoint, model and key work. Running out of tokens is reported plainly instead,
    // because Draft and Fit would hit the same limit.
    if (r.ok || r.kind === "empty") return { ok: true, ms: r.ms };
    const message = r.kind === "timeout" ? `Timed out after ${AiProviderClient.TIMEOUT_MS / 1000} s` : r.message;
    return { ok: false, message: AiProviderClient.scrub(message, config.apiKey) };
  }
}
