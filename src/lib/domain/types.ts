import type { ProjectStatus, RecipientLine } from "@/generated/prisma/enums";
import type { MilestoneCount } from "@/lib/domain/MilestoneProgress";
import type { AreaGroup, DepartmentKey } from "@/lib/domain/ServiceAreaInfo";

/** Fields of a Project that the domain logic needs. Structurally compatible with the Prisma model. */
export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  /** Optional Infor request number, whole number 1 to 99999 (null = none). Displayed as "REQ-5081". */
  inforRequestNumber: number | null;
  /** Null = Unassigned (grouped last). */
  serviceArea: DepartmentKey | null;
  /** Null = not assigned yet (shown as "To assign"). */
  owner: string | null;
  physicianChampion: string | null;
  physicianChampionEmail: string | null;
  requesterNotApplicable: boolean;
  /** One of AppConfig.CONTRACTS_LEADS, or null ("To assign"). */
  contractsLead: string | null;
  status: ProjectStatus;
  /** After MilestoneProgress.applyAll: the derived next milestone (first step not done), else the legacy text. */
  nextMilestone: string | null;
  /** After MilestoneProgress.applyAll: the next step's due date, else the legacy due date. */
  dueDate: Date | null;
  /** Checklist done/total (MilestoneProgress.applyAll). Absent or null: no steps, legacy fields in use. */
  milestoneProgress?: MilestoneCount | null;
  targetCompletion: Date | null;
  percentComplete: number | null;
  note: string | null;
  /** What the finished project accomplished (optional). */
  accomplishment: string | null;
  /** Completion date as entered (display only; not the "Completed this period" clock). */
  completedOn: Date | null;
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
  serviceArea: DepartmentKey | null;
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
  /** Null = Unassigned (grouped last). */
  serviceArea: DepartmentKey | null;
  /** Null = not assigned yet (shown as "To assign"). */
  owner: string | null;
  physicianChampion: string | null;
  /** Requester marked Not applicable (renders blank). Absent in snapshots frozen before it existed. */
  requesterNotApplicable?: boolean;
  status: ProjectStatus;
  statusLabel: string;
  nextMilestone: string | null;
  /** YYYY-MM-DD */
  dueDate: string | null;
  /** YYYY-MM-DD */
  targetCompletion: string | null;
  percentComplete: number | null;
  note: string | null;
  /** Infor request number. Absent on snapshots frozen before 0011. */
  inforRequestNumber?: number | null;
  /** Contracts lead. Absent on snapshots frozen before 0013. */
  contractsLead?: string | null;
  /**
   * Checklist done/total for the "X of Y" label (MilestoneProgress.progressLabel decides when it shows).
   * Absent for projects without steps and on snapshots frozen before 0015. Not part of handoff.json.
   */
  milestoneProgress?: MilestoneCount | null;
  changed: boolean;
  overdue: boolean;
  /** YYYY-MM-DD (America/New_York) of the latest public change. Absent on snapshots before 0004. */
  updatedOn?: string | null;
  /** Status at the previous report when it differs from the current one ("from At risk"). */
  statusFrom?: ProjectStatus | null;
  /** Latest update (updatedOn) is AppConfig.STALE_AFTER_DAYS or more before the report date. Absent before 0004. */
  stale?: boolean;
  /**
   * Completed since the previous report's freeze (PeriodClosure): listed in its department group with its Complete
   * chip even though Complete is hidden in the report. Present only when true.
   */
  completedInPeriod?: true;
}

/** One row of a "Completed this period" block, as stored in ReportSnapshot.completedJson. */
export interface CompletedRow {
  projectId: string;
  name: string;
  /** Null = Unassigned (grouped last). */
  serviceArea: DepartmentKey | null;
  /** Null = not assigned yet (shown as "To assign"). */
  owner: string | null;
  accomplishment: string | null;
  /** YYYY-MM-DD shown in the report: completedOn when set, else the in-app completion date. */
  completedOn: string;
  /** YYYY-MM-DD (America/New_York) when the status became Complete in the app (the period clock). */
  completedInAppOn: string;
  inforRequestNumber: number | null;
  physicianChampion: string | null;
  /** Requester marked Not applicable (renders blank). Absent in snapshots frozen before it existed. */
  requesterNotApplicable?: boolean;
  /** Absent on snapshots frozen before 0013. */
  contractsLead?: string | null;
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
  /** Per department, plus "Unassigned" (absent on snapshots frozen before 0012: read with ReportBuilder.areaCounts). */
  byArea: Partial<Record<AreaGroup, StatusCounts>>;
  overdue: number;
  changed: number;
  /** Absent on snapshots before 0004. */
  stale?: number;
  /** "Completed FY27 to date N" (page 1). Frozen with the header; absent on older snapshots. */
  completedFiscalYear?: FiscalYearCount;
}

/** Fiscal-year-to-date completed count. */
export interface FiscalYearCount {
  /** "FY27" */
  label: string;
  /** YYYY-MM-DD first day of the fiscal year. */
  start: string;
  count: number;
}
