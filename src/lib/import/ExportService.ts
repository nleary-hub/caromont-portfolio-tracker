import type { PrismaClient } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { ProjectCsv } from "./ProjectCsv";

/** CSV export of projects (id + template columns) for the wording round-trip. */
export class ExportService {
  /** Visible, non-archived projects in report order (service area, then name). */
  static async exportCsv(
    db: Pick<PrismaClient, "project" | "projectMilestone"> = Db.client,
    scope: Pick<ServiceLineScope, "id"> = ServiceLine.defaultScope(),
  ): Promise<{ csv: string; count: number }> {
    const stored = await db.project.findMany({ where: { archivedAt: null, ...ServiceLineAccess.where(scope) } });
    // next_milestone and due_date are the derived values the dashboard and report show.
    const projects = MilestoneProgress.applyAll(stored, await MilestoneService.loadSteps(db, stored.map((p) => p.id)));
    projects.sort(
      (a, b) =>
        ServiceAreaInfo.rank(a.serviceArea) - ServiceAreaInfo.rank(b.serviceArea) ||
        a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
    return { csv: ProjectCsv.exportCsv(projects), count: projects.length };
  }

  /** e.g. "projects-2026-09-26.csv" (America/New_York calendar date). */
  static fileName(today: string): string {
    return `projects-${today}.csv`;
  }
}
