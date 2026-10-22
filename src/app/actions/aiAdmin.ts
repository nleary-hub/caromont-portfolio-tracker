"use server";

import { revalidatePath } from "next/cache";
import { AiCopy } from "@/lib/ai/AiCopy";
import type { AiListedModel } from "@/lib/ai/AiModelKinds";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import { AiModelService, type AiAdminResult, type AiModelDb } from "@/lib/services/AiModelService";

/**
 * Server Functions for Admin > AI settings: Models and Features. Each one resolves the viewer from the session and
 * re-checks admin (Server Functions are reachable by direct POST). None of them returns or logs the API key.
 */
async function run(name: string, fn: (db: AiModelDb, viewer: { email: string; isAdmin: boolean }) => Promise<AiAdminResult>): Promise<AiAdminResult> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
  if (!Db.isConfigured()) return { ok: false, error: AiCopy.SAVE_FAILED };
  try {
    const r = await fn(Db.client as unknown as AiModelDb, viewer);
    if (r.ok) {
      revalidatePath("/admin/ai");
      revalidatePath("/");
    }
    return r;
  } catch (e) {
    console.error(`Admin action failed: ${name}`, (e as Error)?.name);
    return { ok: false, error: AiCopy.SAVE_FAILED };
  }
}

/**
 * `manual`: typed after the model list failed to load; saved unchecked (still off) when the provider can't be reached.
 * `provider` (PR B): the provider the model belongs to; absent = OpenAI, as before.
 */
export async function addAiModel(id: string, manual = false, provider?: string): Promise<AiAdminResult> {
  return run("addAiModel", (db, v) => AiModelService.add(db, v, id, process.env, null, new Date(), { manual: manual === true, ...(provider === undefined ? {} : { provider }) }));
}

/** PR B: one provider's model list for its saved key, by kind. Read-only; the key is never returned. */
export async function listAiProviderModels(provider: string): Promise<{ ok: true; models: AiListedModel[] } | { ok: false; error: string }> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
  if (!Db.isConfigured()) return { ok: false, error: AiCopy.MODEL_CHECK_FAILED };
  try {
    return await AiModelService.listProvider(Db.client as unknown as AiModelDb, viewer, provider);
  } catch (e) {
    console.error("Admin action failed: listAiProviderModels", (e as Error)?.name);
    return { ok: false, error: AiCopy.MODEL_CHECK_FAILED };
  }
}

/**
 * PR B: a text feature's provider and model, saved together. Voice chat and Dictation are refused (OpenAI only). The
 * result never carries a key.
 */
export async function setAiFeatureProvider(feature: string, provider: string, model: string): Promise<AiAdminResult> {
  return run("setAiFeatureProvider", (db, v) => AiModelService.setFeatureProviderModel(db, v, feature, provider, model));
}

/** OpenAI's model list for the saved key, by kind. Read-only; the key is never returned. */
export async function listOpenAiModels(): Promise<{ ok: true; models: AiListedModel[] } | { ok: false; error: string }> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: "Not authorized." };
  if (!Db.isConfigured()) return { ok: false, error: AiCopy.MODEL_CHECK_FAILED };
  try {
    return await AiModelService.listOpenAi(Db.client as unknown as AiModelDb, viewer);
  } catch (e) {
    console.error("Admin action failed: listOpenAiModels", (e as Error)?.name);
    return { ok: false, error: AiCopy.MODEL_CHECK_FAILED };
  }
}

export async function setAiModelEnabled(id: string, enabled: boolean, confirmed: boolean): Promise<AiAdminResult> {
  return run("setAiModelEnabled", (db, v) => AiModelService.setEnabled(db, v, id, Boolean(enabled), Boolean(confirmed)));
}

export async function setAiModelPrices(id: string, unit: string, input: string, output: string): Promise<AiAdminResult> {
  return run("setAiModelPrices", (db, v) => AiModelService.setPrices(db, v, id, unit, input, output));
}

export async function setAiFeatureModel(feature: string, model: string): Promise<AiAdminResult> {
  return run("setAiFeatureModel", (db, v) => AiModelService.setFeatureModel(db, v, feature, model));
}

/** Voice chat instructions (admin only; length checked on the server). */
export async function setAiVoiceInstructions(text: string): Promise<AiAdminResult> {
  return run("setAiVoiceInstructions", (db, v) => AiModelService.setVoiceInstructions(db, v, text));
}

/** Voice and command bar item: the voice chat session limit in whole minutes ("" = the built-in 15). */
export async function setAiVoiceSessionCap(minutes: string): Promise<AiAdminResult> {
  return run("setAiVoiceSessionCap", (db, v) => AiModelService.setVoiceSessionCap(db, v, minutes));
}

export async function setAiFeatureEnabled(feature: string, enabled: boolean): Promise<AiAdminResult> {
  return run("setAiFeatureEnabled", (db, v) => AiModelService.setFeature(db, v, feature, Boolean(enabled)));
}
