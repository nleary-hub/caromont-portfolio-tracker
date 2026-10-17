import { AiFeatureFlags, type AiToggleFeature, type AiWritingToggle } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiModelService, type AiModelDb } from "@/lib/services/AiModelService";
import { AiFeatureRuntime, AiProviderKeyAccess } from "@/lib/services/AiFeatureProviderService";
import { AiSettingsService, type AiSettingsDb } from "@/lib/services/AiSettingsService";
import type { AiToolsDb } from "@/lib/services/AiToolsService";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";

type Env = Record<string, string | undefined>;

/**
 * Why an AI tool can't run right now, for the disabled note under its button (null = ready). The server re-checks
 * everything on each call; this only decides what the page shows.
 */
export class AiToolsReadiness {
  static async notes(db: AiModelDb & AiSettingsDb, features: readonly AiToggleFeature[], env: Env = process.env): Promise<Record<string, string | null>> {
    const row = await AiSettingsService.row(db, env).catch(() => null);
    const enabled = await AiModelService.enabledIds(db, "chat");
    // PR B: a feature with its own model is ready when that model is on; the rest use the AI settings model, as before.
    const rows = await AiFeatureRuntime.rows(db);
    // CTO item 4: a feature whose provider has no saved key row (existence only, no live test call) is unavailable.
    const saved = await AiProviderKeyAccess.savedProviders(db);
    const choices = Object.fromEntries(features.map((f) => [f, AiFeatureRuntime.choiceOf(f, rows)]));
    const note = (f: AiToggleFeature) => {
      if (AiToolsCopy.isPreview(env)) return AiToolsCopy.PREVIEW_OFF_NOTE;
      if (!row?.enabled) return AiToolsCopy.AI_OFF_NOTE;
      const provider = AiFeatureRuntime.providerOf(f, choices, row.provider ?? "");
      if (provider && !saved.has(provider)) return AiToolsCopy.noKeyNote(provider);
      const model = AiFeatureRuntime.modelFor(f, rows, row);
      return !model || !enabled.includes(model) ? AiToolsCopy.MODEL_OFF_NOTE : null;
    };
    const out: Record<string, string | null> = {};
    for (const f of features) out[f] = (await AiModelService.featureOn(db, f, env)) ? note(f) : AiToolsCopy.FEATURE_OFF_NOTE;
    return out;
  }

  /**
   * PR B: the writing assistant's Draft and Fit buttons. `shown`: the ones that are on (a toggle or env kill switch that
   * is off hides that button, like the other features). `paused`: today's single model-off state (both shown buttons
   * follow the AI settings model and it is off; `mainPaused` is the page's existing check, so that path is unchanged).
   * `unavailable`: a note per button that can't run for its own reason: no saved key for its provider (CTO item 4), or
   * its own model is off. A feature with no model of its own keeps today's rules.
   */
  static async writing(db: AiModelDb & AiSettingsDb, mainPaused: boolean, env: Env = process.env): Promise<{ shown: AiWritingToggle[]; paused: boolean; unavailable: Partial<Record<AiWritingToggle, string>> }> {
    const notes = await AiToolsReadiness.notes(db, AiFeatureFlags.WRITING_FEATURES, env);
    const rows = await AiFeatureRuntime.rows(db);
    const shown = AiFeatureFlags.WRITING_FEATURES.filter((f) => notes[f] !== AiToolsCopy.FEATURE_OFF_NOTE);
    const unavailable: Partial<Record<AiWritingToggle, string>> = {};
    const followsMainPaused: AiWritingToggle[] = [];
    for (const f of shown) {
      const note = notes[f];
      const own = AiFeatureRuntime.choiceOf(f, rows).model;
      if (AiToolsCopy.isNoKeyNote(note)) unavailable[f] = note!;
      else if (own) {
        if (note === AiToolsCopy.MODEL_OFF_NOTE) unavailable[f] = AiToolsCopy.MODEL_OFF_NOTE;
      } else if (mainPaused) followsMainPaused.push(f);
    }
    const paused = shown.length > 0 && followsMainPaused.length === shown.length;
    if (!paused) for (const f of followsMainPaused) unavailable[f] = AiToolsCopy.MODEL_OFF_NOTE;
    return { shown, paused, unavailable };
  }

  /** Step 6: the Dictate button's note (null = ready). Dictation uses its own model, not the text model. */
  static async dictationNote(db: AiModelDb & AiSettingsDb, env: Env = process.env): Promise<string | null> {
    if (!(await AiModelService.featureOn(db, "dictation", env))) return AiToolsCopy.FEATURE_OFF_NOTE;
    const row = await AiSettingsService.row(db, env).catch(() => null);
    if (AiToolsCopy.isPreview(env)) return AiToolsCopy.PREVIEW_OFF_NOTE;
    if (!row?.enabled) return AiToolsCopy.AI_OFF_NOTE;
    const model = await AiModelService.featureModel(db, "dictation");
    if (!model) return AiToolsCopy.DICTATION_NO_MODEL;
    return (await AiModelService.enabledIds(db, "transcription")).includes(model) ? null : AiToolsCopy.MODEL_OFF_NOTE;
  }

  /**
   * Step 10: voice chat's note (null = ready). Feature off hides the card (FEATURE_OFF_NOTE); AI off, no model chosen
   * or the chosen model turned off greys it with the shared model-off note.
   */
  static async voiceChatNote(db: AiModelDb & AiSettingsDb, env: Env = process.env): Promise<string | null> {
    // The same check start runs (AiVoiceChatService.readiness), so the page and the action always agree.
    return (await AiVoiceChatService.readiness(db as unknown as AiToolsDb, env))?.note ?? null;
  }
}

/**
 * The dashboard's AI placements: each feature's note, with features that are off left out (not rendered, no gap).
 * null = ready; a note = shown greyed with it (model off). AI off altogether = nothing (the caller skips this).
 */
export class AiPlacementData {
  /** related_links is not placed anywhere (it saved related projects as Blocked by); its flag key stays for settings history. */
  static readonly FEATURES = ["meeting_notes", "bulk_edit", "quick_capture", "next_step", "meeting_brief"] as const;

  static async load(db: AiModelDb & AiSettingsDb, env: Env = process.env): Promise<Partial<Record<(typeof AiPlacementData.FEATURES)[number] | "dictation", string | null>>> {
    const notes = await AiToolsReadiness.notes(db, AiPlacementData.FEATURES, env);
    const out: Partial<Record<string, string | null>> = {};
    for (const f of AiPlacementData.FEATURES) if (notes[f] !== AiToolsCopy.FEATURE_OFF_NOTE && notes[f] !== AiToolsCopy.AI_OFF_NOTE) out[f] = notes[f] ?? null;
    const dictation = await AiToolsReadiness.dictationNote(db, env);
    if (dictation !== AiToolsCopy.FEATURE_OFF_NOTE && dictation !== AiToolsCopy.AI_OFF_NOTE) out.dictation = dictation === AiToolsCopy.DICTATION_NO_MODEL ? AiToolsCopy.MODEL_OFF_NOTE : dictation;
    return out;
  }
}
