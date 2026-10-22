"use server";

import { revalidatePath } from "next/cache";
import { AiCopy } from "@/lib/ai/AiCopy";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import type { AiModelDb } from "@/lib/services/AiModelService";
import { AiPriceRefreshService, type AiPriceApplyResult, type AiPriceReviewResult } from "@/lib/services/AiPriceRefreshService";

/**
 * Server Functions for Admin > AI settings "Refresh prices" (step 3c). Each one resolves the viewer from the session
 * and re-checks admin (Server Functions are reachable by direct POST). reviewAiPriceRefresh saves nothing;
 * applyAiPriceRefresh saves only what the admin confirmed. Neither returns or logs the API key.
 */
export async function reviewAiPriceRefresh(): Promise<AiPriceReviewResult> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: AiCopy.NOT_AUTHORIZED };
  if (!Db.isConfigured()) return { ok: false, error: AiCopy.SAVE_FAILED };
  try {
    return await AiPriceRefreshService.review(Db.client as unknown as AiModelDb, viewer);
  } catch (e) {
    console.error("Admin action failed: reviewAiPriceRefresh", (e as Error)?.name);
    return { ok: false, error: AiCopy.PRICE_REFRESH_FETCH_FAILED };
  }
}

export async function applyAiPriceRefresh(changes: unknown): Promise<AiPriceApplyResult> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: AiCopy.NOT_AUTHORIZED };
  if (!Db.isConfigured()) return { ok: false, error: AiCopy.SAVE_FAILED };
  try {
    const r = await AiPriceRefreshService.apply(Db.client as unknown as AiModelDb, viewer, changes);
    if (r.ok) revalidatePath("/admin/ai");
    return r;
  } catch (e) {
    console.error("Admin action failed: applyAiPriceRefresh", (e as Error)?.name);
    return { ok: false, error: AiCopy.SAVE_FAILED };
  }
}
