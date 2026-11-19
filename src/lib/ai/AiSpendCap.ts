import { AppConfig } from "@/lib/config/AppConfig";

type Amount = number | string | { toString(): string } | null | undefined;

/** Copy for the monthly spend cap: one shared cap per company (OpenAI, Anthropic, and the rest). */
export const AiSpendCopy = {
  TITLE: "Monthly spend caps",
  INTRO:
    "A dollar cap on estimated AI cost for the calendar month (Eastern time), one total per company, shared by everyone who can use AI. When a company's total reaches its cap, that company's AI stops until the 1st. Leave a box blank for no cap.",
  PRICE_NOTE: "Cost is the estimate from the prices under Models. A run with no price counts as $0, and the run that crosses the cap still finishes. Older per-person caps are listed below and are not enforced.",
  PREVIOUS_TITLE: "Previous per-person caps",
  PREVIOUS_NOTE: "These were saved before caps became one total per company. They are kept here so nothing is lost. They do not stop anyone. Set the company caps above.",
  PREVIOUS_DEFAULT: "Old default",
  PREVIOUS_EMPTY: "No per-person caps were saved.",
  SAVE: "Save",
  REMOVE: "Remove cap",
  HEADERS: ["Company", "Spent this month", "Cap"] as const,
  NO_CAP: "No cap",
  SAVED: "Saved.",
  INVALID_AMOUNT: "Enter an amount from $0 to $10,000, or leave it blank for no cap.",
  INVALID_PROVIDER: "Choose one of the companies.",
  NOT_AUTHORIZED: "Not authorized.",
  PREVIEW: "Saving is off on preview deployments.",
  SAVE_FAILED: "Couldn't save. Try again.",
  CHECK_FAILED: "Couldn't check the monthly AI cap. Try again in a moment.",
  /** The message shown when a company's shared cap is reached. */
  reached(company: string, capUsd: number, resetsOn: string): string {
    if (capUsd <= 0) return `The ${company} monthly AI cap is $0, so ${company} is off. An admin can change it under Admin > AI settings > Monthly spend caps.`;
    return `The ${company} AI cap for this month is reached (${AiSpendCap.money(capUsd)}, shared by everyone). It resets on ${resetsOn}. An admin can raise it under Admin > AI settings > Monthly spend caps.`;
  },
} as const;

/** A company the cap and the usage log can name. */
export type AiSpendVendor = "openai" | "anthropic" | "xai" | "other" | "azure_openai";

/** Pure rules for the monthly spend cap (no database). */
export class AiSpendCap {
  /** The old per-person row that held the cap for everyone without their own. Kept, not enforced. */
  static readonly DEFAULT_KEY = "default";
  static readonly MAX_USD = 10_000;
  static readonly VENDORS: readonly AiSpendVendor[] = ["openai", "anthropic", "xai", "other", "azure_openai"];

  static parseVendor(v: unknown): AiSpendVendor | null {
    return typeof v === "string" && (AiSpendCap.VENDORS as readonly string[]).includes(v) ? (v as AiSpendVendor) : null;
  }

  static label(v: AiSpendVendor): string {
    switch (v) {
      case "openai":
        return "OpenAI";
      case "anthropic":
        return "Anthropic";
      case "xai":
        return "xAI";
      case "other":
        return "Other";
      case "azure_openai":
        return "Azure OpenAI";
      default: {
        const never: never = v;
        return never;
      }
    }
  }

  /**
   * Which company a call spends against. xAI and Other both speak the OpenAI-compatible protocol;
   * xAI's base URL is what tells them apart. Anything else counts as OpenAI (the historical default).
   */
  static vendorOf(config: { provider: string; baseUrl?: string | null }): AiSpendVendor {
    if (config.provider === "anthropic") return "anthropic";
    if (config.provider === "azure_openai") return "azure_openai";
    if (config.provider === "xai") return "xai";
    if (config.provider === "other") return "other";
    if (config.provider === "openai_compatible") return (config.baseUrl ?? "").replace(/\/+$/, "") === "https://api.x.ai/v1" ? "xai" : "other";
    return "openai";
  }

  /**
   * Which company a stored usage row belongs to. The model's company wins when the model is on the list.
   * A row with no company and no model counts as OpenAI. openai_compatible with no model counts as Other.
   */
  static vendorOfUsage(usageProvider: string | null | undefined, modelProvider: string | null | undefined): AiSpendVendor {
    const fromModel = AiSpendCap.parseVendor(modelProvider);
    if (fromModel) return fromModel;
    const fromUsage = AiSpendCap.parseVendor(usageProvider);
    if (fromUsage) return fromUsage;
    if (usageProvider === "openai_compatible") return "other";
    return "openai";
  }

  static num(v: Amount): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }

  static money(v: Amount): string {
    const n = AiSpendCap.num(v) ?? 0;
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /** "", "  " -> null (no cap). "12", "$12.50", "1,000" -> the amount in cents precision. Anything else -> undefined. */
  static parseAmount(raw: unknown): number | null | undefined {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "string" && typeof raw !== "number") return undefined;
    const s = String(raw).trim().replace(/^\$/, "").replace(/,/g, "");
    if (s === "") return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
    const n = Number(s);
    return n >= 0 && n <= AiSpendCap.MAX_USD ? Math.round(n * 100) / 100 : undefined;
  }

  /** True when another AI call is allowed: no cap, or spend still under it (a cap of 0 always blocks). */
  static allows(cap: number | null, spentUsd: number): boolean {
    if (cap === null) return true;
    return cap > 0 && spentUsd < cap;
  }

  /** The wall-clock year, month and offset (ms, local minus UTC) of an instant in a time zone. */
  private static zoned(at: Date, timeZone: string): { year: number; month: number; offsetMs: number } {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return { year: get("year"), month: get("month"), offsetMs: local - Math.floor(at.getTime() / 1000) * 1000 };
  }

  /** Midnight on the 1st of a month in the time zone, as an instant. Month may be 13 (January of the next year). */
  private static firstOf(year: number, month: number, timeZone: string): Date {
    const guess = Date.UTC(year, month - 1, 1);
    let at = guess - AiSpendCap.zoned(new Date(guess), timeZone).offsetMs;
    // Second pass settles a guess that landed on the other side of a daylight saving change.
    at = guess - AiSpendCap.zoned(new Date(at), timeZone).offsetMs;
    return new Date(at);
  }

  /** The start of the current calendar month in the app's time zone (Eastern). */
  static monthStart(now: Date, timeZone: string = AppConfig.TIME_ZONE): Date {
    const z = AiSpendCap.zoned(now, timeZone);
    return AiSpendCap.firstOf(z.year, z.month, timeZone);
  }

  /** The start of next month in the app's time zone: when the cap resets. */
  static nextMonthStart(now: Date, timeZone: string = AppConfig.TIME_ZONE): Date {
    const z = AiSpendCap.zoned(now, timeZone);
    return AiSpendCap.firstOf(z.year, z.month + 1, timeZone);
  }

  /** "December 1" for the reset day. */
  static resetLabel(now: Date, timeZone: string = AppConfig.TIME_ZONE): string {
    return new Intl.DateTimeFormat("en-US", { timeZone, month: "long", day: "numeric" }).format(AiSpendCap.nextMonthStart(now, timeZone));
  }
}
