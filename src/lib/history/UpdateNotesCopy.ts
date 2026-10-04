/**
 * Project detail > Update notes (task 4). "Update notes" and the Show all / Show fewer wording are placeholders until
 * Writing Bot's copy lands. No em dashes.
 */
export class UpdateNotesCopy {
  static readonly TITLE = "Update notes";
  static readonly EMPTY = "No update notes yet.";
  static readonly SHOW_FEWER = "Show fewer";
  /** An edit that emptied the note (no text was entered). */
  static readonly CLEARED = "Note cleared.";

  static showAll(count: number): string {
    return `Show all ${count} updates`;
  }
}
