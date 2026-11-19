import type { ParsedPrice, PricingParseResult } from "./OpenAiPricingParser";

/**
 * Parser for Anthropic's published model-pricing table.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing.md (the markdown of the pricing page).
 *
 * It reads the first table under "## Model pricing". Prices are USD per million tokens: "Base input tokens"
 * and "Output tokens". A footnote digit glued to "MTok" ($2 / MTok3) is not part of the amount.
 * The first row for a name wins, so Claude Haiku 5.5 keeps the shorter-prompt price (the row listed first)
 * and not the long-prompt price. A name that isn't in the table is simply absent. Nothing here invents a price.
 */
export class AnthropicPricingParser {
  static readonly SOURCE_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
  static readonly HEADING = "## Model pricing";

  static parse(markdown: unknown): PricingParseResult {
    if (typeof markdown !== "string" || !markdown.trim()) return { ok: false, reason: "format_changed" };
    const lines = markdown.split(/\r?\n/);
    const at = lines.findIndex((l) => l.trim() === AnthropicPricingParser.HEADING);
    if (at < 0) return { ok: false, reason: "format_changed" };
    const table = AnthropicPricingParser.tableAfter(lines, at + 1);
    if (!table) return { ok: false, reason: "format_changed" };
    const header = table.header.map((h) => h.toLowerCase());
    const modelCol = header.findIndex((h) => h === "model");
    const inCol = header.findIndex((h) => h.includes("base input"));
    const outCol = header.findIndex((h) => h.startsWith("output"));
    if (modelCol < 0 || inCol < 0 || outCol < 0) return { ok: false, reason: "format_changed" };
    const out = new Map<string, ParsedPrice>();
    for (const row of table.rows) {
      const name = AnthropicPricingParser.displayKey(row[modelCol] ?? "");
      const input = AnthropicPricingParser.money(row[inCol]);
      const output = AnthropicPricingParser.money(row[outCol]);
      if (name && input !== null && output !== null && !out.has(name)) out.set(name, { model: name, unit: "per_1m_tokens", input, output });
    }
    return out.size ? { ok: true, prices: [...out.values()] } : { ok: false, reason: "format_changed" };
  }

  /**
   * The pricing-table name for an API id, when the id is a Claude id we can read.
   * `claude-sonnet-5-5-20260101` → "Claude Sonnet 5.5". A date suffix is dropped.
   * Null when the id isn't that shape, so the caller shows the price as not listed rather than guessing.
   */
  static displayName(id: string): string | null {
    let s = id.trim().toLowerCase().replace(/-\d{8}$/, "");
    const legacy = /^claude-(\d+)(?:-(\d+))?-([a-z]+)$/.exec(s);
    if (legacy) {
      const ver = legacy[2] ? `${legacy[1]}.${legacy[2]}` : legacy[1];
      return `Claude ${ver} ${AnthropicPricingParser.cap(legacy[3])}`;
    }
    const modern = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(s);
    if (!modern) return null;
    const ver = modern[3] ? `${modern[2]}.${modern[3]}` : modern[2];
    return `Claude ${AnthropicPricingParser.cap(modern[1])} ${ver}`;
  }

  /** Lookup key shared by a table cell and displayName. */
  static displayKey(name: string): string {
    return name
      .replace(/\([^)]*\)/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, " ")
      .trim();
  }

  /** The parsed price for an API id, or null when the id or the table doesn't have it. */
  static priceFor(prices: readonly ParsedPrice[], id: string): ParsedPrice | null {
    const name = AnthropicPricingParser.displayName(id);
    if (!name) return null;
    const key = AnthropicPricingParser.displayKey(name);
    return prices.find((p) => p.model === key) ?? null;
  }

  private static cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private static money(cell: string | undefined): number | null {
    const m = /\$(\d+(?:\.\d+)?)/.exec((cell ?? "").replace(/,/g, ""));
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  private static tableAfter(lines: readonly string[], from: number): { header: string[]; rows: string[][] } | null {
    let i = from;
    while (i < lines.length && !lines[i].trim().startsWith("|")) {
      if (i > from && lines[i].trim().startsWith("#")) return null;
      i++;
    }
    const header = AnthropicPricingParser.cells(lines[i]);
    const sep = AnthropicPricingParser.cells(lines[i + 1]);
    if (!header || !sep || !sep.every((c) => /^:?-{3,}:?$/.test(c))) return null;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const c = AnthropicPricingParser.cells(lines[j]);
      if (!c) break;
      rows.push(c);
    }
    return { header, rows };
  }

  private static cells(line: string | undefined): string[] | null {
    const s = line?.trim();
    if (!s || !s.startsWith("|") || !s.endsWith("|")) return null;
    return s.slice(1, -1).split("|").map((c) => c.trim());
  }
}
