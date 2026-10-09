/** A number or date found in a text: as written, its normalized key and where it is. */
export interface AiNumberToken {
  raw: string;
  key: string;
  start: number;
  end: number;
  /** A month and day written together ("Nov 14", "14 November"): its month and day keys. */
  parts?: readonly string[];
}

/**
 * Number check for AI output: every number and date in the suggestion must appear in the input. Compares normalized
 * tokens: digit runs ("1,200" = "1200", "09" = "9", "4.50" = "4.5"), number words (one to twelve, first, third to fifth,
 * hundred, thousand, million: matching their digits either way), month names (Sept = Sep = September) and weekday
 * names, plus "today", "tomorrow" and "yesterday". A month and day written together ("Nov 14", "14th of November") is
 * one value: it is listed and underlined as a whole, and it passes when the input has that date (or that month and that
 * number). A suggestion that fails is shown with a warning and can't be accepted in one click.
 */
export class AiNumberCheck {
  private static readonly WORDS: Record<string, string> = {
    zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
    first: "1", third: "3", fourth: "4", fifth: "5",
    half: "half", dozen: "12", hundred: "100", thousand: "1000", million: "1000000", billion: "1000000000",
  };
  private static readonly MONTHS: readonly string[] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  private static readonly DAYS: readonly string[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  private static readonly RELATIVE: ReadonlySet<string> = new Set(["today", "tomorrow", "yesterday", "tonight"]);
  private static readonly MONTH_RE = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";
  private static readonly TOKEN = new RegExp(
    [
      // Month then day: "Nov 14", "Nov. 14th", "November 14". The day is 1 to 2 digits not followed by more digits.
      `\\b(?<m1>${AiNumberCheck.MONTH_RE})\\.?\\s+(?<d1>\\d{1,2})(?:st|nd|rd|th)?\\b(?![.,]?\\d)`,
      // Day then month: "14 Nov", "14th of November".
      `\\b(?<d2>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<m2>${AiNumberCheck.MONTH_RE})\\b\\.?`,
      `\\d[\\d,]*(?:\\.\\d+)?`,
      `\\b(?:${AiNumberCheck.MONTH_RE}|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thu|fri|sat|sun|today|tomorrow|yesterday|tonight|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|third|fourth|fifth|half|dozen|hundred|thousand|million|billion)\\b\\.?`,
    ].join("|"),
    "gi",
  );

  /** Ok, or the numbers and dates in `output` (as written there) that are not in `input`. */
  static check(input: string, output: string): { ok: true } | { ok: false; missing: string[] } {
    const missing: string[] = [];
    for (const t of AiNumberCheck.missingTokens(input, output)) if (!missing.includes(t.raw)) missing.push(t.raw);
    return missing.length ? { ok: false, missing } : { ok: true };
  }

  /** Every occurrence in `output` of a number or date that is not in `input` (for underlining), in text order. */
  static missingTokens(input: string, output: string): AiNumberToken[] {
    // The input side is lenient ("may" counts as May), the output side strict, so ambiguity never causes a warning.
    const have = new Set<string>();
    for (const t of AiNumberCheck.tokens(input, false)) {
      have.add(t.key);
      for (const p of t.parts ?? []) have.add(p);
    }
    return AiNumberCheck.tokens(output).filter((t) => !(have.has(t.key) || (t.parts !== undefined && t.parts.every((p) => have.has(p)))));
  }

  static tokens(text: string, strict = true): AiNumberToken[] {
    const out: AiNumberToken[] = [];
    for (const m of text.matchAll(AiNumberCheck.TOKEN)) {
      const start = m.index ?? 0;
      const g = m.groups ?? {};
      const month = g.m1 ?? g.m2;
      const day = g.d1 ?? g.d2;
      if (month && day) {
        const mk = AiNumberCheck.key(month, strict);
        const dk = `n:${Number(day)}`;
        if (mk) {
          const raw = m[0].replace(/\.$/, "");
          out.push({ raw, key: `dt:${mk.slice(2)}:${Number(day)}`, start, end: start + raw.length, parts: [mk, dk] });
        } else {
          // A lowercase "may 5" on the strict side: only the number counts.
          const at = start + m[0].indexOf(day, g.m1 ? month.length : 0);
          out.push({ raw: day, key: dk, start: at, end: at + day.length });
        }
        continue;
      }
      const raw = m[0].replace(/\.$/, "");
      const key = AiNumberCheck.key(raw, strict);
      if (key) out.push({ raw, key, start, end: start + raw.length });
    }
    return out;
  }

  /** Words that are also ordinary English ("may", "sat"): a month or day only when capitalized (strict side). */
  private static readonly AMBIGUOUS: ReadonlySet<string> = new Set(["may", "mar", "sat", "sun", "wed"]);

  private static key(raw: string, strict: boolean): string | null {
    const low = raw.toLowerCase();
    if (/^\d/.test(raw)) {
      const n = raw.replace(/,/g, "");
      const num = Number(n);
      return Number.isFinite(num) ? `n:${num}` : `n:${n}`;
    }
    if (low in AiNumberCheck.WORDS) return `n:${AiNumberCheck.WORDS[low]}`;
    if (AiNumberCheck.RELATIVE.has(low)) return `r:${low}`;
    if (strict && AiNumberCheck.AMBIGUOUS.has(low) && !/^[A-Z]/.test(raw)) return null;
    const m3 = low.slice(0, 3);
    if (AiNumberCheck.MONTHS.includes(m3)) return `m:${m3}`;
    if (AiNumberCheck.DAYS.includes(m3)) return `d:${m3}`;
    return null;
  }
}
