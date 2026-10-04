/** Project detail > Update notes (task 4). Final copy (Writing Bot). No em dashes. */
export class UpdateNotesCopy {
  static readonly TITLE = "Update notes";
  static readonly EMPTY = "No update notes yet.";
  static readonly SHOW_FEWER = "Show fewer";
  /** An edit that emptied the note (no text was entered). */
  static readonly CLEARED = "Note cleared.";
  /** Muted tag after the meta line of a legacy entry that kept only a shortened copy (UpdateTimeline.isShortened). */
  static readonly SHORTENED = "(shortened)";
  static readonly SHORTENED_TOOLTIP = "Only a shortened copy of this note was saved.";

  static showAll(count: number): string {
    return `Show all ${count} updates`;
  }
}
