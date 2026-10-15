import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiModelService, type AiModelDb } from "@/lib/services/AiModelService";
import { AiSettingsService, type AiSettingsDb } from "@/lib/services/AiSettingsService";

type Env = Record<string, string | undefined>;

/**
 * Why an AI tool can't run right now, for the disabled note under its button (null = ready). The server re-checks
 * everything on each call; this only decides what the page shows.
 */
export class AiToolsReadiness {
  static async notes(db: AiModelDb & AiSettingsDb, features: readonly AiToggleFeature[], env: Env = process.env): Promise<Record<string, string | null>> {
    const row = await AiSettingsService.row(db).catch(() => null);
    const enabled = await AiModelService.enabledIds(db, "chat");
    const model = (row?.model ?? "").trim();
    const base = !row?.enabled ? AiToolsCopy.AI_OFF_NOTE : !model || !enabled.includes(model) ? AiToolsCopy.MODEL_OFF_NOTE : null;
    const out: Record<string, string | null> = {};
    for (const f of features) out[f] = (await AiModelService.featureOn(db, f, env)) ? base : AiToolsCopy.FEATURE_OFF_NOTE;
    return out;
  }

  /** Step 6: the Dictate button's note (null = ready). Dictation uses its own model, not the text model. */
  static async dictationNote(db: AiModelDb & AiSettingsDb, env: Env = process.env): Promise<string | null> {
    if (!(await AiModelService.featureOn(db, "dictation", env))) return AiToolsCopy.FEATURE_OFF_NOTE;
    const row = await AiSettingsService.row(db).catch(() => null);
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
    if (!(await AiModelService.featureOn(db, "voice_chat", env))) return AiToolsCopy.FEATURE_OFF_NOTE;
    const row = await AiSettingsService.row(db).catch(() => null);
    if (!row?.enabled) return AiToolsCopy.AI_OFF_NOTE;
    const model = await AiModelService.featureModel(db, "voice_chat");
    return model && (await AiModelService.enabledIds(db, "realtime")).includes(model) ? null : AiToolsCopy.MODEL_OFF_NOTE;
  }
}

/**
 * The dashboard's AI placements: each feature's note, with features that are off left out (not rendered, no gap).
 * null = ready; a note = shown greyed with it (model off). AI off altogether = nothing (the caller skips this).
 */
export class AiPlacementData {
  static readonly FEATURES = ["meeting_notes", "bulk_edit", "quick_capture", "next_step", "meeting_brief", "related_links"] as const;

  static async load(db: AiModelDb & AiSettingsDb, env: Env = process.env): Promise<Partial<Record<(typeof AiPlacementData.FEATURES)[number] | "dictation", string | null>>> {
    const notes = await AiToolsReadiness.notes(db, AiPlacementData.FEATURES, env);
    const out: Partial<Record<string, string | null>> = {};
    for (const f of AiPlacementData.FEATURES) if (notes[f] !== AiToolsCopy.FEATURE_OFF_NOTE && notes[f] !== AiToolsCopy.AI_OFF_NOTE) out[f] = notes[f] ?? null;
    const dictation = await AiToolsReadiness.dictationNote(db, env);
    if (dictation !== AiToolsCopy.FEATURE_OFF_NOTE && dictation !== AiToolsCopy.AI_OFF_NOTE) out.dictation = dictation === AiToolsCopy.DICTATION_NO_MODEL ? AiToolsCopy.MODEL_OFF_NOTE : dictation;
    return out;
  }
}
