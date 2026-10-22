"use server";

import { revalidatePath } from "next/cache";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { DashboardSettingsService } from "@/lib/services/DashboardSettingsService";

/**
 * Admin > Settings > Dashboard heartbeat (global, every user). The admin check runs here on the server, so a
 * direct POST from a non-admin is refused even though the control is only rendered for admins. Returns the saved
 * value, or null when the caller is not an admin or the save failed.
 */
export async function setGlobalDashboardHeartbeat(
  on: boolean,
): Promise<boolean | null> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin || typeof on !== "boolean") return null;
  try {
    const saved = await DashboardSettingsService.setHeartbeat(viewer, on);
    revalidatePath("/");
    revalidatePath("/admin/settings");
    return saved;
  } catch (e) {
    console.error(
      "Could not save the dashboard heartbeat setting",
      (e as Error)?.name ?? "error",
    );
    return null;
  }
}

/** Admin > Settings > Hide Changed tag (global, display only). Same server-side admin check as the heartbeat. */
export async function setGlobalHideChangedTag(
  on: boolean,
): Promise<boolean | null> {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin || typeof on !== "boolean") return null;
  try {
    const saved = await DashboardSettingsService.setHideChangedTag(viewer, on);
    revalidatePath("/");
    revalidatePath("/admin/settings");
    return saved;
  } catch (e) {
    console.error(
      "Could not save the hide Changed tag setting",
      (e as Error)?.name ?? "error",
    );
    return null;
  }
}
