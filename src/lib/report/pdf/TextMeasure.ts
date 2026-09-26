import { create, type Font } from "fontkit";
import { ReportFonts, type FontWeight } from "@/lib/report/pdf/ReportFonts";

/** Measures text for layout. Injected into the paginator so tests could swap it; the default uses the embedded Inter. */
export interface Measurer {
  width(text: string, sizePt: number, weight: FontWeight): number;
}

/**
 * Text measurement and wrapping with the same font files the PDF embeds, so line breaks computed
 * here are the line breaks that get drawn (each line is rendered as its own unwrapped text run).
 */
export class TextMeasure implements Measurer {
  static readonly ELLIPSIS = "\u2026";
  private static readonly fonts = new Map<FontWeight, Font>();
  private readonly cache = new Map<string, number>();

  private static font(weight: FontWeight): Font {
    let f = TextMeasure.fonts.get(weight);
    if (!f) {
      f = create(ReportFonts.bytes(weight)) as Font;
      TextMeasure.fonts.set(weight, f);
    }
    return f;
  }

  width(text: string, sizePt: number, weight: FontWeight): number {
    const key = `${weight}|${text}`;
    let units = this.cache.get(key);
    if (units === undefined) {
      const f = TextMeasure.font(weight);
      units = f.layout(text).advanceWidth / f.unitsPerEm;
      this.cache.set(key, units);
    }
    return units * sizePt;
  }

  /**
   * Greedy word wrap into lines no wider than `maxWidth`. Words longer than a line are broken by
   * character. With `maxLines`, the last kept line is clipped and ends in an ellipsis.
   */
  static wrap(
    m: Measurer,
    text: string,
    maxWidth: number,
    sizePt: number,
    weight: FontWeight,
    maxLines = Number.POSITIVE_INFINITY,
  ): string[] {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length === 0) return [];
    const fits = (s: string) => m.width(s, sizePt, weight) <= maxWidth;
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (fits(candidate)) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = "";
      let rest = word;
      while (!fits(rest)) {
        let i = rest.length - 1;
        while (i > 1 && !fits(rest.slice(0, i))) i -= 1;
        lines.push(rest.slice(0, i));
        rest = rest.slice(i);
      }
      current = rest;
    }
    if (current) lines.push(current);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = TextMeasure.clip(m, `${kept[maxLines - 1]} ${lines[maxLines]}`, maxWidth, sizePt, weight);
    return kept;
  }

  /** Longest prefix of `text` that fits with a trailing ellipsis (trailing spaces and punctuation trimmed). */
  static clip(m: Measurer, text: string, maxWidth: number, sizePt: number, weight: FontWeight): string {
    let end = text.length;
    const withEllipsis = (n: number) => `${text.slice(0, n).replace(/[\s,;:.]+$/, "")}${TextMeasure.ELLIPSIS}`;
    while (end > 0 && m.width(withEllipsis(end), sizePt, weight) > maxWidth) end -= 1;
    return withEllipsis(end);
  }

  /** Single line: the text if it fits, else clipped with an ellipsis. */
  static fitLine(m: Measurer, text: string, maxWidth: number, sizePt: number, weight: FontWeight): string {
    return m.width(text, sizePt, weight) <= maxWidth ? text : TextMeasure.clip(m, text, maxWidth, sizePt, weight);
  }
}
