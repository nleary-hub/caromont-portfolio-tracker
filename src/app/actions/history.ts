"use server";

import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import type { TimelineDto } from "@/lib/history/UpdateTimeline";
import { ProjectHistoryForms } from "@/lib/services/ProjectHistoryForms";

/** Project detail > History for the signed-in viewer, in their active service line. Null when signed out or on a load error. */
export async function loadProjectHistory(projectId: string): Promise<TimelineDto | null> {
  const viewer = await CurrentViewer.get();
  if (!viewer) return null;
  return ProjectHistoryForms.load(viewer, projectId, await ServiceLineAccess.activeOrDefault(viewer));
}
