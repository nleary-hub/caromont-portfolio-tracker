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
  closedReportedAt: Date | null;
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
}

/** Stored in ReportSnapshot.missingChampionsJson. */
export interface MissingChampion {
  name: string;
  email: string | null;
  projectIds: string[];
  projectNames: string[];
}
