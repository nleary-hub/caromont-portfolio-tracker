import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { type TimelineDto, UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { ProjectHistoryService } from "@/lib/services/ProjectHistoryService";

/** The drawer's History load (any signed-in viewer; ProjectHistoryService applies the visibility rules). */
export class ProjectHistoryForms {
  static async load(viewer: Viewer | null, projectId: string, scope: ServiceLineScope, db: PrismaClient = Db.client): Promise<TimelineDto | null> {
    if (!viewer || typeof projectId !== "string" || !projectId) return null;
    try {
      return UpdateTimeline.toDto(await ProjectHistoryService.timeline(projectId, viewer, db, scope));
    } catch (e) {
      console.error("Could not load project history", e);
      return null;
    }
  }
}
