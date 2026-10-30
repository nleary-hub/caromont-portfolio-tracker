import { BrandSvg } from "@/lib/brand/BrandSvg";

export type BrandLogoKind = "lockup" | "mark";
export type BrandLogoTone = "on-dark" | "on-light" | "mono";

const SOURCES: Record<BrandLogoKind, Record<BrandLogoTone, string>> = {
  lockup: { "on-dark": BrandSvg.LOCKUP_ON_DARK, "on-light": BrandSvg.LOCKUP_ON_LIGHT, mono: BrandSvg.LOCKUP_MONO },
  mark: { "on-dark": BrandSvg.MARK_ON_DARK, "on-light": BrandSvg.MARK_ON_LIGHT, mono: BrandSvg.MARK_MONO },
};

/** Lockup viewBox is 259x48, mark is 256x256. Width follows height so the aspect ratio never changes. */
const RATIO: Record<BrandLogoKind, number> = { lockup: 259 / 48, mark: 1 };

/**
 * The Today Line logo, inlined from the designer's SVGs. Height in px; width is derived from the viewBox, so it is never
 * stretched. No shadow, glow or tint is applied. Use "on-light" on light or white surfaces, and "mono" (currentColor)
 * for hover and disabled states.
 */
export function BrandLogo({ kind, tone = "on-dark", height, className, label = "Portfolio Tracker" }: { kind: BrandLogoKind; tone?: BrandLogoTone; height: number; className?: string; label?: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      data-testid={`brand-${kind}`}
      className={`inline-block shrink-0 [&>svg]:block [&>svg]:h-full [&>svg]:w-full ${className ?? ""}`}
      style={{ height, width: Math.round(height * RATIO[kind] * 100) / 100 }}
      dangerouslySetInnerHTML={{ __html: SOURCES[kind][tone].replace(/ role="img"/, ' aria-hidden="true" focusable="false"') }}
    />
  );
}
