/**
 * Weekly PDF colors (admin Report colors setting, migration 0027): the department bar color and an optional band
 * behind the page 1 title. Pure and client-safe (the settings panel uses it for the live preview and to block a
 * custom color before saving; the server checks again).
 *
 * Presets are fixed palettes. A custom color derives everything from its fill: white text on dark fills and dark
 * text on light fills, whichever contrasts more. Every derived text color must meet WCAG AA: 4.5:1 for the 9 pt
 * department name, the 7 pt count and the 8 pt eyebrow; 3:1 for the large title (which uses the name color, so it
 * always passes once the name does). A custom color that fails is blocked; one close to a status color
 * (nearStatus) only gets a warning.
 */
export type ReportColorPreset = "navy" | "deeper-plum" | "plum";

export interface ReportColorsValue {
  /** Department bar: a preset key or a custom "#RRGGBB". */
  bar: string;
  /** Page 1 title band: "none", a preset key or a custom "#RRGGBB". */
  band: string;
}

/** Colors of one department bar. */
export interface BarPalette {
  fill: string;
  /** Department name (9 pt, weight 600). */
  text: string;
  /** 2 pt left stripe. Same as the fill on dark bars (a solid bar), the text color on light ones. */
  stripe: string;
  /** "N projects" on the right (7 pt). */
  count: string;
  /** Name and stripe of the Unassigned bar (secondary, as today). */
  unassigned: string;
}

/** Colors of the page 1 title band (null = no band, today's header). */
export interface BandPalette {
  fill: string;
  title: string;
  /** Service line eyebrow above the title (8 pt). */
  eyebrow: string;
  /** The 1.5 pt rule under the header, drawn as wide as the band so the corners stay square. */
  rule: string;
}

export interface ResolvedReportColors {
  bar: BarPalette;
  band: BandPalette | null;
}

export type ColorCheck = { ok: true } | { ok: false; message: string };

/** A status color a custom color is compared with (ReportColors.STATUS / CHANGED in ReportDocument.tsx). */
export interface StatusColorRef {
  name: string;
  hex: string;
}

const WHITE = "#FFFFFF";
/** ReportColors.TEXT and ReportColors.MUTED (the print palette). */
const INK = "#15171C";
const MUTED = "#5B6270";

export class ReportColorScheme {
  static readonly NONE = "none";
  static readonly CUSTOM = "custom";
  static readonly DEFAULTS: ReportColorsValue = { bar: "navy", band: "none" };
  /**
   * Bar key of the look before Report colors: light gray #E1E5EB bars with dark text (ReportColors.SECTION_BG_STRONG).
   * Not selectable. Snapshots frozen before migration 0027 have no colors and re-render with it (see frozen()).
   */
  static readonly CLASSIC = "classic";
  static readonly CLASSIC_VALUE: ReportColorsValue = { bar: "classic", band: "none" };
  static readonly CLASSIC_BAR: BarPalette = { fill: "#E1E5EB", text: INK, stripe: INK, count: MUTED, unassigned: MUTED };
  /**
   * A custom color closer than this CIEDE2000 distance to a status color gets a warning (saving is still allowed).
   * 5 is about where two colors stop reading as "the same color" at a glance (1 to 2.3 is just noticeable); every
   * preset is about 6 or more away from every status color (closest: Plum vs the On hold chip fill, 6.0), so no preset would trip it.
   */
  static readonly STATUS_DISTANCE = 5;
  /** Colors a bar or band must not be mistaken for: Completed teal and On hold blue (chip fill and ink), the Changed flag ink. */
  static readonly STATUS_COLORS: readonly StatusColorRef[] = [
    { name: "Completed", hex: "#D6F1EE" },
    { name: "Completed", hex: "#0E6961" },
    { name: "On hold", hex: "#E0E7F6" },
    { name: "On hold", hex: "#2D4B88" },
    { name: "Changed", hex: "#4B2FA8" },
  ];
  /** Pixel ratio thresholds (WCAG 2.x AA). */
  static readonly AA_NORMAL = 4.5;
  static readonly AA_LARGE = 3;
  /** Pt the band extends into each side margin (mockup HEADER_BAND_BLEED=6), and above the eyebrow. */
  static readonly BAND_BLEED = 6;
  static readonly BAND_TOP = 6;

  static readonly PRESETS: Record<ReportColorPreset, { label: string; bar: BarPalette; band: BandPalette }> = {
    navy: {
      label: "Navy solid",
      bar: { fill: "#1F3A5F", text: WHITE, stripe: "#1F3A5F", count: WHITE, unassigned: "#D0D8E4" },
      band: { fill: "#1F3A5F", title: WHITE, eyebrow: "#D0D8E4", rule: "#1F3A5F" },
    },
    "deeper-plum": {
      label: "Deeper plum",
      bar: { fill: "#E4D9EC", text: "#4A3558", stripe: "#4A3558", count: "#5C4A6B", unassigned: MUTED },
      band: { fill: "#E4D9EC", title: "#4A3558", eyebrow: "#5C4A6B", rule: "#4A3558" },
    },
    plum: {
      label: "Plum",
      bar: { fill: "#ECE6F0", text: "#4A3558", stripe: "#4A3558", count: MUTED, unassigned: MUTED },
      band: { fill: "#ECE6F0", title: "#4A3558", eyebrow: "#4A3558", rule: "#4A3558" },
    },
  };
  static readonly PRESET_KEYS = Object.keys(ReportColorScheme.PRESETS) as ReportColorPreset[];

  /** UI copy (Admin > Report contents > Report colors). */
  static readonly COPY = {
    heading: "Report colors",
    intro: "Colors for the weekly PDF.",
    barLegend: "Department bar color",
    bandLegend: "Header band",
    none: "None",
    custom: "Custom",
    hexLabel: "Hex color",
    pickerLabel: "Pick a color",
    bandHelp: "A color band behind the title on page 1. Shows when the summary grid is at the top.",
    contrastNote: "Text color is set automatically so it stays readable.",
    preview: "Preview",
    reset: "Reset to defaults",
    invalid: "Enter a color like #1F3A5F.",
    tooLowContrast: "Text on this color is hard to read. Pick a darker or lighter color.",
    statusWarning: "This color is close to a status color. Pick another so it doesn't look like a status.",
    saved: "Saved. Applies to the next freeze and to drafts.",
    failed: "Could not save the change.",
    footnote: "Used by Generate PDF now and the biweekly report. Frozen reports keep the colors they were frozen with.",
    auditSubject: "Report colors",
    auditBar: "Bar color changed",
    auditBand: "Header band changed",
    classic: "Light gray (before Report colors)",
  } as const;

  static isPreset(v: unknown): v is ReportColorPreset {
    return typeof v === "string" && (ReportColorScheme.PRESET_KEYS as string[]).includes(v);
  }

  /** "#1f3a5f", "1F3A5F" or " #1F3A5F " -> "#1F3A5F"; null when not a 6-digit hex color. */
  static hex(v: unknown): string | null {
    if (typeof v !== "string") return null;
    const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
    return m ? `#${m[1].toUpperCase()}` : null;
  }

  /** Stored value (anything) to a valid one; unknown or unreadable values take the default. */
  static normalize(raw: unknown): ReportColorsValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ReportColorsValue, unknown>>;
    const bar = ReportColorScheme.isPreset(r.bar) ? r.bar : ReportColorScheme.hex(r.bar);
    const band = r.band === ReportColorScheme.NONE || ReportColorScheme.isPreset(r.band) ? r.band : ReportColorScheme.hex(r.band);
    return {
      bar: bar && ReportColorScheme.check(bar).ok ? bar : ReportColorScheme.DEFAULTS.bar,
      band: band && (band === ReportColorScheme.NONE || ReportColorScheme.check(band).ok) ? band : ReportColorScheme.DEFAULTS.band,
    };
  }

  /**
   * Colors frozen into a snapshot (StoredReportOptions.colors). Snapshots from before migration 0027 have none and
   * keep the look they were sent with (CLASSIC_VALUE), not today's default.
   */
  static frozen(raw: unknown): ReportColorsValue {
    if (!raw || typeof raw !== "object") return { ...ReportColorScheme.CLASSIC_VALUE };
    const r = raw as Partial<Record<keyof ReportColorsValue, unknown>>;
    const v = ReportColorScheme.normalize(raw);
    return r.bar === ReportColorScheme.CLASSIC ? { ...v, bar: ReportColorScheme.CLASSIC } : v;
  }

  static equals(a: ReportColorsValue, b: ReportColorsValue): boolean {
    return a.bar === b.bar && a.band === b.band;
  }

  /** WCAG relative luminance of "#RRGGBB". */
  static luminance(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }

  /** WCAG contrast ratio (1 to 21). */
  static contrast(a: string, b: string): number {
    const [x, y] = [ReportColorScheme.luminance(a), ReportColorScheme.luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }

  /** `a` mixed toward `b` by `t` (0 = a, 1 = b). */
  static mix(a: string, b: string, t: number): string {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const c = [16, 8, 0].map((s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t));
    return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  }

  /** Bar and band colors derived from a custom fill (see the class comment). */
  static derive(fill: string): { bar: BarPalette; band: BandPalette } {
    const light = ReportColorScheme.contrast(fill, INK) > ReportColorScheme.contrast(fill, WHITE);
    const text = light ? INK : WHITE;
    // The secondary color (count on light bars, Unassigned, eyebrow): today's muted gray on light fills, a tint of the
    // fill on dark ones; the full text color when that tint would fall below AA.
    const soft = light ? MUTED : ReportColorScheme.mix(WHITE, fill, 0.2);
    const secondary = ReportColorScheme.contrast(soft, fill) >= ReportColorScheme.AA_NORMAL ? soft : text;
    const stripe = light ? text : fill;
    return {
      bar: { fill, text, stripe, count: light ? secondary : text, unassigned: secondary },
      band: { fill, title: text, eyebrow: secondary, rule: stripe },
    };
  }

  /** CIELAB (D65) of "#RRGGBB". */
  static lab(hex: string): [number, number, number] {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
    const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
    const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  /** CIEDE2000 color difference of two "#RRGGBB" colors (0 = identical). */
  static distance(p: string, q: string): number {
    const [L1, a1, b1] = ReportColorScheme.lab(p);
    const [L2, a2, b2] = ReportColorScheme.lab(q);
    const rad = Math.PI / 180;
    const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
    const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
    const a1p = a1 * (1 + G);
    const a2p = a2 * (1 + G);
    const C1 = Math.hypot(a1p, b1);
    const C2 = Math.hypot(a2p, b2);
    const h1 = (Math.atan2(b1, a1p) / rad + 360) % 360;
    const h2 = (Math.atan2(b2, a2p) / rad + 360) % 360;
    const dL = L2 - L1;
    const dC = C2 - C1;
    const raw = h2 - h1;
    const dh = C1 * C2 === 0 ? 0 : Math.abs(raw) <= 180 ? raw : raw > 180 ? raw - 360 : raw + 360;
    const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
    const Lb = (L1 + L2) / 2;
    const Cbp = (C1 + C2) / 2;
    const hb = C1 * C2 === 0 ? h1 + h2 : Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
    const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
    const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
    const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
    const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
    const SC = 1 + 0.045 * Cbp;
    const SH = 1 + 0.015 * Cbp * T;
    const RT = -Math.sin(2 * dTheta * rad) * RC;
    return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
  }

  /** The status color a custom color is too close to (warning only), or null. Presets and "none" never warn. */
  static nearStatus(value: string): StatusColorRef | null {
    if (ReportColorScheme.isPreset(value)) return null;
    const fill = ReportColorScheme.hex(value);
    if (!fill) return null;
    let best: { ref: StatusColorRef; d: number } | null = null;
    for (const ref of ReportColorScheme.STATUS_COLORS) {
      const d = ReportColorScheme.distance(fill, ref.hex);
      if (d < ReportColorScheme.STATUS_DISTANCE && (!best || d < best.d)) best = { ref, d };
    }
    return best?.ref ?? null;
  }

  /** A custom color may be saved only when its derived text meets AA (4.5:1). */
  static check(value: string): ColorCheck {
    if (ReportColorScheme.isPreset(value)) return { ok: true };
    const fill = ReportColorScheme.hex(value);
    if (!fill) return { ok: false, message: ReportColorScheme.COPY.invalid };
    return ReportColorScheme.passes(ReportColorScheme.derive(fill).bar) ? { ok: true } : { ok: false, message: ReportColorScheme.COPY.tooLowContrast };
  }

  /** Every text color of a bar palette against its fill: name, count, Unassigned at 4.5:1. */
  static passes(p: BarPalette): boolean {
    return [p.text, p.count, p.unassigned].every((c) => ReportColorScheme.contrast(c, p.fill) >= ReportColorScheme.AA_NORMAL);
  }

  /** Band: eyebrow at 4.5:1, title at 3:1 (large text). */
  static bandPasses(b: BandPalette): boolean {
    return ReportColorScheme.contrast(b.eyebrow, b.fill) >= ReportColorScheme.AA_NORMAL && ReportColorScheme.contrast(b.title, b.fill) >= ReportColorScheme.AA_LARGE;
  }

  static resolve(value: ReportColorsValue | undefined | null): ResolvedReportColors {
    const v = ReportColorScheme.normalize(value ?? ReportColorScheme.DEFAULTS);
    const pick = (key: string) => (ReportColorScheme.isPreset(key) ? ReportColorScheme.PRESETS[key] : ReportColorScheme.derive(key));
    if (value?.bar === ReportColorScheme.CLASSIC) return { bar: ReportColorScheme.CLASSIC_BAR, band: v.band === ReportColorScheme.NONE ? null : pick(v.band).band };
    return { bar: pick(v.bar).bar, band: v.band === ReportColorScheme.NONE ? null : pick(v.band).band };
  }

  /** Label for the audit / history: "Navy solid", "Custom #2B4C7E", "None". */
  static label(key: string): string {
    if (key === ReportColorScheme.NONE) return ReportColorScheme.COPY.none;
    if (key === ReportColorScheme.CLASSIC) return ReportColorScheme.COPY.classic;
    return ReportColorScheme.isPreset(key) ? ReportColorScheme.PRESETS[key].label : `${ReportColorScheme.COPY.custom} ${key}`;
  }
}
