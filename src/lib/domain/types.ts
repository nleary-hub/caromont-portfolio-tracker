import type { ProjectStatus, RecipientLine, ServiceArea } from "@/generated/prisma/enums";

/** Fields of a Project that the domain logic needs. Structurally compatible with the Prisma model. */
export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  serviceArea: ServiceArea;
  owner: string;
  physicianChampion: string | null;
  physicianChampionEmail: string | null;
  status: ProjectStatus;
  nextMilestone: string | null;
  dueDate: Date | null;
  targetCompletion: Date | null;
  percentComplete: number | null;
  note: string | null;
  includeInReport: boolean;
  archivedAt: Date | null;
  deletedBy: string | null;
  hiddenFromDashboard: boolean;
  hiddenFromReport: boolean;
}

export interface RecipientRecord {
  id: string;
  name: string;
  email: string;
  role: string | null;
  serviceArea: ServiceArea | null;
  line: RecipientLine;
  active: boolean;
}

export interface HistoryEntryRecord {
  projectId: string;
  changedAt: Date;
  /** Needed so admin-only events (hide/delete) never set the Changed flag. */
  field: string;
  /** Serialized old/new values (used for the "from <status>" detail). Optional for callers that only flag. */
  oldValue?: string | null;
  newValue?: string | null;
}

/** A frozen report row, as stored in ReportSnapshot.rowsJson. */
export interface ReportRow {
  projectId: string;
  name: string;
  serviceArea: ServiceArea;
  owner: string;
  physicianChampion: string | null;
  status: ProjectStatus;
  statusLabel: string;
  nextMilestone: string | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  /** YYYY-MM-DD */
  targetCompletion: string | null;
  percentComplete: number | null;
  note: string | null;
  changed: boolean;
  overdue: boolean;
  /** YYYY-MM-DD (America/New_York) of the latest public change. Absent on snapshots before 0004. */
  updatedOn?: string | null;
  /** Status at the previous report when it differs from the current one ("from At risk"). */
  statusFrom?: ProjectStatus | null;
  /** Latest update (updatedOn) is AppConfig.STALE_AFTER_DAYS or more before the report date. Absent before 0004. */
  stale?: boolean;
}

/** Stored in ReportSnapshot.missingChampionsJson. */
export interface MissingChampion {
  name: string;
  email: string | null;
  projectIds: string[];
  projectNames: string[];
}

export type StatusCounts = Record<ProjectStatus, number>;

/**
 * Report header data, stored in ReportSnapshot.headerJson. Computed from the visible (listed)
 * rows only, so totalProjects always equals rows.length. Nothing about hidden items appears here.
 */
export interface ReportHeader {
  totalProjects: number;
  totals: StatusCounts;
  /** Per service area status counts (repeated in the page header for each area). */
  byArea: Record<ServiceArea, StatusCounts>;
  overdue: number;
  changed: number;
  /** Absent on snapshots before 0004. */
  stale?: number;
}
