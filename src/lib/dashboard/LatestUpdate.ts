/**
 * The dashboard "Latest update" line: the project's current note (the latest update), composed the way the
 * PDF prints it under the next milestone. Like the PDF there is no date before it (the "Updated <date>"
 * sits on the meta line under the project name) and whitespace is collapsed. When nothing changed since
 * the last report the PDF prefixes "No change." and prints the whole line in the secondary color, even
 * when the note is blank; a changed row with a blank note prints nothing.
 */
export class LatestUpdate {
  /** Empty-cell glyph. A UI glyph, not prose, so it is the one place an em dash is rendered. */
  static readonly EMPTY_NOTE_GLYPH = "\u2014";

  /** Prefix the PDF shows (secondary color) when the row did not change since the last report. */
  static readonly NO_CHANGE_PREFIX = "No change.";

  /** The note to show, whitespace collapsed, or null when blank. */
  static text(row: { note: string | null | undefined }): string | null {
    const t = row.note?.replace(/\s+/g, " ").trim() ?? "";
    return t === "" ? null : t;
  }

  /**
   * The composed line as the PDF prints it: prefix (unchanged rows only) plus note, or null when there is
   * nothing to print. `muted` = the whole line is secondary (unchanged rows).
   */
  static line(row: { note: string | null | undefined; changed: boolean }): { prefix: string | null; text: string | null; full: string; muted: boolean } | null {
    const text = LatestUpdate.text(row);
    const prefix = row.changed ? null : LatestUpdate.NO_CHANGE_PREFIX;
    const full = [prefix, text].filter(Boolean).join(" ");
    if (!full) return null;
    return { prefix, text, full, muted: !row.changed };
  }
}
