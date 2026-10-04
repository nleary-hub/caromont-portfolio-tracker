import { AppConfig } from "@/lib/config/AppConfig";

/**
 * The dashboard "Latest update" line: the project's current note (the latest update), composed the way the
 * PDF prints it under the next milestone. Like the PDF there is no date before it (the "Updated <date>"
 * sits on the meta line under the project name) and whitespace is collapsed. When nothing changed since
 * the last report the PDF prefixes "No change.", even when the note is blank; a changed row with a blank
 * note prints nothing. Both print the line regular in the secondary color, under a semibold milestone.
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
   * nothing to print. `muted` = unchanged since the last report (the line is secondary either way).
   */
  static line(row: { note: string | null | undefined; changed: boolean }): { prefix: string | null; text: string | null; full: string; muted: boolean; clipped?: true } | null {
    const whole = LatestUpdate.text(row);
    const text = whole === null ? null : LatestUpdate.clip(whole);
    const prefix = row.changed ? null : LatestUpdate.NO_CHANGE_PREFIX;
    const full = [prefix, text].filter(Boolean).join(" ");
    if (!full) return null;
    return { prefix, text, full, muted: !row.changed, ...(text !== whole ? { clipped: true as const } : {}) };
  }

  /** Ellipsis that ends a clipped line (the same "…" the PDF uses). */
  static readonly ELLIPSIS = "\u2026";

  /** Tooltip on clipped dashboard text (Writing Bot). Not used in the PDF. */
  static readonly CLIPPED_TOOLTIP = "Open the project to read the full text";

  /**
   * Dashboard display cap: notes can be 2,000 characters (AppConfig.NOTE_MAX_LENGTH) but the dashboard shows at most
   * NOTE_DISPLAY_MAX_LENGTH (200), then "…". Notes of 200 characters or fewer (all notes saved before the cap was raised)
   * show exactly as before.
   */
  static clip(text: string, max: number = AppConfig.NOTE_DISPLAY_MAX_LENGTH): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max).trimEnd()}${LatestUpdate.ELLIPSIS}`;
  }
}
