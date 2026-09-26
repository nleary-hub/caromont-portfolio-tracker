import { ProjectStatus } from "@/generated/prisma/enums";

/** Status metadata: display labels, severity order, closed-ness. */
export class ProjectStatusInfo {
  private static readonly LABELS: Record<ProjectStatus, string> = {
    NotStarted: "Not started",
    OnTrack: "On track",
    AtRisk: "At risk",
    OffTrack: "Off track",
    OnHold: "On hold",
    Complete: "Complete",
    Cancelled: "Cancelled",
  };

  /** Most severe first; used as the secondary report sort key. */
  static readonly SEVERITY_ORDER: readonly ProjectStatus[] = [
    ProjectStatus.OffTrack,
    ProjectStatus.AtRisk,
    ProjectStatus.OnHold,
    ProjectStatus.OnTrack,
    ProjectStatus.NotStarted,
    ProjectStatus.Complete,
    ProjectStatus.Cancelled,
  ];

  private static readonly CLOSED: ReadonlySet<ProjectStatus> = new Set<ProjectStatus>([
    ProjectStatus.Complete,
    ProjectStatus.Cancelled,
  ]);

  static all(): ProjectStatus[] {
    return Object.values(ProjectStatus);
  }

  static label(status: ProjectStatus): string {
    return ProjectStatusInfo.LABELS[status];
  }

  static severityRank(status: ProjectStatus): number {
    const i = ProjectStatusInfo.SEVERITY_ORDER.indexOf(status);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }

  /** Complete or Cancelled. */
  static isClosed(status: ProjectStatus): boolean {
    return ProjectStatusInfo.CLOSED.has(status);
  }

  static isValid(value: unknown): value is ProjectStatus {
    return typeof value === "string" && (Object.values(ProjectStatus) as string[]).includes(value);
  }
}
