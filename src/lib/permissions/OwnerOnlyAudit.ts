/**
 * L3 (matrix 4.7): audit events about Owner-only surfaces. Non-owners never see, count or page them, and no filter
 * option names them. Matched on the event kind and field, never on free text.
 */
export class OwnerOnlyAudit {
  static readonly KINDS: readonly string[] = ["reportColors", "reportOptions", "freeze", "snapshot", "delivery", "yearEndStored", "ownerOnlyDenied"];
  static readonly FIELD_PREFIXES: readonly string[] = ["reportColors.", "reportOptions.", "freeze.", "snapshot.", "delivery.", "year_end.stored", "owner_only_denied"];

  static isOwnerOnly(e: { kind: string; field: string }): boolean {
    return OwnerOnlyAudit.KINDS.includes(e.kind) || OwnerOnlyAudit.FIELD_PREFIXES.some((p) => e.field.startsWith(p));
  }

  static visible<T extends { kind: string; field: string }>(events: readonly T[], isOwner: boolean): T[] {
    return isOwner ? [...events] : events.filter((e) => !OwnerOnlyAudit.isOwnerOnly(e));
  }
}
