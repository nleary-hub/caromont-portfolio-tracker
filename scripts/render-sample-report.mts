// Renders the fictional sample report for design review.
// Usage: npx tsx scripts/render-sample-report.mts [out.pdf] [--draft]
import { writeFileSync } from "node:fs";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { SampleReportData } from "@/lib/report/SampleReportData";

class RenderSample {
  static async main(argv: string[]): Promise<void> {
    const out = argv.find((a) => !a.startsWith("--")) ?? "sample-report.pdf";
    const draft = argv.includes("--draft");
    const bytes = await PdfReportRenderer.renderDocument(SampleReportData.docInput({ draft }));
    writeFileSync(out, bytes);
    const pages = PdfReportRenderer.layout(SampleReportData.docInput({ draft })).pages.length;
    console.log(`Wrote ${out} (${bytes.length} bytes, ${pages} pages)`);
  }
}

void RenderSample.main(process.argv.slice(2));
