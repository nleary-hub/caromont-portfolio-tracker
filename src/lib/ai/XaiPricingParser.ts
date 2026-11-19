import type { ParsedPrice, PricingParseResult } from "./OpenAiPricingParser";

/**
 * Parser for xAI's published text-token prices.
 * Source: https://docs.x.ai/developers/pricing
 *
 * The text table lists each model id first, then short-context Input, Cached, and Output, then long-context prices.
 * This reads the short-context input (first dollar amount) and short-context output (third). A row without those
 * three amounts is skipped. Image, video, and voice rates are a different unit and are not turned into token prices.
 */
export class XaiPricingParser {
  static readonly SOURCE_URL = "https://docs.x.ai/developers/pricing.md";

  static parse(markdown: unknown): PricingParseResult {
    if (typeof markdown !== "string" || !markdown.trim()) return { ok: false, reason: "format_changed" };
    const out = new Map<string, ParsedPrice>();
    for (const line of markdown.split(/\r?\n/)) {
      const cells = XaiPricingParser.cells(line);
      if (!cells) continue;
      const id = XaiPricingParser.modelId(cells[0] ?? "");
      const amounts = [...(line.match(/\$(\d+(?:\.\d+)?)/g) ?? [])].map((s) => Number(s.slice(1)));
      if (!id || amounts.length < 3 || !amounts.every((n) => Number.isFinite(n))) continue;
      if (!out.has(id)) out.set(id, { model: id, unit: "per_1m_tokens", input: amounts[0], output: amounts[2] });
    }
    return out.size ? { ok: true, prices: [...out.values()] } : { ok: false, reason: "format_changed" };
  }

  private static modelId(cell: string): string | null {
    const token = cell.trim().split(/\s+/)[0]?.replace(/`/g, "") ?? "";
    return /^grok-[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(token) ? token : null;
  }

  private static cells(line: string): string[] | null {
    const s = line.trim();
    if (!s.startsWith("|") || !s.endsWith("|")) return null;
    return s.slice(1, -1).split("|").map((c) => c.trim());
  }
}
