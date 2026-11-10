"use server";

import { revalidatePath } from "next/cache";
import { AiSpendCopy } from "@/lib/ai/AiSpendCap";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import { AiSpendCapService, type AiSpendCapResult, type AiSpendCapWriteDb } from "@/lib/services/AiSpendCapService";

/**
 * Admin > AI settings > Monthly spend caps (0074). Resolves the viewer from the session and re-checks admin.
 * target is an email or "default"; a blank amount removes that cap.
 */
export async function setAiSpendCap(target: string, amount: string): Promise<AiSpendCapResult> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin) return { ok: false, error: AiSpendCopy.NOT_AUTHORIZED };
  if (!Db.isConfigured()) return { ok: false, error: AiSpendCopy.SAVE_FAILED };
  try {
    const r = await AiSpendCapService.setCap({ db: Db.client as unknown as AiSpendCapWriteDb, viewer, target, amount });
    if (r.ok) {
      revalidatePath("/admin/ai");
      revalidatePath("/admin/people");
    }
    return r;
  } catch (e) {
    console.error("Admin action failed: setAiSpendCap", (e as Error)?.name);
    return { ok: false, error: AiSpendCopy.SAVE_FAILED };
  }
}
