import { notFound } from "next/navigation";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ViewContext } from "@/generated/prisma/enums";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

export interface AuditProject {
  id: string;
  name: string;
  hiddenFromDashboard: boolean;
  hiddenFromReport: boolean;
  deletedAt: Date | null;
  deletedBy: string | null;
}

export interface AuditEvent {
  kind: "project" | "viewSettings";
  at: Date;
  by: string;
  /** Project name, or the view settings context. */
  subject: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  comment: string | null;
}

export interface AuditData {
  hidden: AuditProject[];
  deleted: AuditProject[];
  viewSettings: Record<ViewContext, ViewSettingsValue>;
  events: AuditEvent[];
}

/**
 * Data for /admin/audit. Non-admins get notFound() (a 404, not a 403) so the route's
 * existence is not revealed.
 */
export class AdminAuditService {
  static readonly EVENT_LIMIT = 200;

  static async load(viewer: Viewer | null, db: PrismaClient = Db.client): Promise<AuditData> {
    if (!viewer?.isAdmin) notFound();

    // Small table; filtering in memory keeps one code path with VisibilityPolicy.
    const projects = await db.project.findMany({});
    const toAudit = (p: (typeof projects)[number]): AuditProject => ({
      id: p.id,
      name: p.name,
      hiddenFromDashboard: p.hiddenFromDashboard,
      hiddenFromReport: p.hiddenFromReport,
      deletedAt: p.archivedAt,
      deletedBy: p.deletedBy,
    });
    const byName = (a: AuditProject, b: AuditProject) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    const deleted = projects.filter((p) => VisibilityPolicy.isDeleted(p)).map(toAudit).sort(byName);
    const hidden = projects
      .filter((p) => !VisibilityPolicy.isDeleted(p))
      .filter((p) => VisibilityPolicy.isHiddenByProject(p, "dashboard") || VisibilityPolicy.isHiddenByProject(p, "report"))
      .map(toAudit)
      .sort(byName);

    const names = new Map(projects.map((p) => [p.id, p.name]));
    const [projectEvents, settingsEvents, viewSettings] = await Promise.all([
      db.projectHistory.findMany({ where: { field: { in: [...VisibilityPolicy.ADMIN_ONLY_HISTORY_FIELDS] } } }),
      db.viewSettingsHistory.findMany({}),
      ViewSettingsService.getAll(db),
    ]);
    const events: AuditEvent[] = [
      ...projectEvents.map((h) => ({
        kind: "project" as const,
        at: h.changedAt,
        by: h.changedBy,
        subject: names.get(h.projectId) ?? h.projectId,
        field: h.field,
        oldValue: h.oldValue,
        newValue: h.newValue,
        comment: h.comment,
      })),
      ...settingsEvents.map((h) => ({
        kind: "viewSettings" as const,
        at: h.changedAt,
        by: h.changedBy,
        subject: h.context,
        field: "viewSettings",
        oldValue: JSON.stringify(h.oldValue),
        newValue: JSON.stringify(h.newValue),
        comment: null,
      })),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, AdminAuditService.EVENT_LIMIT);

    return { hidden, deleted, viewSettings, events };
  }
}
