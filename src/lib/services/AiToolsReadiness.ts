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
    const enabled = await AiModelService.enabledIds(db);
    const model = (row?.model ?? "").trim();
    const base = !row?.enabled ? AiToolsCopy.AI_OFF_NOTE : !model || !enabled.includes(model) ? AiToolsCopy.MODEL_OFF_NOTE : null;
    const out: Record<string, string | null> = {};
    for (const f of features) out[f] = (await AiModelService.featureOn(db, f, env)) ? base : AiToolsCopy.FEATURE_OFF_NOTE;
    return out;
  }
}
