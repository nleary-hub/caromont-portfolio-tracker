import { AiNumberCheck } from "./AiNumberCheck";

/** One run of the suggestion text: plain, a word that is not in the original, or a missing number or date. */
export interface AiMarkSegment {
  text: string;
  mark: "word" | "number" | null;
}

/**
 * Marks for the suggestion column (pure, unit tested). Words that are not in the original get a subtle fill (simple
 * word-level diff: case-insensitive, punctuation ignored; consecutive new words on one line form one mark). Numbers and
 * dates the number check can't find in the original get the amber underline. Amber wins: a missing number is never also
 * a word mark, and numbers that are in the original (in any format) are never word-marked.
 */
export class AiSuggestionMarks {
  private static readonly WORD = /[\p{L}\p{N}][\p{L}\p{N}'\u2019.,-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu;

  static normalize(word: string): string {
    return word
      .toLowerCase()
      .replace(/['\u2019]s$/u, "")
      .replace(/[^\p{L}\p{N}]/gu, "");
  }

  static segments(original: string, suggestion: string): AiMarkSegment[] {
    const have = new Set<string>();
    for (const m of original.matchAll(AiSuggestionMarks.WORD)) for (const w of AiSuggestionMarks.split(m[0])) have.add(w);
    const missing = AiNumberCheck.missingTokens(original, suggestion);
    const numbers = AiNumberCheck.tokens(suggestion);
    const ranges: { start: number; end: number; mark: "word" | "number" }[] = missing.map((t) => ({ start: t.start, end: t.end, mark: "number" as const }));
    const covered = (s: number, e: number) => numbers.some((t) => s < t.end && e > t.start) || missing.some((t) => s < t.end && e > t.start);
    for (const m of suggestion.matchAll(AiSuggestionMarks.WORD)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (covered(start, end)) continue;
      const parts = AiSuggestionMarks.split(m[0]);
      if (parts.length === 0 || parts.every((p) => have.has(p))) continue;
      const prev = ranges.at(-1);
      if (prev && prev.mark === "word" && /^[ \t]+$/.test(suggestion.slice(prev.end, start))) prev.end = end;
      else ranges.push({ start, end, mark: "word" });
    }
    ranges.sort((a, b) => a.start - b.start);
    const out: AiMarkSegment[] = [];
    let at = 0;
    for (const r of ranges) {
      if (r.start < at) continue;
      if (r.start > at) out.push({ text: suggestion.slice(at, r.start), mark: null });
      out.push({ text: suggestion.slice(r.start, r.end), mark: r.mark });
      at = r.end;
    }
    if (at < suggestion.length) out.push({ text: suggestion.slice(at), mark: null });
    return out;
  }

  /** Screen-reader values, amber (missing numbers and dates) first, each once. */
  static announced(segments: readonly AiMarkSegment[]): string[] {
    const list: string[] = [];
    for (const kind of ["number", "word"] as const) for (const s of segments) if (s.mark === kind && !list.includes(s.text)) list.push(s.text);
    return list;
  }

  /** "trade-in" and "data/security" count as their parts; punctuation inside a word is ignored. */
  private static split(word: string): string[] {
    return word
      .split(/[-\u2013/]/)
      .map((w) => AiSuggestionMarks.normalize(w))
      .filter(Boolean);
  }
}
