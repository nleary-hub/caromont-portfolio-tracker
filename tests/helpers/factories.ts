import type { ProjectRecord, RecipientRecord } from "@/lib/domain/types";

let seq = 0;

export class Factory {
  static project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
    seq += 1;
    return {
      id: `p${seq}`,
      name: `Project ${seq}`,
      description: null,
      serviceArea: "Cath",
      owner: "Owner A",
      physicianChampion: null,
      physicianChampionEmail: null,
      status: "OnTrack",
      nextMilestone: "Kickoff",
      dueDate: null,
      targetCompletion: null,
      percentComplete: null,
      note: null,
      includeInReport: true,
      archivedAt: null,
      closedReportedAt: null,
      ...overrides,
    };
  }

  static recipient(overrides: Partial<RecipientRecord> = {}): RecipientRecord {
    seq += 1;
    return {
      id: `r${seq}`,
      name: `Recipient ${seq}`,
      email: `r${seq}@example.org`,
      role: null,
      serviceArea: null,
      line: "To",
      active: true,
      ...overrides,
    };
  }

  static date(iso: string): Date {
    return new Date(`${iso}T00:00:00Z`);
  }
}
