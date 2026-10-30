import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { AiKeyShape } from "@/lib/ai/AiKeyShape";
import { AiKeyProviders } from "@/lib/ai/AiKeyProviders";
import { AiModelKinds, type AiListedModel, type AiModelKind } from "@/lib/ai/AiModelKinds";
import { AiRegistry, type AiCategory } from "@/lib/ai/AiRegistry";
import { AiRegistryCopy, AiRegistryService, type AiRegistryDb, type AiRegistryResult } from "@/lib/services/AiRegistryService";

type Env = Record<string, string | undefined>;

/** The provider's live model list, read on the server with the stored key. Never taken from the browser. */
export type AiLiveList = (provider: string) => Promise<{ ok: true; models: readonly AiListedModel[] } | { ok: false; error: string }>;

class PickRefused extends Error {}

export class AiModelPickerCopy {
  static readonly NOT_IN_LIST = "That model is not in the provider's current list. Refresh the list and pick again.";
  static readonly ARCHIVED = "That model is archived. Restore it first; a restored model starts switched off.";
  static readonly WRONG_KIND = "That model cannot serve this category.";
  static readonly EFFORT_PICK_AGAIN = "This category's effort is not allowed on that model. Set the category effort to Default first, then pick again.";
}

/**
 * Item 3: the live model picker. The Owner picks a model from the provider's live list for a category, and that one
 * explicit action adds the model to the registry switched on (or switches an existing row on) and points the category
 * at it. Everything happens in one transaction with an audit row per change. Listing alone never enables anything.
 * Typed model ids (item 3b) are not accepted here: the id must be in the live list returned on the server.
 * The cached list and the daily refresh are D-a (migration 0072); this service takes the list as a function so either
 * the live call or the D-a cache can feed it.
 * After a successful pick the screen asks for a price ("Save price" / "Skip, leave unpriced"); `needsPrice` says so.
 */
export class AiModelPickerService {
  static async pick(
    db: AiRegistryDb,
    actor: Viewer | null,
    input: { provider: string; model: string; category: string },
    liveList: AiLiveList,
    env?: Env,
    now: () => Date = () => new Date(),
  ): Promise<AiRegistryResult<{ added: boolean; enabled: boolean; needsPrice: boolean }>> {
    if (!OwnerPolicy.isOwner(actor, env) || !actor) return { ok: false, error: AiRegistryCopy.NOT_AUTHORIZED };
    const category: AiCategory | null = AiRegistry.parseCategory(input.category);
    if (!category) return { ok: false, error: AiRegistryCopy.BAD_CATEGORY };
    if (!AiKeyProviders.parse(input.provider)) return { ok: false, error: AiRegistryCopy.BAD_PROVIDER };
    const idProblem = AiKeyShape.modelIdProblem(input.model);
    if (idProblem) return { ok: false, error: idProblem === "key_shaped" ? AiRegistryCopy.KEY_SHAPED : AiRegistryCopy.BAD_MODEL_ID };
    const isAudio = (AiRegistry.AUDIO_CATEGORIES as readonly string[]).includes(category);
    if (isAudio && input.provider !== "openai") return { ok: false, error: AiRegistryCopy.AUDIO_OPENAI_ONLY };
    const need: AiModelKind = isAudio ? AiRegistry.AUDIO_KIND[category as "dictation" | "voice_chat"] : "chat";

    const list = await liveList(input.provider).catch(() => null);
    if (!list) return { ok: false, error: AiRegistryCopy.SAVE_FAILED };
    if (!list.ok) return { ok: false, error: list.error };
    const listed = list.models.find((m) => m.id === input.model);
    if (!listed) return { ok: false, error: AiModelPickerCopy.NOT_IN_LIST };
    if (!AiModelKinds.fits({ id: listed.id, kind: listed.kind }, need)) return { ok: false, error: AiModelPickerCopy.WRONG_KIND };

    const pair = AiRegistryService.pair(input.provider, input.model);
    const next = `${category}=${pair}`;
    for (const v of [pair, next]) if (AiKeyShape.historyValueProblem(v)) return { ok: false, error: AiRegistryCopy.BAD_MODEL_ID };
    const who = actor.email;
    const hist = (field: string, action: string, oldValue: string | null, newValue: string | null, at: Date) => ({ id: randomUUID(), field, action, oldValue, newValue, changedAt: at, changedBy: who });
    const key = { provider_model: { provider: input.provider, model: input.model } };
    try {
      return await db.$transaction(async (tx) => {
        const at = now();
        const there = await tx.aiModelRegistry.findUnique({ where: key });
        let added = false;
        let enabled = false;
        if (!there) {
          await tx.aiModelRegistry.create({ data: { provider: input.provider, model: input.model, kind: listed.kind ?? need, enabled: true, listedState: "listed", addedAt: at, addedBy: who, updatedAt: at, updatedBy: who } });
          await tx.aiSettingsHistory.create({ data: hist(AiRegistryService.FIELD_MODEL, "model_added", null, pair, at) });
          await tx.aiSettingsHistory.create({ data: hist(AiRegistryService.FIELD_MODEL, "model_enabled", pair, pair, at) });
          added = true;
          enabled = true;
        } else {
          if (there.archivedAt !== null) return { ok: false as const, error: AiModelPickerCopy.ARCHIVED };
          if (!AiModelKinds.fits({ id: there.model, kind: there.kind }, need)) return { ok: false as const, error: AiModelPickerCopy.WRONG_KIND };
          if (!there.enabled) {
            await tx.aiModelRegistry.update({ where: key, data: { enabled: true, updatedAt: at, updatedBy: who } });
            await tx.aiSettingsHistory.create({ data: hist(AiRegistryService.FIELD_MODEL, "model_enabled", pair, pair, at) });
            enabled = true;
          }
        }
        const before = await tx.aiCategorySetting.findUnique({ where: { category } });
        // The inherited effort is never dropped silently: it must be allowed on the picked model, or the pick is refused.
        const effort = before?.effort ?? null;
        const allowed = there?.allowedEfforts ?? [];
        if (effort !== null && !allowed.includes(effort)) throw new PickRefused(AiModelPickerCopy.EFFORT_PICK_AGAIN);
        const oldV = before?.provider && before?.model ? `${category}=${AiRegistryService.pair(before.provider, before.model)}` : null;
        if (oldV !== next) {
          await tx.aiCategorySetting.upsert({
            where: { category },
            create: { category, provider: input.provider, model: input.model, effort, updatedAt: at, updatedBy: who },
            update: { provider: input.provider, model: input.model, effort, updatedAt: at, updatedBy: who },
          });
          await tx.aiSettingsHistory.create({ data: hist(AiRegistryService.FIELD_CATEGORY, "category_set", oldV, next, at) });
        }
        const prices = await tx.aiModelPrice.findMany({ where: { provider: input.provider, model: input.model } });
        return { ok: true as const, added, enabled, needsPrice: prices.length === 0 };
      });
    } catch (e) {
      // Thrown inside the transaction so the model add or enable above is rolled back too.
      if (e instanceof PickRefused) return { ok: false, error: e.message };
      console.error("Registry write failed: pick", (e as Error)?.name);
      return { ok: false, error: AiRegistryCopy.SAVE_FAILED };
    }
  }
}
