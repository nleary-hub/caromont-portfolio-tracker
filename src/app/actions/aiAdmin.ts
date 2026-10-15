"use server";

import { revalidatePath } from "next/cache";
import { AiCopy } from "@/lib/ai/AiCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiModelService, type AiAdminResult, type AiModelDb } from "@/lib/services/AiModelService";

/**
 * Server Functions for Admin > AI settings: Models and Features. Each one resolves the viewer from the session and
 * re-checks admin (Server Functions are reachable by direct POST). None of them returns or logs the API key.
 */
async function run(name: string, fn: (db: AiModelDb, viewer: { email: string; isAdmin: boolean }) => Promise<AiAdminResult>): Promise<AiAdminResult> {
  const viewer = await CurrentViewer.get();
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

export async function addAiModel(id: string): Promise<AiAdminResult> {
  return run("addAiModel", (db, v) => AiModelService.add(db, v, id));
}

export async function setAiModelEnabled(id: string, enabled: boolean, confirmed: boolean): Promise<AiAdminResult> {
  return run("setAiModelEnabled", (db, v) => AiModelService.setEnabled(db, v, id, Boolean(enabled), Boolean(confirmed)));
}

export async function setAiModelPrices(id: string, unit: string, input: string, output: string): Promise<AiAdminResult> {
  return run("setAiModelPrices", (db, v) => AiModelService.setPrices(db, v, id, unit, input, output));
}

export async function setAiFeatureEnabled(feature: string, enabled: boolean): Promise<AiAdminResult> {
  return run("setAiFeatureEnabled", (db, v) => AiModelService.setFeature(db, v, feature, Boolean(enabled)));
}
