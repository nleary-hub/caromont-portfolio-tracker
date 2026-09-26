import type { PrismaClient } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ProjectCsv } from "./ProjectCsv";

/** CSV export of projects (id + template columns) for the wording round-trip. */
export class ExportService {
  /** Visible, non-archived projects in report order (service area, then name). */
  static async exportCsv(db: Pick<PrismaClient, "project"> = Db.client): Promise<{ csv: string; count: number }> {
    const projects = await db.project.findMany({ where: { archivedAt: null } });
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
