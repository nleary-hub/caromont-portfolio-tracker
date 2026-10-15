/**
 * Deterministic parser for OpenAI's published pricing page in markdown form (step 3c). No AI is involved: it reads
 * markdown tables by their headings and column headers, and fails closed when the expected structure is missing.
 *
 * Source: https://developers.openai.com/api/docs/pricing.md (the markdown version of the pricing page; the old
 * https://platform.openai.com/docs/pricing.md redirects there). OpenAI documents that appending ".md" to a docs page
 * URL returns its markdown, which is stable plain text and much easier to read reliably than the HTML page.
 *
 * What it reads:
 *   1. Required: the first table under "### Standard pricing data". Its header must have a "Model" column and an
 *      input and output price column ("Input"/"Output" or "Short context input"/"Short context output"). These are
 *      prices per 1M tokens.
 *   2. Optional: any table whose header is exactly "Model | Price per minute" (per-minute models, no output price).
 * The first price found for a model wins. Model names drop a trailing note in parentheses, for example
 * "gpt-5.5 (<272K context length)" becomes "gpt-5.5".
 */
export type ParsedUnit = "per_1m_tokens" | "per_minute";

export interface ParsedPrice {
  model: string;
  unit: ParsedUnit;
  input: number;
  /** null for per-minute models. */
  output: number | null;
}

export type PricingParseResult = { ok: true; prices: ParsedPrice[] } | { ok: false; reason: "format_changed" };

export class OpenAiPricingParser {
  static readonly SOURCE_URL = "https://developers.openai.com/api/docs/pricing.md";
  static readonly STANDARD_HEADING = "### Standard pricing data";
  /** Same limit as the price fields: up to 4 decimals (DECIMAL(12,4)). */
  private static readonly MONEY = /^\$(\d{1,8}(?:\.\d{1,4})?)$/;

  static parse(markdown: unknown): PricingParseResult {
    if (typeof markdown !== "string" || !markdown.trim()) return { ok: false, reason: "format_changed" };
    const lines = markdown.split(/\r?\n/);
    const at = lines.findIndex((l) => l.trim() === OpenAiPricingParser.STANDARD_HEADING);
    if (at < 0) return { ok: false, reason: "format_changed" };
    const table = OpenAiPricingParser.tableAfter(lines, at + 1);
    if (!table) return { ok: false, reason: "format_changed" };
    const header = table.header.map((h) => h.toLowerCase());
    const modelCol = header.indexOf("model");
    const inCol = header.findIndex((h) => h === "input" || h === "short context input");
    const outCol = header.findIndex((h) => h === "output" || h === "short context output");
    if (modelCol !== 0 || inCol < 0 || outCol < 0) return { ok: false, reason: "format_changed" };

    const out = new Map<string, ParsedPrice>();
    for (const row of table.rows) {
      const model = OpenAiPricingParser.modelName(row[modelCol]);
      const input = OpenAiPricingParser.money(row[inCol]);
      const output = OpenAiPricingParser.money(row[outCol]);
      if (model && input !== null && output !== null && !out.has(model)) out.set(model, { model, unit: "per_1m_tokens", input, output });
    }
    if (out.size === 0) return { ok: false, reason: "format_changed" };

    for (let i = 0; i < lines.length; i++) {
      const cells = OpenAiPricingParser.cells(lines[i]);
      if (!cells || cells.length !== 2 || cells[0].toLowerCase() !== "model" || cells[1].toLowerCase() !== "price per minute") continue;
      const t = OpenAiPricingParser.tableAfter(lines, i);
      for (const row of t?.rows ?? []) {
        const model = OpenAiPricingParser.modelName(row[0]);
        const input = OpenAiPricingParser.money(row[1]);
        if (model && input !== null && !out.has(model)) out.set(model, { model, unit: "per_minute", input, output: null });
      }
    }
    return { ok: true, prices: [...out.values()] };
  }

  /** The first markdown table at or after `from` (blank lines and prose before it are skipped; another heading stops). */
  private static tableAfter(lines: readonly string[], from: number): { header: string[]; rows: string[][] } | null {
    let i = from;
    while (i < lines.length && !lines[i].trim().startsWith("|")) {
      if (i > from && lines[i].trim().startsWith("#")) return null;
      i++;
    }
    const header = OpenAiPricingParser.cells(lines[i]);
    const sep = OpenAiPricingParser.cells(lines[i + 1]);
    if (!header || !sep || !sep.every((c) => /^:?-{3,}:?$/.test(c))) return null;
    const rows: string[][] = [];
    for (let j = i + 2; j < lines.length; j++) {
      const c = OpenAiPricingParser.cells(lines[j]);
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

  private static modelName(cell: string | undefined): string | null {
    const s = (cell ?? "").replace(/\s*\([^)]*\)\s*$/, "").replace(/`/g, "").trim();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(s) ? s : null;
  }

  private static money(cell: string | undefined): number | null {
    const m = OpenAiPricingParser.MONEY.exec((cell ?? "").replace(/,/g, "").trim());
    return m ? Number(m[1]) : null;
  }
}
