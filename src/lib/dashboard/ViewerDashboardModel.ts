import type { ViewerProjectRow } from "@/components/rbac/ViewerDashboard";
import type { DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { DisplayName } from "@/lib/auth/DisplayName";
import { OwnerLock } from "@/lib/permissions/OwnerLock";
import type { PermissionUser } from "@/lib/permissions/Permissions";

/** Roles & Permissions 4/6: who gets the read-only Viewer dashboard, and its rows (only what the table shows). */
export class ViewerDashboardModel {
  /** Department label for a project with no department. */
  static readonly UNASSIGNED = "Unassigned";

  /** How many real departments the rows span (Unassigned does not count). */
  static departmentCount(rows: readonly { department: string }[]): number {
    return new Set(rows.map((r) => r.department).filter((d) => d !== ViewerDashboardModel.UNASSIGNED)).size;
  }

  /** "Across 1 department", "Across 3 departments", "Across 0 departments". */
  static acrossLabel(count: number): string {
    return `Across ${count} ${count === 1 ? "department" : "departments"}`;
  }

  /** The Viewer role (stored or the default for non-admins). Never the Owner or an ADMIN_EMAILS admin. */
  static isViewerRole(user: PermissionUser & { roleId?: string | null }): boolean {
    if (user.isAdmin || OwnerLock.isOwnerViewer(user)) return false;
    return (user.roleId ?? "viewer") === "viewer";
  }

  static build(rows: readonly DashboardRow[], departments: readonly { id: string; name: string }[]): ViewerProjectRow[] {
    const dept = new Map(departments.map((d) => [d.id, d.name]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      department: (r.serviceArea && dept.get(r.serviceArea)) || ViewerDashboardModel.UNASSIGNED,
      owner: r.owner || "Unassigned",
      status: r.status,
      statusLabel: r.statusLabel,
      percent: r.percentComplete,
      target: r.targetCompletion,
      blocked: Boolean(r.blockers && (r.blockers.blockedBy.length > 0 || r.blockers.external.length > 0)),
    }));
  }

  static user(viewer: { email: string; name?: string | null }) {
    const name = DisplayName.of(viewer.name ?? null, viewer.email);
    const parts = name.split(/\s+/).filter(Boolean);
    const initials = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
    return { name, initials, sub: viewer.email, role: "Viewer", email: viewer.email };
  }

  /** "Oct 22, 2026, 2:15 PM EDT" in the tracker's zone. */
  static updatedLabel(now: Date): string {
    return now.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
  }
}
