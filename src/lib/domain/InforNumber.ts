import { AppConfig } from "@/lib/config/AppConfig";

/** Display rules for the optional Infor request number (free text such as "4656" or "4656 / 5081"). */
export class InforNumber {
  static readonly LABEL = "Infor";
  static readonly ELLIPSIS = "\u2026";

  /** Trimmed value, or null when missing or blank. */
  static normalize(value: string | null | undefined): string | null {
    const t = (value ?? "").trim();
    return t === "" ? null : t;
  }

  /**
   * Dashboard display: at most `maxChars` characters, ending in an ellipsis when cut (the full value
   * goes in the title attribute). Null when there is no number, so the caller omits the whole
   * "Infor N · " prefix.
   */
  static display(
    value: string | null | undefined,
    maxChars: number = AppConfig.INFOR_DISPLAY_MAX_CHARS,
  ): { text: string; full: string; truncated: boolean } | null {
    const full = InforNumber.normalize(value);
    if (full === null) return null;
    const chars = Array.from(full);
    if (chars.length <= maxChars) return { text: full, full, truncated: false };
    return { text: chars.slice(0, Math.max(1, maxChars - 1)).join("").trimEnd() + InforNumber.ELLIPSIS, full, truncated: true };
  }
}
