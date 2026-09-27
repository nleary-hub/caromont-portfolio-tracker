import { PeopleDirectory, type NameSegment, type PeopleRole } from "@/lib/people/PeopleDirectory";

/** A people field's value as the combobox holds it. Owner never uses "na". */
export type PeopleValue = { kind: "name"; name: string } | { kind: "na" } | { kind: "unset" };

/** A pickable row. */
export interface ComboOption {
  type: "option";
  /** Stable DOM-safe key (used for aria-activedescendant). */
  key: string;
  variant: "pinned" | "name" | "add";
  label: string;
  /** Name split around the typed text (name rows only). */
  segments: NameSegment[];
  /** What choosing the row sets. */
  value: PeopleValue;
  /** The field's current value (shows a check). */
  current: boolean;
}

export type ComboRow = ComboOption | { type: "divider" } | { type: "message"; text: string };

/** A save call for the existing admin server action (field + string value). */
export interface PeopleSave {
  field: "owner" | "physicianChampion" | "requesterNotApplicable";
  value: string;
}

/**
 * Pure logic for the owner and requester comboboxes (rows, default highlight, what a pick saves), kept
 * out of the React component so it is unit-tested. Rows: pinned actions (Requester: Not applicable and
 * Clear (To assign); Owner: Clear (To assign)), a divider, the names A to Z filtered by the typed text,
 * a message row when nothing is listed, and "Add 'X'" last.
 */
export class PeopleComboboxModel {
  static readonly NOT_APPLICABLE = "Not applicable";
  static readonly CLEAR = "Clear (To assign)";
  static readonly TO_ASSIGN = "To assign";
  static readonly NO_MATCH = "No match";
  static readonly EMPTY = "No names yet. Type to add one.";
  /** Gray tag on a closed field whose name is not on the line's list (Admin > People), e.g. Mark Wingard. */
  static readonly NOT_ON_LIST = "Not on list";

  /** Value from the stored project fields. */
  /** Whether the current value is a name the list doesn't offer (ignoring case and spacing). Legacy "To assign" text is built in, not off-list. */
  static offList(value: PeopleValue, options: readonly string[]): boolean {
    return value.kind === "name" && value.name.trim() !== "" && !PeopleDirectory.isSentinel(value.name) && !PeopleDirectory.find(options, value.name);
  }

  static valueOf(name: string | null | undefined, notApplicable = false): PeopleValue {
    const n = PeopleDirectory.normalizeName(name);
    if (n) return { kind: "name", name: n };
    return notApplicable ? { kind: "na" } : { kind: "unset" };
  }

  /** Closed-field text: the name in primary text; "To assign" or "Not applicable" in gray. */
  static display(value: PeopleValue): { text: string; muted: boolean } {
    if (value.kind === "name") return { text: value.name, muted: false };
    return { text: value.kind === "na" ? PeopleComboboxModel.NOT_APPLICABLE : PeopleComboboxModel.TO_ASSIGN, muted: true };
  }

  /** "Add 'X'" label (straight quotes, as specced). */
  static addLabel(name: string): string {
    return `Add '${name}'`;
  }

  /**
   * Rows for the open popover. `filtering` is false right after opening (the field still shows the
   * current name, so every name is listed); typing turns it on.
   */
  static rows(role: PeopleRole, options: readonly string[], query: string, filtering: boolean, current: PeopleValue): ComboRow[] {
    const q = filtering ? query : "";
    const rows: ComboRow[] = [];
    if (role === "requester") rows.push(PeopleComboboxModel.pinned("na", PeopleComboboxModel.NOT_APPLICABLE, { kind: "na" }, current.kind === "na"));
    rows.push(PeopleComboboxModel.pinned("clear", PeopleComboboxModel.CLEAR, { kind: "unset" }, current.kind === "unset"));
    rows.push({ type: "divider" });
    const names = PeopleDirectory.filter(options, q);
    names.forEach((name, i) =>
      rows.push({
        type: "option",
        key: `name-${i}`,
        variant: "name",
        label: name,
        segments: PeopleDirectory.segments(name, q),
        value: { kind: "name", name },
        current: current.kind === "name" && current.name.toLowerCase() === name.toLowerCase(),
      }),
    );
    if (options.length === 0) rows.push({ type: "message", text: PeopleComboboxModel.EMPTY });
    else if (names.length === 0) rows.push({ type: "message", text: PeopleComboboxModel.NO_MATCH });
    const add = PeopleDirectory.addCandidate(options, q);
    if (add) {
      rows.push({
        type: "option",
        key: "add",
        variant: "add",
        label: PeopleComboboxModel.addLabel(add),
        segments: [{ text: PeopleComboboxModel.addLabel(add), match: false }],
        value: { kind: "name", name: add },
        current: false,
      });
    }
    return rows;
  }

  /** The pickable rows, in order (what Up and Down move through). */
  static options(rows: readonly ComboRow[]): ComboOption[] {
    return rows.filter((r): r is ComboOption => r.type === "option");
  }

  /**
   * Default highlight (index into options()): while filtering, the first matching name, else Add; right
   * after opening, the current name when listed, else the first name, else the first pinned row.
   */
  static defaultHighlight(rows: readonly ComboRow[], filtering: boolean): number {
    const opts = PeopleComboboxModel.options(rows);
    if (!filtering) {
      const cur = opts.findIndex((o) => o.variant === "name" && o.current);
      if (cur >= 0) return cur;
    }
    const firstName = opts.findIndex((o) => o.variant === "name");
    if (firstName >= 0) return firstName;
    const add = opts.findIndex((o) => o.variant === "add");
    if (add >= 0) return add;
    return opts.length > 0 ? 0 : -1;
  }

  /** Next highlight for ArrowUp or ArrowDown (clamped at the ends). */
  static move(index: number, delta: 1 | -1, count: number): number {
    if (count === 0) return -1;
    if (index < 0) return delta > 0 ? 0 : count - 1;
    return Math.min(count - 1, Math.max(0, index + delta));
  }

  /** The server action call a pick makes, or null when it would not change anything. */
  static saveFor(role: PeopleRole, next: PeopleValue, current: PeopleValue): PeopleSave | null {
    if (PeopleComboboxModel.same(next, current)) return null;
    const field = role === "owner" ? "owner" : "physicianChampion";
    if (next.kind === "na") return role === "requester" ? { field: "requesterNotApplicable", value: "true" } : null;
    if (next.kind === "unset") return { field, value: "" };
    return { field, value: PeopleDirectory.normalizeName(next.name) };
  }

  static same(a: PeopleValue, b: PeopleValue): boolean {
    if (a.kind !== b.kind) return false;
    return a.kind !== "name" || b.kind !== "name" || a.name === b.name;
  }

  private static pinned(key: string, label: string, value: PeopleValue, current: boolean): ComboOption {
    return { type: "option", key, variant: "pinned", label, segments: [{ text: label, match: false }], value, current };
  }
}
