import type { ViewContext } from "@/generated/prisma/enums";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { ProjectRecord } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";

/** Minimal history shape the policy needs. `field` is required to filter admin-only events. */
export interface HistoryLike {
  projectId: string;
  field: string;
}

/**
 * THE central visibility gate. Every read path that produces something a non-admin can see
 * (dashboard rows, tiles, area chips, flags, report rows and header counts, history views,
 * snapshots) MUST go through this class. Future exports, handoff.json and agendas get the same
 * rules for free by building on visibleProjects() / publicHistory() / snapshotForViewer().
 *
 * Rules:
 * - Soft-deleted projects (archivedAt set) are invisible everywhere outside the admin audit view.
 * - A project hidden per context (hiddenFromDashboard / hiddenFromReport) is invisible in that context.
 * - A project whose status is hidden by that context's view settings is invisible in that context.
 * - Report context also requires includeInReport.
 * - Invisible projects are EXCLUDED from every count, total and flag.
 * - History rows of invisible projects, and hide/unhide/delete/restore events, are admin-only.
 * - The frozen view settings on a snapshot are admin-only.
 */
export class VisibilityPolicy {
  /** History fields whose rows record hide/unhide/delete/restore events. Admin-only. */
  static readonly ADMIN_ONLY_HISTORY_FIELDS: readonly string[] = [
    "archivedAt",
    "deletedBy",
    "hiddenFromDashboard",
    "hiddenFromReport",
  ];

  static isDeleted(project: Pick<ProjectRecord, "archivedAt">): boolean {
    return project.archivedAt !== null;
  }

  static isHiddenByProject(
    project: Pick<ProjectRecord, "hiddenFromDashboard" | "hiddenFromReport">,
    context: ViewContext,
  ): boolean {
    return context === "dashboard" ? project.hiddenFromDashboard : project.hiddenFromReport;
  }

  /**
   * Candidate for a context before status settings: not deleted, not hidden per project, and
   * (report) included in the report. Used for admin-only picker counts.
   */
  static isCandidate(project: ProjectRecord, context: ViewContext): boolean {
    if (VisibilityPolicy.isDeleted(project)) return false;
    if (VisibilityPolicy.isHiddenByProject(project, context)) return false;
    if (context === "report" && !project.includeInReport) return false;
    return true;
  }

  static isVisible(project: ProjectRecord, context: ViewContext, settings: ViewSettingsValue): boolean {
    return VisibilityPolicy.isCandidate(project, context) && ViewSettings.isStatusVisible(settings, project.status);
  }

  /** Projects visible in a context. Everything a non-admin sees is derived from this list only. */
  static visibleProjects<T extends ProjectRecord>(projects: readonly T[], context: ViewContext, settings: ViewSettingsValue): T[] {
    return projects.filter((p) => VisibilityPolicy.isVisible(p, context, settings));
  }

  static candidates<T extends ProjectRecord>(projects: readonly T[], context: ViewContext): T[] {
    return projects.filter((p) => VisibilityPolicy.isCandidate(p, context));
  }

  static isAdminOnlyHistoryField(field: string): boolean {
    return VisibilityPolicy.ADMIN_ONLY_HISTORY_FIELDS.includes(field);
  }

  /** Prisma where-fragment that excludes admin-only history rows (use in every non-admin history query). */
  static publicHistoryWhere(): { field: { notIn: string[] } } {
    return { field: { notIn: [...VisibilityPolicy.ADMIN_ONLY_HISTORY_FIELDS] } };
  }

  /** History a non-admin may see: only rows of visible projects, never hide/delete events. */
  static publicHistory<T extends HistoryLike>(history: readonly T[], visibleProjectIds: Iterable<string>): T[] {
    const ids = new Set(visibleProjectIds);
    return history.filter((h) => ids.has(h.projectId) && !VisibilityPolicy.isAdminOnlyHistoryField(h.field));
  }

  /** Admins see all history; everyone else gets publicHistory(). */
  static historyFor<T extends HistoryLike>(viewer: Viewer, history: readonly T[], visibleProjectIds: Iterable<string>): T[] {
    return viewer.isAdmin ? [...history] : VisibilityPolicy.publicHistory(history, visibleProjectIds);
  }

  /** Strip admin-only snapshot fields (frozen view settings) for non-admins. */
  static snapshotForViewer<T extends { viewSettingsJson?: unknown }>(
    snapshot: T,
    viewer: Viewer,
  ): T | Omit<T, "viewSettingsJson"> {
    if (viewer.isAdmin) return snapshot;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { viewSettingsJson, ...rest } = snapshot;
    return rest;
  }
}
