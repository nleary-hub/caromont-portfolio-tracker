import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiLiveClient } from "@/lib/ai/AiLiveClient";
import { AiModelKinds } from "@/lib/ai/AiModelKinds";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiRealtimeClient, type AiRealtimeFetch, type AiRealtimeTicket } from "@/lib/ai/AiRealtimeClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolChange, AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { AppConfig } from "@/lib/config/AppConfig";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiModelService, type AiModelRow } from "@/lib/services/AiModelService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiToolsService, type AiToolsDb, type AiToolUsageRow } from "@/lib/services/AiToolsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { PortfolioContextService } from "@/lib/services/PortfolioContextService";

type Env = Record<string, string | undefined>;

/**
 * Why voice chat can't start. model_off: no model chosen or it's off or not realtime (the greyed state, no connect).
 * model_unavailable: OpenAI says the key can't use the model. token: the client secret call failed. mic_denied and
 * connect_failed happen in the browser and are reported back for the log. connect_failed also comes from the server's
 * forward of the SDP offer (connect). ice_failed: the WebRTC media path never came up (network blocking live audio).
 */
export type AiVoiceErrorCode = "not_allowed" | "feature_off" | "ai_off" | "model_off" | "rate_limited" | "model_unavailable" | "token" | "mic_denied" | "no_mic" | "connect_failed" | "ice_failed";

export type AiVoiceConnectResult = { ok: true; sdp: string } | { ok: false; httpStatus: number; error: { type: string | null; code: string | null; message: string; modelUnavailable: boolean } };

export type AiVoiceStartResult = { ok: true; sessionId: string; ticket: AiRealtimeTicket; maxSeconds: number } | { ok: false; code: AiVoiceErrorCode; message: string };
export type AiVoiceProposeResult = { ok: true; proposalId: string; feature: "voice_chat"; changes: AiToolChange[] } | { ok: false; message: string };
export type AiVoiceEndResult = { ok: true; seconds: number } | { ok: false; message: string };

const FEATURE = "voice_chat";
const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Step 10: voice chat on the AI tools page. Admin only (the people who can edit projects; the app has no separate
 * editor role). The server mints a short-lived realtime client secret with the API key; the browser talks to the
 * model directly with that secret, so audio never passes through or is stored by this app.
 *
 * ai_usage_log rows (no audio, no transcript), strictly append-only: a session_started row at start (so an abandoned
 * session still leaves a record), then one session_ended row with the same suggestionId, usageSeconds and costUsd, plus the normal proposed / applied / rejected rows when the model suggests edits. Suggested edits are only listed
 * for review; applying a line goes through AiToolsService.applyLine and ProjectService.update like every text tool.
 */
export class AiVoiceChatService {
  /** Item A: the shared portfolio context for the voice session, within the voice budget (session instructions). */
  static readonly CONTEXT_TOKENS = 24_000;

  static async context(db: AiToolsDb, scope: ServiceLineScope, viewer: Viewer, projects: readonly AiToolProject[], now: () => Date): Promise<string> {
    return (await PortfolioContextService.build({ db, scope, viewer, projects, now: now(), maxTokens: AiVoiceChatService.CONTEXT_TOKENS })).text;
  }

  private static async model(db: AiToolsDb): Promise<string> {
    return AiModelService.featureModel(db, FEATURE);
  }

  /**
   * The one readiness check, shared by the page (greyed note) and start, so they can't disagree. null = ready.
   */
  static async readiness(db: AiToolsDb, env: Env = process.env): Promise<{ code: "feature_off" | "ai_off" | "model_off"; message: string; note: string } | null> {
    if (!(await AiModelService.featureOn(db, FEATURE, env))) return { code: "feature_off", message: AiToolsCopy.FEATURE_OFF, note: AiToolsCopy.FEATURE_OFF_NOTE };
    const row = await AiSettingsService.row(db, env).catch(() => null);
    if (!row?.enabled || !AiSettingsService.runtime(row, env)) return { code: "ai_off", message: AiToolsCopy.aiOff(env), note: AiToolsCopy.aiOffNote(env) };
    const model = await AiVoiceChatService.model(db);
    if (!model || !(await AiModelService.enabledIds(db, "realtime")).includes(model)) return { code: "model_off", message: AiToolsCopy.MODEL_OFF_NOTE, note: AiToolsCopy.MODEL_OFF_NOTE };
    return null;
  }

  /** Mints the browser's client secret. Saves one session_started row (lengths and model only). */
  static async start(args: { db: AiToolsDb; viewer: Viewer | null; scope: ServiceLineScope; env?: Env; fetchImpl?: AiRealtimeFetch; now?: () => Date }): Promise<AiVoiceStartResult> {
    const { db, viewer } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, code: "not_allowed", message: AiCopy.NOT_AUTHORIZED };
    // Same check as the page's note: model off means the greyed state, never a connect attempt.
    const blocked = await AiVoiceChatService.readiness(db, env);
    if (blocked) return { ok: false, code: blocked.code, message: blocked.message };
    const row = await AiSettingsService.row(db, env);
    const saved = row?.enabled ? AiSettingsService.runtime(row, env) : null;
    if (!saved) return { ok: false, code: "ai_off", message: AiToolsCopy.aiOff(env) };
    // The admin-chosen voice chat model. Never picked or switched here; it must be one an admin turned on.
    const model = await AiVoiceChatService.model(db);
    const user = viewer.email;
    const recent = await db.aiUsageLog.count({ where: { userEmail: user, event: { in: ["suggested", "failed", "proposed", "session_started"] }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } } });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, code: "rate_limited", message: AiCopy.RATE_LIMITED };

    const projects = await AiToolsService.projects(db, args.scope);
    const sessionId = randomUUID();
    // Routed by the model's kind (AiModelKinds.voiceApi): gpt-live-* on the Live API, everything else on Realtime.
    const api = AiModelKinds.voiceApi(model);
    if (api === "live" && !(await AiModelService.enabledIds(db, "chat")).includes(saved.model)) {
      // Live delegates to a Responses backend: the saved writing-assistant model, which must be a chat model that is on.
      console.error("AI tools: voice session failed", { code: "model_off", api, model, reason: "no backend chat model" });
      return { ok: false, code: "model_off", message: AiToolsCopy.VOICE_BACKEND_MODEL_OFF };
    }
    const r: Awaited<ReturnType<typeof AiRealtimeClient.mint>> =
      api === "live"
        ? // No token for the browser: the Live API has no ephemeral secret, so connect starts the session server side.
          { ok: true, ticket: { clientSecret: "", expiresAt: Math.floor(now().getTime() / 1000) + AiLiveClient.CONNECT_WINDOW_S, callsUrl: AiRealtimeClient.PROXY_PATH, model, api } }
        : await AiRealtimeClient.mint(saved, { model, instructions: AiVoiceChat.instructions(await AiVoiceChatService.context(db, args.scope, viewer, projects, now), await AiModelService.voiceInstructions(db)), tools: [AiVoiceChat.TOOL], voice: AiVoiceChat.VOICE }, args.fetchImpl);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: sessionId, userEmail: user, projectId: null, feature: FEATURE, event: r.ok ? "session_started" : "failed", provider: saved.provider, model, inputLength: projects.length, outputLength: null, numberCheckPassed: null, suggestedText: null, createdAt: now() },
    });
    if (!r.ok) {
      const code = r.modelUnavailable ? "model_unavailable" : "token";
      // The real error for the runtime log: our code, HTTP status and OpenAI's error type, code and message. No secrets.
      console.error("AI tools: voice session failed", { code, api, kind: r.kind, model, status: r.status ?? null, type: r.type ?? null, errorCode: r.code ?? null, message: r.message ?? null });
      return { ok: false, code, message: code === "model_unavailable" ? AiToolsCopy.VOICE_MODEL_UNAVAILABLE : AiToolsCopy.VOICE_TOKEN_FAILED };
    }
    return { ok: true, sessionId, ticket: r.ticket, maxSeconds: AiVoiceChat.MAX_SESSION_S };
  }

  /**
   * Hotfix: the browser's SDP offer, forwarded to OpenAI's realtime calls endpoint with the EPHEMERAL client secret the
   * browser got from start. The API key is never read here. Only the caller's own started, not ended, not failed session.
   * Any failure inserts one failed row for the session (so End leaves no session_ended row for it) and one log line with
   * the HTTP status and OpenAI's scrubbed error. The secret and SDP are never logged.
   */
  static async connect(args: { db: AiToolsDb; viewer: Viewer | null; sessionId: unknown; clientSecret: unknown; sdp: unknown; scope?: ServiceLineScope; env?: Env; fetchImpl?: AiRealtimeFetch; now?: () => Date }): Promise<AiVoiceConnectResult> {
    const { db, viewer } = args;
    const deny = (httpStatus: number, message: string): AiVoiceConnectResult => ({ ok: false, httpStatus, error: { type: null, code: null, message, modelUnavailable: false } });
    if (!viewer?.isAdmin) return deny(403, AiCopy.NOT_AUTHORIZED);
    const session = await AiVoiceChatService.session(db, viewer, args.sessionId);
    if (!session || (await AiVoiceChatService.ended(db, viewer, session.suggestionId)) || (await AiVoiceChatService.failedRow(db, viewer, session.suggestionId))) return deny(409, AiToolsCopy.VOICE_SESSION_GONE);
    const sdp = typeof args.sdp === "string" ? args.sdp : "";
    if (AiModelKinds.voiceApi(session.model ?? "") === "live") return AiVoiceChatService.connectLive({ ...args, viewer, session, sdp });
    const secret = typeof args.clientSecret === "string" ? args.clientSecret.trim() : "";
    if (!secret || secret.length > 4096 || !sdp.trim() || sdp.length > AiRealtimeClient.SDP_MAX) {
      await AiVoiceChatService.logFailure(db, viewer, session, "connect_failed", { status: 400, type: "bad_request", message: "missing or oversized offer or client secret" }, args.now);
      return deny(400, AiToolsCopy.VOICE_CONNECT_FAILED);
    }
    const r = await AiRealtimeClient.call(secret, sdp, args.fetchImpl);
    if (r.ok) return { ok: true, sdp: r.sdp };
    const code: AiVoiceErrorCode = r.modelUnavailable ? "model_unavailable" : "connect_failed";
    await AiVoiceChatService.logFailure(db, viewer, session, code, { status: r.status ?? null, type: r.type ?? r.kind, errorCode: r.code ?? null, message: r.message ?? null, source: "server" }, args.now, [secret]);
    // OpenAI's status passes through; a network failure or timeout is a 502 or 504 from us.
    const httpStatus = typeof r.status === "number" ? r.status : r.kind === "timeout" ? 504 : 502;
    return { ok: false, httpStatus, error: { type: r.type ?? r.kind, code: r.code ?? null, message: r.message ?? (code === "model_unavailable" ? AiToolsCopy.VOICE_MODEL_UNAVAILABLE : AiToolsCopy.VOICE_CONNECT_FAILED), modelUnavailable: code === "model_unavailable" } };
  }

  /**
   * The Live API path of connect (gpt-live-*). There is no ephemeral secret, so the gate is the caller's own started,
   * not ended, not failed session, started within the last AiLiveClient.CONNECT_WINDOW_S seconds. The server starts
   * the Live session with the saved API key (never sent to the browser) and returns only the SDP answer. Same failure
   * logging as Realtime: one failed row, model_unavailable for an invalid or unsupported model.
   */
  private static async connectLive(args: { db: AiToolsDb; viewer: Viewer; session: AiToolUsageRow; sdp: string; scope?: ServiceLineScope; env?: Env; fetchImpl?: AiRealtimeFetch; now?: () => Date }): Promise<AiVoiceConnectResult> {
    const { db, viewer, session, sdp } = args;
    const now = args.now ?? (() => new Date());
    const deny = (httpStatus: number, message: string): AiVoiceConnectResult => ({ ok: false, httpStatus, error: { type: null, code: null, message, modelUnavailable: false } });
    if ((now().getTime() - new Date(session.createdAt).getTime()) / 1000 > AiLiveClient.CONNECT_WINDOW_S) {
      await AiVoiceChatService.logFailure(db, viewer, session, "connect_failed", { status: 409, type: "connect_window_expired", api: "live" }, args.now);
      return deny(409, AiToolsCopy.VOICE_SESSION_GONE);
    }
    if (!sdp.trim() || sdp.length > AiRealtimeClient.SDP_MAX) {
      await AiVoiceChatService.logFailure(db, viewer, session, "connect_failed", { status: 400, type: "bad_request", message: "missing or oversized offer", api: "live" }, args.now);
      return deny(400, AiToolsCopy.VOICE_CONNECT_FAILED);
    }
    const env = args.env ?? process.env;
    const row = await AiSettingsService.row(db, env).catch(() => null);
    const saved = row?.enabled ? AiSettingsService.runtime(row, env) : null;
    if (!saved || !args.scope) {
      await AiVoiceChatService.logFailure(db, viewer, session, "connect_failed", { status: 503, type: saved ? "no_scope" : "ai_off", api: "live" }, args.now);
      return deny(503, AiToolsCopy.VOICE_CONNECT_FAILED);
    }
    const projects = await AiToolsService.projects(db, args.scope);
    const model = session.model ?? "";
    // The same instructions as the Realtime adapter (admin rules or built-in, plus tool contract, patient line, projects).
    const base = AiVoiceChat.instructions(await AiVoiceChatService.context(db, args.scope, viewer, projects, now), await AiModelService.voiceInstructions(db));
    const r = await AiLiveClient.create(saved, { model, instructions: AiVoiceChat.liveInstructions(base), voice: AiVoiceChat.VOICE, backendModel: saved.model, backendInstructions: base, tools: [AiVoiceChat.TOOL] }, sdp, args.fetchImpl);
    if (r.ok) {
      console.info("AI tools: voice live session started", { sessionId: session.suggestionId, model, backendModel: saved.model, liveSessionId: r.liveSessionId });
      return { ok: true, sdp: r.sdp };
    }
    const code: AiVoiceErrorCode = r.modelUnavailable ? "model_unavailable" : "connect_failed";
    await AiVoiceChatService.logFailure(db, viewer, session, code, { status: r.status ?? null, type: r.type ?? r.kind, errorCode: r.code ?? null, message: r.message ?? null, source: "server", api: "live" }, args.now, [saved.apiKey]);
    const httpStatus = typeof r.status === "number" ? r.status : r.kind === "timeout" ? 504 : 502;
    return { ok: false, httpStatus, error: { type: r.type ?? r.kind, code: r.code ?? null, message: r.message ?? (code === "model_unavailable" ? AiToolsCopy.VOICE_MODEL_UNAVAILABLE : AiToolsCopy.VOICE_CONNECT_FAILED), modelUnavailable: code === "model_unavailable" } };
  }

  /** One failed row per session (append-only; usageSeconds 0) plus the log line. Every value is scrubbed of keys and tokens. */
  private static async logFailure(db: AiToolsDb, viewer: Viewer, session: AiToolUsageRow, code: AiVoiceErrorCode, detail: Record<string, unknown>, now: (() => Date) | undefined, secrets: readonly string[] = []): Promise<void> {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(detail)) clean[k] = typeof v === "string" ? AiRealtimeClient.scrub(v, secrets) : v;
    console.error("AI tools: voice connect failed", { code, sessionId: session.suggestionId, model: session.model ?? null, ...clean });
    if (await AiVoiceChatService.failedRow(db, viewer, session.suggestionId)) return;
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: session.suggestionId, userEmail: viewer.email, projectId: null, feature: FEATURE, event: "failed", provider: session.provider, model: session.model, inputLength: 0, outputLength: null, numberCheckPassed: null, suggestedText: null, usageSeconds: 0, costUsd: null, createdAt: (now ?? (() => new Date()))() },
    });
  }

  private static async failedRow(db: AiToolsDb, viewer: Viewer, sessionId: string): Promise<AiToolUsageRow | null> {
    return db.aiUsageLog.findFirst({ where: { suggestionId: sessionId, userEmail: viewer.email, event: "failed" } });
  }

  /**
   * The browser reports a failure that happened after start (mic denied, connect failed, ICE failed) so it reaches the
   * runtime log. A connect, model or ICE failure on the caller's own live session also inserts the session's failed
   * row (once; the server's forward may already have written it), so End leaves no session_ended row for it.
   */
  static async reportClientFailure(db: AiToolsDb | null, viewer: Viewer | null, raw: { sessionId?: unknown; code?: unknown; status?: unknown; type?: unknown; message?: unknown }, now?: () => Date): Promise<{ ok: boolean }> {
    if (!viewer?.isAdmin) return { ok: false };
    const codes: AiVoiceErrorCode[] = ["mic_denied", "no_mic", "connect_failed", "model_unavailable", "ice_failed"];
    const code = codes.includes(raw.code as AiVoiceErrorCode) ? (raw.code as AiVoiceErrorCode) : "connect_failed";
    const s = (v: unknown) => (typeof v === "string" && v ? AiRealtimeClient.scrub(v) : null);
    const detail = { status: typeof raw.status === "number" ? raw.status : null, type: s(raw.type), message: s(raw.message), source: "browser" };
    const session = db && code !== "mic_denied" && code !== "no_mic" ? await AiVoiceChatService.session(db, viewer, raw.sessionId) : null;
    if (db && session && !(await AiVoiceChatService.ended(db, viewer, session.suggestionId))) {
      await AiVoiceChatService.logFailure(db, viewer, session, code, detail, now);
      return { ok: true };
    }
    console.error("AI tools: voice connect failed (browser)", { code, sessionId: typeof raw.sessionId === "string" && UUID.test(raw.sessionId) ? raw.sessionId : null, ...detail });
    return { ok: true };
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
    if (await AiVoiceChatService.ended(db, viewer, session.suggestionId)) return { ok: false, message: AiToolsCopy.VOICE_SESSION_GONE };
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

  private static ended(db: AiToolsDb, viewer: Viewer, sessionId: string): Promise<AiToolUsageRow | null> {
    return db.aiUsageLog.findFirst({ where: { suggestionId: sessionId, userEmail: viewer.email, event: "session_ended" } });
  }

  /**
   * Ends a session: inserts one session_ended row with the same suggestionId, the length (server clock from the
   * started row, capped at 15 minutes) and the cost from the admin-entered per-minute price. Only the caller's own
   * started session. A second End is ignored (returns the stored length); the 0048 unique index refuses a racing
   * duplicate insert.
   */
  static async end(args: { db: AiToolsDb; viewer: Viewer | null; sessionId: unknown; backendUsage?: unknown; now?: () => Date }): Promise<AiVoiceEndResult> {
    const { db, viewer } = args;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const session = await AiVoiceChatService.session(db, viewer, args.sessionId);
    if (!session) return { ok: false, message: AiToolsCopy.VOICE_SESSION_GONE };
    const done = await AiVoiceChatService.ended(db, viewer, session.suggestionId);
    if (done) return { ok: true, seconds: done.usageSeconds ?? 0 };
    // A session that failed to connect already has its failed row; it never gets a session_ended row.
    if (await AiVoiceChatService.failedRow(db, viewer, session.suggestionId)) return { ok: true, seconds: 0 };
    const at = now();
    const seconds = AiVoiceChat.seconds(session.createdAt, at);
    const price = await AiVoiceChatService.price(db, session.model ?? "");
    const live = AiModelKinds.voiceApi(session.model ?? "") === "live";
    // Live: duration pricing (per-minute price times seconds, billed per second). Realtime: the admin per-minute price.
    const costUsd = live ? AiLiveClient.cost(seconds, AiLiveClient.pricePerMinute(price?.priceUnit, price?.inputPrice)) : AiVoiceChat.cost(seconds, price?.priceUnit, price?.inputPrice);
    // Backend Responses usage is billed separately by OpenAI, so it is logged on its own line, never folded into the session row.
    const backend = live ? AiLiveClient.cleanUsage(args.backendUsage) : null;
    if (backend) console.info("AI tools: voice live backend usage", { sessionId: session.suggestionId, model: session.model ?? null, ...backend });
    try {
      await db.aiUsageLog.create({
        data: { id: randomUUID(), suggestionId: session.suggestionId, userEmail: viewer.email, projectId: null, feature: FEATURE, event: "session_ended", provider: session.provider, model: session.model, inputLength: 0, outputLength: null, numberCheckPassed: null, suggestedText: null, usageSeconds: seconds, costUsd, createdAt: at },
      });
    } catch (e) {
      // Ended in parallel (the unique index refused the second row): report what is stored.
      const again = await AiVoiceChatService.ended(db, viewer, session.suggestionId);
      if (!again) throw e;
      return { ok: true, seconds: again.usageSeconds ?? 0 };
    }
    return { ok: true, seconds };
  }

  /** Totals pair each session_started row with its session_ended row; a start with no end is abandoned. */
  static pair(rows: readonly AiToolUsageRow[]): { sessionId: string; userEmail: string; model: string | null; startedAt: Date; seconds: number | null; costUsd: number | null; abandoned: boolean }[] {
    const ends = new Map<string, AiToolUsageRow>();
    for (const r of rows) if (r.feature === FEATURE && r.event === "session_ended" && !ends.has(r.suggestionId)) ends.set(r.suggestionId, r);
    return rows
      .filter((r) => r.feature === FEATURE && r.event === "session_started")
      .map((s) => {
        const e = ends.get(s.suggestionId);
        const cost = e?.costUsd;
        return { sessionId: s.suggestionId, userEmail: s.userEmail, model: s.model, startedAt: s.createdAt, seconds: e?.usageSeconds ?? null, costUsd: cost === undefined || cost === null ? null : Number(cost), abandoned: !e };
      });
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
