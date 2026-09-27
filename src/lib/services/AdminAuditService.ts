import { notFound } from "next/navigation";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ViewContext } from "@/generated/prisma/enums";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import type { ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DepartmentAccessCopy } from "@/lib/access/DepartmentAccessCopy";
import { DepartmentAccessService } from "@/lib/services/DepartmentAccessService";
import { LineAccessService } from "@/lib/services/LineAccessService";
import { ServiceLineHistoryText } from "@/lib/admin/ServiceLineHistoryText";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
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
  kind: "project" | "viewSettings" | "serviceLine" | "template" | "layout" | "department" | "access";
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
  /** Soft-deleted service lines (any line; restorable here). */
  deletedLines: DeletedLine[];
  /** Soft-deleted departments of the active line (restorable here). */
  deletedDepartments: DeletedLine[];
}

export interface DeletedLine {
  id: string;
  name: string;
  shortName: string;
  deletedAt: Date | null;
  deletedBy: string | null;
}

/**
 * Data for /admin/audit. Non-admins get notFound() (a 404, not a 403) so the route's
 * existence is not revealed.
 */
export class AdminAuditService {
  static readonly EVENT_LIMIT = 200;

  /**
   * The audit log of one service line (the admin's active line): its projects and their admin-only history,
   * its template and service line changes. View settings are shared by every line. Deleted lines are listed
   * whatever the active line, so they can be restored.
   */
  static async load(viewer: Viewer | null, db: PrismaClient = Db.client, scope: Pick<ServiceLineScope, "id" | "name"> = ServiceLine.defaultScope()): Promise<AuditData> {
    if (!viewer?.isAdmin) notFound();

    // Small table; filtering in memory keeps one code path with VisibilityPolicy.
    const projects = await db.project.findMany({ where: ServiceLineAccess.where(scope) });
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
    const [projectEvents, settingsEvents, viewSettings, lineEvents, templateEvents, deletedLines, layoutEvents, departmentEvents, deletedDepartments] = await Promise.all([
      db.projectHistory.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, field: { in: [...VisibilityPolicy.ADMIN_ONLY_HISTORY_FIELDS] } } }),
      db.viewSettingsHistory.findMany({}),
      ViewSettingsService.getAll(db),
      db.serviceLineHistory.findMany({ where: ServiceLineAccess.where(scope), orderBy: { changedAt: "desc" }, take: AdminAuditService.EVENT_LIMIT }),
      db.milestoneTemplateHistory.findMany({ where: ServiceLineAccess.where(scope), orderBy: { changedAt: "desc" }, take: AdminAuditService.EVENT_LIMIT }),
      db.serviceLine.findMany({ where: { deletedAt: { not: null } }, orderBy: { deletedAt: "desc" } }),
      db.lineLayoutHistory.findMany({ where: ServiceLineAccess.where(scope), orderBy: { changedAt: "desc" }, take: AdminAuditService.EVENT_LIMIT }),
      db.departmentHistory.findMany({ where: { serviceLineId: scope.id }, orderBy: { changedAt: "desc" }, take: AdminAuditService.EVENT_LIMIT }),
      db.department.findMany({ where: { serviceLineId: scope.id, deletedAt: { not: null } }, orderBy: { deletedAt: "desc" } }),
    ]);
    // Department access that moved when a department was deleted (migration 0024), with people's display names.
    const accessMoves = await db.departmentAccessHistory.findMany({
      where: { serviceLineId: scope.id, action: DepartmentAccessService.ACTIONS.moved },
      orderBy: { changedAt: "desc" },
      take: AdminAuditService.EVENT_LIMIT,
    });
    const people = new Map(
      (accessMoves.length ? await db.appUser.findMany({ where: { email: { in: [...new Set(accessMoves.map((h) => h.email))] } } }) : []).map((u) => [u.email, LineAccessService.displayName(u)]),
    );
    const departmentNames = new Map(
      (await db.department.findMany({ where: { serviceLineId: scope.id }, select: { id: true, name: true } })).map((d) => [d.id, d.name]),
    );
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
      ...lineEvents.map((h) => ({
        kind: "serviceLine" as const,
        at: h.changedAt,
        by: h.changedBy,
        subject: scope.name,
        field: `serviceLine.${h.action}`,
        oldValue: ServiceLineHistoryText.value(h.oldValue) || null,
        newValue: ServiceLineHistoryText.value(h.newValue) || null,
        comment: null,
      })),
      ...templateEvents.map((h) => ({
        kind: "template" as const,
        at: h.changedAt,
        by: h.changedBy,
        subject: "Milestone templates",
        field: `template.${h.action}`,
        oldValue: h.oldValue === null ? null : JSON.stringify(h.oldValue),
        newValue: h.newValue === null ? null : JSON.stringify(h.newValue),
        comment: null,
      })),
      ...layoutEvents.map((h) => ({
        kind: "layout" as const,
        at: h.changedAt,
        by: h.changedBy,
        subject: "Layout",
        field: `layout.${h.action}`,
        oldValue: h.oldValue === null ? null : JSON.stringify(h.oldValue),
        newValue: h.newValue === null ? null : JSON.stringify(h.newValue),
        comment: null,
      })),
      ...departmentEvents.map((h) => ({
        kind: "department" as const,
        at: h.changedAt,
        by: h.changedBy,
        subject: h.departmentId ? (departmentNames.get(h.departmentId) ?? "Department") : "Departments",
        field: `department.${h.action}`,
        oldValue: h.oldValue === null ? null : JSON.stringify(h.oldValue),
        newValue: h.newValue === null ? null : JSON.stringify(h.newValue),
        comment: null,
      })),
      ...accessMoves.map((h) => {
        const detail = (h.detail ?? {}) as { from?: string; to?: string };
        const who = people.get(h.email) ?? LineAccessService.displayName({ email: h.email });
        return {
          kind: "access" as const,
          at: h.changedAt,
          by: h.changedBy,
          subject: who,
          field: `access.${h.action}`,
          oldValue: detail.from ?? null,
          newValue: detail.to ?? null,
          comment: DepartmentAccessCopy.movedAudit(who, detail.from ?? "Department", detail.to ?? "Department"),
        };
      }),
    ]
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, AdminAuditService.EVENT_LIMIT);

    return {
      hidden,
      deleted,
      viewSettings,
      events,
      deletedLines: deletedLines.map((l) => ({ id: l.id, name: l.name, shortName: l.shortName, deletedAt: l.deletedAt, deletedBy: l.deletedBy })),
      deletedDepartments: deletedDepartments.map((d) => ({ id: d.id, name: d.name, shortName: d.shortName, deletedAt: d.deletedAt, deletedBy: d.deletedBy })),
    };
  }
}
