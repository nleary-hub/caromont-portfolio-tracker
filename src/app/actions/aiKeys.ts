"use server";

import { revalidatePath } from "next/cache";
import { AiKeyCopy, type AiKeyActionResult } from "@/lib/ai/AiKeyProviders";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import { AiProviderKeyService, type AiProviderKeyDb } from "@/lib/services/AiProviderKeyService";

/**
 * Server Functions for Admin > AI settings > Provider keys. Each one resolves the viewer from the session and re-checks
 * admin (Server Functions are reachable by direct POST). Every response carries only provider, last 4, set date and
 * status: never the key or its ciphertext. Errors are logged by name only.
 */
async function run(name: string, fn: (db: AiProviderKeyDb, viewer: { email: string; isAdmin: boolean }) => Promise<AiKeyActionResult>): Promise<AiKeyActionResult> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: AiKeyCopy.NOT_AUTHORIZED };
  if (!Db.isConfigured()) return { ok: false, error: AiKeyCopy.SAVE_FAILED };
  try {
    const r = await fn(Db.client as unknown as AiProviderKeyDb, viewer);
    revalidatePath("/admin/ai");
    revalidatePath("/");
    return r;
  } catch (e) {
    console.error(`Admin action failed: ${name}`, (e as Error)?.name);
    return { ok: false, error: AiKeyCopy.SAVE_FAILED };
  }
}

/** Add or Replace: the key is saved at once (the card then runs Test). "other" also takes the base URL and display name. */
export async function saveProviderKey(provider: string, apiKey: string, baseUrl?: string, label?: string): Promise<AiKeyActionResult> {
  return run("saveProviderKey", (db, v) => AiProviderKeyService.save(db, v, provider, { apiKey, baseUrl, label }));
}

/** Rotate: tests the new key first; the old key stays live unless the test passes. */
export async function rotateProviderKey(provider: string, apiKey: string): Promise<AiKeyActionResult> {
  return run("rotateProviderKey", (db, v) => AiProviderKeyService.rotate(db, v, provider, apiKey));
}

export async function testProviderKey(provider: string): Promise<AiKeyActionResult> {
  return run("testProviderKey", (db, v) => AiProviderKeyService.test(db, v, provider));
}

/** Delete, only after the confirm dialog (`confirmed` must be true). */
export async function deleteProviderKey(provider: string, confirmed: boolean): Promise<AiKeyActionResult> {
  return run("deleteProviderKey", async (db, v) => (confirmed === true ? AiProviderKeyService.remove(db, v, provider) : { ok: false, error: AiKeyCopy.SAVE_FAILED }));
}
