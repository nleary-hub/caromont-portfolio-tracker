import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureProviders } from "@/lib/ai/AiFeatureProviders";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiPrompts } from "@/lib/ai/AiPrompts";
import { AiProviderClient, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiRunMetrics, type AiModelPrice } from "@/lib/ai/AiRunMetrics";
import { AiSpeechClient, type AiSpeechFetch } from "@/lib/ai/AiSpeechClient";
import { XaiSpeechClient } from "@/lib/ai/XaiSpeechClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiTranscriptionClient, type AiTranscribeFetch } from "@/lib/ai/AiTranscriptionClient";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiFeatureRuntime, AiProviderKeyAccess } from "@/lib/services/AiFeatureProviderService";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiProviderKeyService } from "@/lib/services/AiProviderKeyService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiSpendCapService } from "@/lib/services/AiSpendCapService";
import { AiToolsService, type AiToolsDb } from "@/lib/services/AiToolsService";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";
import { AiWritingService } from "@/lib/services/AiWritingService";

type Env = Record<string, string | undefined>;

export type AiSpokenTurnResult =
  | { ok: true; text: string; audioBase64: string | null; audioNote: string | null; heard: string }
  | { ok: false; message: string };

/**
 * One spoken turn when voice chat's conversation model is Anthropic.
 *
 * Anthropic does not accept audio (Messages API, checked Nov 2026). OpenAI transcribes the recording,
 * Anthropic writes the answer, and OpenAI's Speech API speaks it. Each part is logged on its own company
 * so the per-provider cap sees it. Project edits stay on OpenAI speech-to-speech; this path only answers.
 */
export class AiSpokenTurnService {
  static async turn(args: {
    db: AiToolsDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    audio: unknown;
    env?: Env;
    transcribeImpl?: AiTranscribeFetch;
    completeImpl?: FetchLike;
    speakImpl?: AiSpeechFetch;
    now?: () => Date;
  }): Promise<AiSpokenTurnResult> {
    const { db, viewer } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const blocked = await AiVoiceChatService.readiness(db, env);
    if (blocked) return { ok: false, message: blocked.message };
    const choice = AiFeatureRuntime.choiceOf("voice_chat", await AiFeatureRuntime.rows(db));
    if (choice.provider === "xai") return AiSpokenTurnService.xai(args, choice.model, env, now);
    if (choice.provider !== "anthropic") return { ok: false, message: AiCopy.VOICE_OPENAI_ONLY };
    const audio = args.audio as Blob | null;
    if (!audio || typeof audio !== "object" || typeof audio.size !== "number" || typeof audio.type !== "string" || !AiTranscriptionClient.acceptable(audio.type, audio.size)) return { ok: false, message: AiToolsCopy.DICTATION_FAILED };
    const row = await AiSettingsService.storedRow(db).catch(() => null);
    const openai = row?.enabled ? await AiProviderKeyService.openAiRuntime(db, "", env) : null;
    const anthropic = await AiProviderKeyAccess.source(db, env).secret("anthropic").catch(() => null);
    if (!openai || !anthropic) return { ok: false, message: AiToolsCopy.aiOff(env) };
    const dictation = await AiModelService.openAiTranscriptionModel(db);
    if (!dictation) return { ok: false, message: AiToolsCopy.VOICE_ANTHROPIC_NEED_DICTATION };
    const user = viewer.email;
    const recent = await db.aiUsageLog.count({ where: { userEmail: user, event: { in: ["suggested", "failed", "proposed", "session_started"] }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } } });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, message: AiCopy.RATE_LIMITED };
    for (const provider of ["openai", "anthropic"] as const) {
      const spend = await AiSpendCapService.check({ db, provider, email: user, env, now });
      if (!spend.ok) return { ok: false, message: spend.message };
    }
    const heard = await AiTranscriptionClient.transcribeTimed(openai, dictation, audio, args.transcribeImpl ?? (fetch as unknown as AiTranscribeFetch));
    const sttPrice = await AiModelService.priceOf(db, dictation);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: randomUUID(), userEmail: user, projectId: null, feature: "voice_chat", event: heard.ok ? "proposed" : "failed", provider: "openai", model: dictation, inputLength: audio.size, outputLength: heard.ok ? heard.text.length : null, numberCheckPassed: null, suggestedText: null, costUsd: heard.ok ? AiSpeechClient.cost(sttPrice, { seconds: heard.durationSeconds }) : null, createdAt: now() },
    });
    if (!heard.ok) return { ok: false, message: AiToolsCopy.DICTATION_FAILED };
    const phi = AiPhiGuard.check(heard.text);
    if (!phi.ok) return { ok: false, message: AiCopy.phiBlocked(phi.kinds) };
    const projects = await AiToolsService.projects(db, args.scope);
    const system = `${AiVoiceChat.instructions(projects, await AiModelService.voiceInstructions(db))}\nAnswer in plain sentences that will be read aloud. You cannot change projects from this conversation.`;
    const allowed = await AiModelService.enabledIds(db, "chat");
    const config = AiFeatureProviders.runtime("anthropic", choice.model, anthropic);
    if (!config) return { ok: false, message: AiToolsCopy.aiOff(env) };
    const result = await AiProviderClient.complete({ ...config, allowedModels: allowed }, { system, user: heard.text, maxTokens: AiPrompts.TEST_MAX_TOKENS }, args.completeImpl);
    const price = await AiModelService.priceOf(db, choice.model);
    const run = AiRunMetrics.of(result, price);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: randomUUID(), userEmail: user, projectId: null, feature: "voice_chat", event: result.ok ? "suggested" : "failed", provider: "anthropic", model: choice.model, inputLength: heard.text.length, outputLength: result.ok ? result.text.length : null, numberCheckPassed: null, suggestedText: null, createdAt: now(), inputTokens: run.inputTokens, outputTokens: run.outputTokens, latencyMs: run.latencyMs, costUsd: run.costUsd },
    });
    if (!result.ok) return { ok: false, message: AiToolsCopy.VOICE_START_FAILED };
    const speech = await AiSpeechClient.speak(openai.apiKey, result.text, args.speakImpl);
    const ttsPrice = await AiModelService.priceOf(db, AiSpeechClient.MODEL);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: randomUUID(), userEmail: user, projectId: null, feature: "voice_chat", event: speech.ok ? "proposed" : "failed", provider: "openai", model: AiSpeechClient.MODEL, inputLength: result.text.length, outputLength: speech.ok ? result.text.length : null, numberCheckPassed: null, suggestedText: null, costUsd: speech.ok ? AiSpokenTurnService.speechCost(ttsPrice, result.text.length) : null, createdAt: now() },
    });
    return { ok: true, text: result.text, heard: heard.text, audioBase64: speech.ok ? speech.base64 : null, audioNote: speech.ok ? null : AiToolsCopy.VOICE_SPEAK_FAILED };
  }

  /** Text-to-speech is billed from the characters spoken when that model's saved price is per 1M tokens. */
  private static speechCost(price: AiModelPrice | null, characters: number): number | null {
    return AiSpeechClient.cost(price, { characters });
  }

  /** xAI transcribes, writes the answer, and speaks it. Every row is logged as xAI so the xAI cap sees it. */
  private static async xai(args: { db: AiToolsDb; viewer: Viewer | null; scope: ServiceLineScope; audio: unknown; env?: Env; transcribeImpl?: AiTranscribeFetch; completeImpl?: FetchLike; speakImpl?: AiSpeechFetch; now?: () => Date }, model: string, env: Env, now: () => Date): Promise<AiSpokenTurnResult> {
    const { db, viewer } = args;
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const audio = args.audio as Blob | null;
    if (!audio || typeof audio !== "object" || typeof audio.size !== "number" || typeof audio.type !== "string" || !AiTranscriptionClient.acceptable(audio.type, audio.size)) return { ok: false, message: AiToolsCopy.DICTATION_FAILED };
    const secret = await AiProviderKeyAccess.source(db, env).secret("xai").catch(() => null);
    if (!secret) return { ok: false, message: AiToolsCopy.aiOff(env) };
    const user = viewer.email;
    const recent = await db.aiUsageLog.count({ where: { userEmail: user, event: { in: ["suggested", "failed", "proposed", "session_started"] }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } } });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, message: AiCopy.RATE_LIMITED };
    const spend = await AiSpendCapService.check({ db, provider: "xai", email: user, env, now });
    if (!spend.ok) return { ok: false, message: spend.message };
    const heard = await XaiSpeechClient.transcribe(secret.apiKey, XaiSpeechClient.STT_MODEL, audio, args.transcribeImpl ?? (fetch as unknown as AiTranscribeFetch));
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: randomUUID(), userEmail: user, projectId: null, feature: "voice_chat", event: heard.ok ? "proposed" : "failed", provider: "xai", model: XaiSpeechClient.STT_MODEL, inputLength: audio.size, outputLength: heard.ok ? heard.text.length : null, numberCheckPassed: null, suggestedText: null, costUsd: heard.ok ? XaiSpeechClient.sttCost(heard.durationSeconds) : null, createdAt: now() },
    });
    if (!heard.ok) return { ok: false, message: AiToolsCopy.DICTATION_FAILED };
    const phi = AiPhiGuard.check(heard.text);
    if (!phi.ok) return { ok: false, message: AiCopy.phiBlocked(phi.kinds) };
    const projects = await AiToolsService.projects(db, args.scope);
    const system = `${AiVoiceChat.instructions(projects, await AiModelService.voiceInstructions(db))}\nAnswer in plain sentences that will be read aloud. You cannot change projects from this conversation.`;
    const allowed = await AiModelService.enabledIds(db, "chat");
    const config = AiFeatureProviders.runtime("xai", model, secret);
    if (!config) return { ok: false, message: AiToolsCopy.aiOff(env) };
    const result = await AiProviderClient.complete({ ...config, allowedModels: allowed }, { system, user: heard.text, maxTokens: AiPrompts.TEST_MAX_TOKENS }, args.completeImpl);
    const price = await AiModelService.priceOf(db, model);
    const run = AiRunMetrics.of(result, price);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: randomUUID(), userEmail: user, projectId: null, feature: "voice_chat", event: result.ok ? "suggested" : "failed", provider: "xai", model, inputLength: heard.text.length, outputLength: result.ok ? result.text.length : null, numberCheckPassed: null, suggestedText: null, createdAt: now(), inputTokens: run.inputTokens, outputTokens: run.outputTokens, latencyMs: run.latencyMs, costUsd: run.costUsd },
    });
    if (!result.ok) return { ok: false, message: AiToolsCopy.VOICE_START_FAILED };
    const speech = args.speakImpl ? await XaiSpeechClient.speak(secret.apiKey, result.text, args.speakImpl) : await XaiSpeechClient.speak(secret.apiKey, result.text, fetch as unknown as AiSpeechFetch);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: randomUUID(), userEmail: user, projectId: null, feature: "voice_chat", event: speech.ok ? "proposed" : "failed", provider: "xai", model: "xai-tts", inputLength: result.text.length, outputLength: speech.ok ? result.text.length : null, numberCheckPassed: null, suggestedText: null, costUsd: XaiSpeechClient.ttsCost(result.text.length), createdAt: now() },
    });
    return { ok: true, text: result.text, heard: heard.text, audioBase64: speech.ok ? speech.base64 : null, audioNote: speech.ok ? null : AiToolsCopy.VOICE_SPEAK_FAILED };
  }
}
