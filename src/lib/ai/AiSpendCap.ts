import { AppConfig } from "@/lib/config/AppConfig";

type Amount = number | string | { toString(): string } | null | undefined;

/** Copy for the monthly spend cap: the message a capped person sees and the Admin > AI settings card. */
export const AiSpendCopy = {
  TITLE: "Monthly spend caps",
  INTRO:
    "A dollar cap on each person's estimated AI cost for the calendar month (Eastern time). When someone reaches it, AI stops for them until the 1st. Leave the default blank for no cap. AI is Owner-only today, so this is a monthly budget on your own use until others get AI.",
  PRICE_NOTE: "Cost is the estimate from the prices under Models. A run with no price counts as $0, and the run that crosses the cap still finishes.",
  DEFAULT_LABEL: "Default cap per person",
  DEFAULT_PLACEHOLDER: "No cap",
  DEFAULT_HINT: "Applies to everyone without their own cap. $10 a month is a sensible start.",
  SAVE: "Save",
  REMOVE: "Use default",
  ADD_EMAIL_PLACEHOLDER: "Email",
  ADD_AMOUNT_PLACEHOLDER: "Cap in $",
  ADD: "Set cap",
  PEOPLE_LABEL: "This month",
  PEOPLE_EMPTY: "No AI cost yet this month and no one has their own cap.",
  HEADERS: ["Person", "Spent this month", "Cap", ""] as const,
  NO_CAP: "No cap",
  USES_DEFAULT: "Default",
  SAVED: "Saved.",
  INVALID_AMOUNT: "Enter an amount from $0 to $10,000, or leave it blank for no cap.",
  INVALID_EMAIL: "Enter a valid email.",
  NOT_AUTHORIZED: "Not authorized.",
  PREVIEW: "Saving is off on preview deployments.",
  SAVE_FAILED: "Couldn't save. Try again.",
  CHECK_FAILED: "Couldn't check your monthly AI cap. Try again in a moment.",
  /** The message a capped person sees instead of an AI result. */
  reached(capUsd: number, resetsOn: string): string {
    if (capUsd <= 0) return "Your monthly AI cap is $0, so AI is off for you. An admin can change it under Admin > AI settings > Monthly spend caps.";
    return `You've reached your AI cap for this month (${AiSpendCap.money(capUsd)}). It resets on ${resetsOn}. An admin can raise it under Admin > AI settings > Monthly spend caps.`;
  },
} as const;

/** What applies to one person: their own cap, the default, or none. capUsd null = no cap. */
export type AiSpendCapSource = "own" | "default" | "none";
export interface AiEffectiveCap {
  capUsd: number | null;
  source: AiSpendCapSource;
}

/** Pure rules for the monthly spend cap (no database). */
export class AiSpendCap {
  /** The row that holds the cap for everyone without their own. Emails always contain "@", so it can't collide. */
  static readonly DEFAULT_KEY = "default";
  static readonly MAX_USD = 10_000;

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

  static normalizeEmail(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const e = raw.trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 320 ? e : null;
  }

  /** Their own cap, then the default, then none. The Owner is capped like anyone else (AI is Owner-only today). */
  static effective(args: { own: number | null; fallback: number | null }): AiEffectiveCap {
    if (args.own !== null) return { capUsd: args.own, source: "own" };
    if (args.fallback !== null) return { capUsd: args.fallback, source: "default" };
    return { capUsd: null, source: "none" };
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
