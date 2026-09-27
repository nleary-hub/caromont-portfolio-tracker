import type { Prisma } from "@/generated/prisma/client";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { ProjectRows } from "@/lib/domain/ProjectRows";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

type Reader = Pick<Prisma.TransactionClient, "project" | "serviceLine" | "serviceLineUserState" | "serviceLineAccessGrant" | "departmentAccessGrant">;

/** What the dashboard does with a project link (`/?project=<id>`). */
export type ProjectLinkResult =
  /** No link: the dashboard as usual. */
  | { kind: "none" }
  /** The project is in the viewer's active line and departments: open its detail. */
  | { kind: "open"; id: string }
  /** It is in another line the viewer may see (and one of their departments there): that line is saved; reload. */
  | { kind: "switched"; to: string }
  /** Not theirs, not found, deleted or hidden: the project no-access card (the same for every case, no name). */
  | { kind: "lacks" };

/**
 * Project links on the dashboard, checked on the server. A viewer limited to some departments (DepartmentAccess)
 * who follows a link to a project in another department, or another line, gets the project no-access card, which
 * never names the project. A project that doesn't exist gets the same card, so a link reveals nothing.
 */
export class ProjectLink {
  static readonly PARAM = "project";

  /** A project id (UUID) from the query, or null (no link). */
  static requestedId(raw: string | string[] | undefined): string | null {
    const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase() ?? "";
    return v || null;
  }

  static isUuid(v: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
  }

  static href(id: string): string {
    return `/?${ProjectLink.PARAM}=${encodeURIComponent(id)}`;
  }

  /** Whether the dashboard lists the project for a non-admin (the same rule as DashboardData.load). */
  static async listed(project: Parameters<typeof VisibilityPolicy.isVisible>[0], db: Reader): Promise<boolean> {
    if (!VisibilityPolicy.candidates([project], "dashboard").length) return false;
    if (project.status === "Complete" || project.status === "Cancelled") return true;
    return VisibilityPolicy.isVisible(project, "dashboard", await ViewSettingsService.get("dashboard", db as never));
  }

  static async resolve(viewer: Viewer, raw: string | string[] | undefined, scope: ServiceLineScope, db: Reader): Promise<ProjectLinkResult> {
    const id = ProjectLink.requestedId(raw);
    if (!id) return { kind: "none" };
    if (!ProjectLink.isUuid(id)) return { kind: "lacks" };
    const row = await db.project.findUnique({ where: { id } });
    if (!row) return { kind: "lacks" };
    const project = ProjectRows.fromDb(row);
    // Deleted, hidden, or not listed on the dashboard (status hidden by view settings; closed projects are listed in
    // the FY sections): admins still get the dashboard (the drawer just doesn't open); nobody else learns it exists.
    if (!(await ProjectLink.listed(project, db))) return viewer.isAdmin ? { kind: "none" } : { kind: "lacks" };
    const lineId = row.serviceLineId ?? ServiceLine.DEFAULT_ID;
    if (lineId === scope.id) return DepartmentAccess.allows(scope, row.departmentId) ? { kind: "open", id } : { kind: "lacks" };
    const line = (await ServiceLineAccess.usableLines(viewer, db)).find((l) => l.id === lineId);
    if (!line) return { kind: "lacks" };
    const theirs = await DepartmentAccess.apply(viewer, line, db);
    if (!DepartmentAccess.allows(theirs, row.departmentId)) return { kind: "lacks" };
    await ServiceLineAccess.setActive(viewer, lineId, db as never);
    return { kind: "switched", to: ProjectLink.href(id) };
  }
}
