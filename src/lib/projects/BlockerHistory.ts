/** Stored in dependency_* history values (JSON). */
export interface DependencyHistoryValue {
  /** The blocking project. */
  projectId: string;
  name: string;
  note: string | null;
  milestone: string | null;
}

/** Stored in blocker_* history values (JSON). */
export interface BlockerHistoryValue {
  id: string;
  description: string;
  waitingOn: string;
  followUpOn: string | null;
  followUpOwner: string | null;
  milestone: string | null;
  resolution?: string | null;
}

/**
 * History fields for dependencies and external blockers (migration 0055), written on the BLOCKED project in the same
 * transaction as the change. Nick decided (Oct 17, 2026) these are not updates: they are listed in
 * VisibilityPolicy.NOT_AN_UPDATE_HISTORY_FIELDS, so they never set Changed or Stale and never move "Updated".
 */
export class BlockerHistory {
  static readonly DEPENDENCY_ADDED = "dependency_added";
  static readonly DEPENDENCY_UPDATED = "dependency_updated";
  static readonly DEPENDENCY_REMOVED = "dependency_removed";
  static readonly BLOCKER_ADDED = "blocker_added";
  static readonly BLOCKER_UPDATED = "blocker_updated";
  static readonly BLOCKER_RESOLVED = "blocker_resolved";

  static readonly FIELDS: readonly string[] = [
    BlockerHistory.DEPENDENCY_ADDED,
    BlockerHistory.DEPENDENCY_UPDATED,
    BlockerHistory.DEPENDENCY_REMOVED,
    BlockerHistory.BLOCKER_ADDED,
    BlockerHistory.BLOCKER_UPDATED,
    BlockerHistory.BLOCKER_RESOLVED,
  ];

  /** Comment on a dependency_removed row written by the completion banner's Clear (1b). */
  static readonly CLEARED_ON_COMPLETE = "cleared: blocker complete";

  static isField(field: string): boolean {
    return BlockerHistory.FIELDS.includes(field);
  }

  static parse<T>(stored: string | null | undefined): T | null {
    if (!stored) return null;
    try {
      const v = JSON.parse(stored) as unknown;
      return v && typeof v === "object" ? (v as T) : null;
    } catch {
      return null;
    }
  }

  /** History timeline sentence (plain, no em dashes). */
  static text(field: string, oldValue: string | null, newValue: string | null, comment?: string | null): string | null {
    const dep = (s: string | null) => BlockerHistory.parse<DependencyHistoryValue>(s);
    const blk = (s: string | null) => BlockerHistory.parse<BlockerHistoryValue>(s);
    const extra = (v: { note?: string | null; milestone: string | null } | null, noteLabel = "waiting on") =>
      [v?.note ? `${noteLabel}: ${v.note}` : null, v?.milestone ? `holds up "${v.milestone}"` : null].filter(Boolean).join(", ");
    switch (field) {
      case BlockerHistory.DEPENDENCY_ADDED: {
        const v = dep(newValue);
        if (!v) return null;
        const more = extra(v);
        return `Added blocker project ${v.name}${more ? ` (${more})` : ""}.`;
      }
      case BlockerHistory.DEPENDENCY_UPDATED: {
        const v = dep(newValue) ?? dep(oldValue);
        if (!v) return null;
        const more = extra(dep(newValue));
        return `Changed blocker project ${v.name}${more ? ` (${more})` : ""}.`;
      }
      case BlockerHistory.DEPENDENCY_REMOVED: {
        const v = dep(oldValue);
        if (!v) return null;
        return comment === BlockerHistory.CLEARED_ON_COMPLETE ? `Cleared blocker project ${v.name} (it is complete).` : `Removed blocker project ${v.name}.`;
      }
      case BlockerHistory.BLOCKER_ADDED: {
        const v = blk(newValue);
        return v ? `Added blocker "${v.description}" (waiting on ${v.waitingOn}).` : null;
      }
      case BlockerHistory.BLOCKER_UPDATED: {
        const v = blk(newValue);
        return v ? `Changed blocker "${v.description}" (waiting on ${v.waitingOn}).` : null;
      }
      case BlockerHistory.BLOCKER_RESOLVED: {
        const before = blk(oldValue);
        const after = blk(newValue);
        if (!before) return null;
        return `Resolved blocker "${before.description}"${after?.resolution ? `: ${after.resolution}` : ""}.`;
      }
    }
    return null;
  }
}
