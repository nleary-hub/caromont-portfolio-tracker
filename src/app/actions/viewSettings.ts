"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";

export type SaveViewSettingsResult = { ok: true; value: ViewSettingsValue } | { ok: false; error: string };

/**
 * Save the show/hide settings for one context. Server Actions are reachable by direct POST,
 * so the session and allowlist are checked here, not only in the proxy.
 */
export async function saveViewSettings(context: string, value: unknown): Promise<SaveViewSettingsResult> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !EmailAllowlist.isAllowed(email)) return { ok: false, error: "Not authorized." };
  if (!ViewSettings.isContext(context)) return { ok: false, error: "Unknown view." };
  try {
    const saved = await ViewSettingsService.update(context, value, { changedBy: email });
    revalidatePath("/");
    return { ok: true, value: saved };
  } catch (e) {
    console.error("Failed to save view settings", e);
    return { ok: false, error: "Could not save view settings." };
  }
}
