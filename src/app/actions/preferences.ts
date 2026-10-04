"use server";

import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { DashboardPrefsService } from "@/lib/services/DashboardPrefsService";

/**
 * Account menu > Dashboard heartbeat: saves the signed-in person's own switch (any signed-in user, admin or not).
 * Returns the saved value, or null when signed out or the save failed (the client puts the switch back).
 * No revalidation: the dashboard already shows the new state (optimistic), so nothing reloads or reflows.
 */
export async function setDashboardHeartbeat(on: boolean): Promise<boolean | null> {
  const viewer = await CurrentViewer.get();
  if (!viewer || typeof on !== "boolean") return null;
  try {
    return await DashboardPrefsService.setHeartbeat(viewer, on);
  } catch (e) {
    console.error("Could not save the dashboard heartbeat setting", (e as Error)?.name ?? "error");
    return null;
  }
}
