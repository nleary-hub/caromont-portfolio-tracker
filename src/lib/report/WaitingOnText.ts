/** One open blocker as the "Waiting on" line lists it. */
export type WaitingOnItem =
  /** A Blocked-by dependency: the blocking project's name, plus the dependency note when there is one. */
  | { kind: "project"; name: string; note: string | null }
  /** An open external blocker: who or what it's waiting on, then its description. */
  | { kind: "external"; waitingOn: string; description: string };

/**
 * The text of ReportRow.waitingOn (PDF "Waiting on:" line). Pure, so the report loader and the fictional sample build
 * exactly the same string. Dependencies first, then external blockers, each in the order given (oldest first), joined
 * with "; ". Null when there are none, so the row gets no key at all. No dates, no filtering: every open item prints.
 */
export class WaitingOnText {
  static readonly SEPARATOR = "; ";

  static item(i: WaitingOnItem): string {
    const clean = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
    if (i.kind === "project") {
      const note = clean(i.note);
      return note ? `${clean(i.name)}: ${note}` : clean(i.name);
    }
    const description = clean(i.description);
    return description ? `${clean(i.waitingOn)}: ${description}` : clean(i.waitingOn);
  }

  static build(items: readonly WaitingOnItem[]): string | null {
    const ordered = [...items.filter((i) => i.kind === "project"), ...items.filter((i) => i.kind === "external")];
    const text = ordered.map(WaitingOnText.item).filter(Boolean).join(WaitingOnText.SEPARATOR);
    return text ? text : null;
  }
}
