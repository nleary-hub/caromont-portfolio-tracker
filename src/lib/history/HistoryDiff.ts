import { DateOnly } from "@/lib/domain/DateOnly";

export interface FieldChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

/** Computes field-level differences for ProjectHistory rows. */
export class HistoryDiff {
  /** Fields tracked in history, in a stable order. */
  static readonly TRACKED_FIELDS = [
    "name",
    "serviceArea",
    "owner",
    "physicianChampion",
    "physicianChampionEmail",
    "status",
    "nextMilestone",
    "dueDate",
    "targetCompletion",
    "percentComplete",
    "note",
    "includeInReport",
    "archivedAt",
    "closedReportedAt",
  ] as const;

  /** Fields stored as DATE (serialize as YYYY-MM-DD) vs timestamps (full ISO). */
  private static readonly DATE_ONLY_FIELDS: ReadonlySet<string> = new Set(["dueDate", "targetCompletion"]);

  static serialize(field: string, value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
      return HistoryDiff.DATE_ONLY_FIELDS.has(field) ? DateOnly.fromDbDate(value) : value.toISOString();
    }
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }

  /** Changes for tracked fields present in `after` whose serialized value differs from `before`. */
  static diff(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
    const changes: FieldChange[] = [];
    for (const field of HistoryDiff.TRACKED_FIELDS) {
      if (!(field in after)) continue;
      const oldValue = HistoryDiff.serialize(field, before[field]);
      const newValue = HistoryDiff.serialize(field, after[field]);
      if (oldValue !== newValue) changes.push({ field, oldValue, newValue });
    }
    return changes;
  }
}
