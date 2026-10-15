import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiRealtimeClient, type AiRealtimeFetch, type AiRealtimeTicket } from "@/lib/ai/AiRealtimeClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange } from "@/lib/ai/AiToolsModel";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AppConfig } from "@/lib/config/AppConfig";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiModelService, type AiModelRow } from "@/lib/services/AiModelService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiToolsService, type AiToolsDb, type AiToolUsageRow } from "@/lib/services/AiToolsService";
import { AiWritingService } from "@/lib/services/AiWritingService";

type Env = Record<string, string | undefined>;

export type AiVoiceStartResult = { ok: true; sessionId: string; ticket: AiRealtimeTicket; maxSeconds: number } | { ok: false; message: string };
export type AiVoiceProposeResult = { ok: true; proposalId: string; feature: "voice_chat"; changes: AiToolChange[] } | { ok: false; message: string };
export type AiVoiceEndResult = { ok: true; seconds: number } | { ok: false; message: string };

const FEATURE = "voice_chat";

/** AiToolsDb plus the one update voice chat makes (0048 allows only filling usageSeconds and costUsd once). */
export type AiVoiceDb = AiToolsDb & {
  aiUsageLog: AiToolsDb["aiUsageLog"] & {
    updateMany(args: { where: { id: string; userEmail: string; feature: string; event: string; usageSeconds: null }; data: { usageSeconds: number; costUsd: number | null } }): Promise<{ count: number }>;
  };
};
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Step 10: voice chat on the AI tools page. Admin only (the people who can edit projects; the app has no separate
 * editor role). The server mints a short-lived realtime client secret with the API key; the browser talks to the
 * model directly with that secret, so audio never passes through or is stored by this app.
 *
 * ai_usage_log rows (no audio, no transcript): ONE session_started row written at start (so an abandoned session
 * still leaves a record), updated once at End chat with usageSeconds and costUsd (0048 allows only that update), plus the normal proposed / applied / rejected rows when the model suggests edits. Suggested edits are only listed
 * for review; applying a line goes through AiToolsService.applyLine and ProjectService.update like every text tool.
 */
export class AiVoiceChatService {
  private static async model(db: AiToolsDb): Promise<string> {
    return AiModelService.featureModel(db, FEATURE);
  }

  /** Mints the browser's client secret. Saves one session_started row (lengths and model only). */
  static async start(args: { db: AiToolsDb; viewer: Viewer | null; scope: ServiceLineScope; env?: Env; fetchImpl?: AiRealtimeFetch; now?: () => Date }): Promise<AiVoiceStartResult> {
    const { db, viewer } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    if (!(await AiModelService.featureOn(db, FEATURE, env))) return { ok: false, message: AiToolsCopy.FEATURE_OFF };
    const row = await AiSettingsService.row(db).catch(() => null);
    const saved = row?.enabled ? AiSettingsService.runtime(row, env) : null;
    if (!saved) return { ok: false, message: AiToolsCopy.AI_OFF };
    // The admin-chosen voice chat model. Never picked or switched here; it must be one an admin turned on.
    const model = await AiVoiceChatService.model(db);
    if (!model || !(await AiModelService.enabledIds(db)).includes(model)) return { ok: false, message: AiToolsCopy.MODEL_OFF_NOTE };
    const user = viewer.email;
    const recent = await db.aiUsageLog.count({ where: { userEmail: user, event: { in: ["suggested", "failed", "proposed", "session_started"] }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } } });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, message: AiCopy.RATE_LIMITED };

    const projects = await AiToolsService.projects(db, args.scope);
    const sessionId = randomUUID();
    const r = await AiRealtimeClient.mint(saved, { model, instructions: AiVoiceChat.instructions(projects), tools: [AiVoiceChat.TOOL], voice: AiVoiceChat.VOICE }, args.fetchImpl);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: sessionId, userEmail: user, projectId: null, feature: FEATURE, event: r.ok ? "session_started" : "failed", provider: saved.provider, model, inputLength: projects.length, outputLength: null, numberCheckPassed: null, suggestedText: null, createdAt: now() },
    });
    if (!r.ok) {
      console.error("AI tools: voice session failed", { kind: r.kind });
      return { ok: false, message: AiToolsCopy.VOICE_START_FAILED };
    }
    return { ok: true, sessionId, ticket: r.ticket, maxSeconds: AiVoiceChat.MAX_SESSION_S };
  }

  private static async session(db: AiToolsDb, viewer: Viewer, sessionId: unknown): Promise<AiToolUsageRow | null> {
    if (typeof sessionId !== "string" || !UUID.test(sessionId)) return null;
    const row = await db.aiUsageLog.findFirst({ where: { suggestionId: sessionId, userEmail: viewer.email, event: "session_started" } });
    return row && row.feature === FEATURE ? row : null;
  }

  /**
   * The model's suggest_project_changes call becomes review lines. Only projects the viewer can see now. Saves
   * nothing but the proposed row (the same row the text tools write), so Apply and Reject work unchanged.
   */
  static async propose(args: { db: AiToolsDb; viewer: Viewer | null; scope: ServiceLineScope; sessionId: unknown; toolArgs: unknown; env?: Env; now?: () => Date }): Promise<AiVoiceProposeResult> {
    const { db, viewer } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    if (!(await AiModelService.featureOn(db, FEATURE, env))) return { ok: false, message: AiToolsCopy.FEATURE_OFF };
    const session = await AiVoiceChatService.session(db, viewer, args.sessionId);
    if (!session) return { ok: false, message: AiToolsCopy.VOICE_SESSION_GONE };
    if (session.usageSeconds !== null && session.usageSeconds !== undefined) return { ok: false, message: AiToolsCopy.VOICE_SESSION_GONE };
    const projects = await AiToolsService.projects(db, args.scope);
    const changes = AiVoiceChat.parseToolArgs(args.toolArgs, projects);
    const proposalId = randomUUID();
    const kept = changes ? JSON.stringify(changes) : "";
    await db.aiUsageLog.create({
      data: {
        id: randomUUID(),
        suggestionId: proposalId,
        userEmail: viewer.email,
        projectId: null,
        feature: FEATURE,
        event: changes ? "proposed" : "failed",
        provider: session.provider,
        model: session.model,
        inputLength: typeof args.toolArgs === "string" ? args.toolArgs.length : 0,
        outputLength: changes ? changes.length : null,
        numberCheckPassed: null,
        // The same as the text tools: the checked lines (never a transcript), only when the PHI guard passes.
        suggestedText: changes && AiPhiGuard.check(kept).ok ? kept.slice(0, AppConfig.NOTE_MAX_LENGTH * 10) : null,
        createdAt: now(),
      },
    });
    if (!changes) return { ok: false, message: AiToolsCopy.PARSE_FAILED };
    return { ok: true, proposalId, feature: FEATURE, changes };
  }

  /**
   * Ends a session: fills usageSeconds (server clock from the start row, capped at 15 minutes) and costUsd (the
   * admin-entered per-minute price) on the caller's own session_started row. Idempotent: the update only matches a
   * row that has no usageSeconds yet, so a second End changes nothing.
   */
  static async end(args: { db: AiVoiceDb; viewer: Viewer | null; sessionId: unknown; now?: () => Date }): Promise<AiVoiceEndResult> {
    const { db, viewer } = args;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const session = await AiVoiceChatService.session(db, viewer, args.sessionId);
    if (!session) return { ok: false, message: AiToolsCopy.VOICE_SESSION_GONE };
    if (session.usageSeconds !== null && session.usageSeconds !== undefined) return { ok: true, seconds: session.usageSeconds };
    const seconds = AiVoiceChat.seconds(session.createdAt, now());
    const price = await AiVoiceChatService.price(db, session.model ?? "");
    const r = await db.aiUsageLog.updateMany({
      where: { id: session.id, userEmail: viewer.email, feature: FEATURE, event: "session_started", usageSeconds: null },
      data: { usageSeconds: seconds, costUsd: AiVoiceChat.cost(seconds, price?.priceUnit, price?.inputPrice) },
    });
    if (r.count === 0) {
      // Ended in parallel: report what is stored.
      const again = await AiVoiceChatService.session(db, viewer, args.sessionId);
      return { ok: true, seconds: again?.usageSeconds ?? seconds };
    }
    return { ok: true, seconds };
  }

  private static async price(db: AiToolsDb, model: string): Promise<Pick<AiModelRow, "priceUnit" | "inputPrice"> | null> {
    try {
      const m = (db as unknown as { aiModel?: { findMany(a: object): Promise<AiModelRow[]> } }).aiModel;
      return (await m?.findMany({ orderBy: { id: "asc" } }))?.find((r) => r.id === model) ?? null;
    } catch {
      return null;
    }
  }
}
