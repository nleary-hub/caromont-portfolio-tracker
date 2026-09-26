/**
 * The dashboard "Latest update" column: the project's current note (the latest update, the same text the
 * PDF prints on line 2 of each row). Like the PDF there is no date before it (the "Updated <date>" sits on
 * the meta line under the project name) and whitespace is collapsed. The PDF also prefixes "No change."
 * when nothing changed since the last report; the dashboard shows that with the Changed flag instead.
 */
export class LatestUpdate {
  /** Shown when there is no note. A UI glyph, not prose, so it is the one place an em dash is rendered. */
  static readonly EMPTY_NOTE_GLYPH = "\u2014";

  /** Lines shown before the cell clamps (full text on hover or focus, and in the drawer). */
  static readonly CLAMP_LINES = 3;

  /** The note to show, whitespace collapsed, or null when blank. */
  static text(row: { note: string | null | undefined }): string | null {
    const t = row.note?.replace(/\s+/g, " ").trim() ?? "";
    return t === "" ? null : t;
  }
}
