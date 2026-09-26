import { readFileSync } from "node:fs";
import path from "node:path";

export type FontWeight = 400 | 500 | 600 | 700;

/**
 * Static Inter instances (OFL, subset to Latin) embedded in every PDF. Files live in
 * src/lib/report/fonts and are traced into the serverless bundle via next.config
 * outputFileTracingIncludes.
 */
export class ReportFonts {
  static readonly FAMILY = "Inter";

  private static readonly FILES: Record<FontWeight, string> = {
    400: "Inter-Regular.ttf",
    500: "Inter-Medium.ttf",
    600: "Inter-SemiBold.ttf",
    700: "Inter-Bold.ttf",
  };

  private static readonly cache = new Map<FontWeight, Buffer>();

  static weights(): FontWeight[] {
    return [400, 500, 600, 700];
  }

  static dir(): string {
    return path.join(process.cwd(), "src", "lib", "report", "fonts");
  }

  static file(weight: FontWeight): string {
    return path.join(ReportFonts.dir(), ReportFonts.FILES[weight]);
  }

  static bytes(weight: FontWeight): Buffer {
    let b = ReportFonts.cache.get(weight);
    if (!b) {
      b = readFileSync(ReportFonts.file(weight));
      ReportFonts.cache.set(weight, b);
    }
    return b;
  }
}
