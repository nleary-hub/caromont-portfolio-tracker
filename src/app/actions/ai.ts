"use server";

import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AiCopy } from "@/lib/ai/AiCopy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiSettingsService, type AiSettingsDb } from "@/lib/services/AiSettingsService";
import { AiWritingService, type AiOutcome, type AiSuggestResult, type AiWritingDb } from "@/lib/services/AiWritingService";

/** Settings form state (useActionState). Field errors are keyed by input name. */
export type AiSettingsFormState = { ok: true; message: string } | { ok: false; message: string; fieldErrors?: Record<string, string> } | null;

export type AiTestResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Server Functions for the writing assistant and Admin > AI settings. Each one resolves the viewer from the session and
 * re-checks admin (Server Functions are reachable by direct POST). None of them returns the API key or its ciphertext.
 */
class AiActions {
  static db(): AiWritingDb {
    return Db.client as unknown as AiWritingDb;
  }

  static async admin() {
    const viewer = await CurrentViewer.get();
    return viewer?.isAdmin ? viewer : null;
  }
}

/**
 * Draft from bullets / Fit for report on the update note of `projectId` (null: the New project form). Returns a
 * suggestion only; saves nothing.
 */
export async function suggestNote(projectId: string | null, feature: string, text: string): Promise<AiSuggestResult> {
  const viewer = await AiActions.admin();
  if (!viewer || !Db.isConfigured()) return { ok: false, kind: "not_allowed", message: AiCopy.NOT_ALLOWED };
  try {
    const scope = await ServiceLineAccess.activeFor(viewer);
    return await AiWritingService.suggest({ db: AiActions.db(), viewer, scope, projectId: projectId === null ? null : String(projectId), feature, text });
  } catch (e) {
    console.error("AI writing assistant failed", (e as Error)?.name);
    return { ok: false, kind: "provider", message: AiCopy.PROVIDER_ERROR };
  }
}

/** Accept, Edit or Discard of a suggestion: a usage-log row only (never project history). */
export async function recordSuggestionOutcome(suggestionId: string, outcome: AiOutcome, unverifiedCount?: number): Promise<boolean> {
  const viewer = await AiActions.admin();
  if (!viewer || !Db.isConfigured()) return false;
  try {
    return await AiWritingService.recordOutcome(AiActions.db(), viewer, suggestionId, outcome, new Date(), unverifiedCount);
  } catch {
    return false;
  }
}

export async function saveAiSettings(_prev: AiSettingsFormState, form: FormData): Promise<AiSettingsFormState> {
  const viewer = await AiActions.admin();
  if (!viewer) return { ok: false, message: "Not authorized." };
  if (!Db.isConfigured()) return { ok: false, message: AiCopy.SAVE_FAILED };
  try {
    const r = await AiSettingsService.save(Db.client as unknown as AiSettingsDb, viewer, AiSettingsService.parseForm(form));
    if (!r.ok) return { ok: false, message: r.error, ...(r.fieldErrors ? { fieldErrors: r.fieldErrors as Record<string, string> } : {}) };
    revalidatePath("/admin/ai");
    revalidatePath("/");
    return { ok: true, message: AiCopy.SAVED };
  } catch (e) {
    console.error("Admin action failed: saveAiSettings", (e as Error)?.name);
    return { ok: false, message: AiCopy.SAVE_FAILED };
  }
}

export async function clearAiKey(): Promise<{ ok: boolean; message: string }> {
  const viewer = await AiActions.admin();
  if (!viewer) return { ok: false, message: "Not authorized." };
  try {
    await AiSettingsService.clearKey(Db.client as unknown as AiSettingsDb, viewer);
    revalidatePath("/admin/ai");
    revalidatePath("/");
    return { ok: true, message: AiCopy.KEY_CLEARED };
  } catch (e) {
    console.error("Admin action failed: clearAiKey", (e as Error)?.name);
    return { ok: false, message: AiCopy.SAVE_FAILED };
  }
}

/** Test connection with the saved settings: success with the round-trip time, or the provider's error (no key). */
export async function testAiConnection(): Promise<AiTestResult> {
  const viewer = await AiActions.admin();
  if (!viewer) return { ok: false, message: "Not authorized." };
  try {
    const row = await AiSettingsService.row(Db.client as unknown as AiSettingsDb);
    const config = AiSettingsService.runtime(row);
    if (!config) return { ok: false, message: AiCopy.TEST_NEEDS_SETTINGS };
    const r = await AiWritingService.testConnection(config);
    return r.ok ? { ok: true, message: AiCopy.testOk(config.provider, r.ms) } : { ok: false, message: `${AiCopy.TEST_FAILED_PREFIX} ${r.message}` };
  } catch (e) {
    console.error("Admin action failed: testAiConnection", (e as Error)?.name);
    return { ok: false, message: `${AiCopy.TEST_FAILED_PREFIX} ${AiCopy.SAVE_FAILED}` };
  }
}
