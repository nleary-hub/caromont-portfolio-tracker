/** One history row as stored (one row per changed field). */
export interface HistoryRowLike {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
  changedBy: string;
  comment?: string | null;
}

/** One logical change: every field row written by one save (same timestamp, same author). */
export interface HistoryEntry<T extends HistoryRowLike = HistoryRowLike> {
  changedAt: Date;
  changedBy: string;
  rows: T[];
}

/**
 * History is stored one row per changed field, so existing readers (Completed this period, status
 * moves, the Changed flag) keep working. A save writes all of its rows with one timestamp in one
 * transaction; HistoryEntries turns those rows back into one entry per save for a timeline.
 */
export class HistoryEntries {
  static group<T extends HistoryRowLike>(rows: readonly T[]): HistoryEntry<T>[] {
    const byKey = new Map<string, HistoryEntry<T>>();
    for (const row of rows) {
      const key = `${row.changedAt.getTime()}|${row.changedBy}`;
      const entry = byKey.get(key);
      if (entry) entry.rows.push(row);
      else byKey.set(key, { changedAt: row.changedAt, changedBy: row.changedBy, rows: [row] });
    }
    return [...byKey.values()].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
  }
}
