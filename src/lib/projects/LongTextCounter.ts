/**
 * The quiet character counter under a long-text field (Latest update, milestones; 2,000 characters). Copy from
 * Writing Bot: "1,240 / 2,000", read as "1,240 of 2,000 characters used"; at the cap "2,000 / 2,000, limit reached"
 * (the field takes no more: maxLength; no error message).
 */
export class LongTextCounter {
  private static n(v: number): string {
    return v.toLocaleString("en-US");
  }

  static atCap(count: number, max: number): boolean {
    return count >= max;
  }

  /** On-screen text. */
  static text(count: number, max: number): string {
    const base = `${LongTextCounter.n(count)} / ${LongTextCounter.n(max)}`;
    return LongTextCounter.atCap(count, max) ? `${base}, limit reached` : base;
  }

  /** Screen-reader label. */
  static label(count: number, max: number): string {
    const base = `${LongTextCounter.n(count)} of ${LongTextCounter.n(max)} characters used`;
    return LongTextCounter.atCap(count, max) ? `${base}, limit reached` : base;
  }
}
