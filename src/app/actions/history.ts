"use server";

import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import type { TimelineDto } from "@/lib/history/UpdateTimeline";
import { ProjectHistoryForms } from "@/lib/services/ProjectHistoryForms";

/** Project detail > History for the signed-in viewer, in their active service line. Null when signed out or on a load error. */
export async function loadProjectHistory(projectId: string): Promise<TimelineDto | null> {
  const viewer = await CurrentViewer.get();
  if (!viewer) return null;
  // Per-line access: a viewer with no line gets nothing; a project of another line is not found in theirs.
  const scope = await ServiceLineAccess.activeOrNull(viewer).catch(() => null);
  return scope ? ProjectHistoryForms.load(viewer, projectId, scope) : null;
}
