// Renders the fictional sample report for design review.
// Usage: npx tsx scripts/render-sample-report.mts [out.pdf] [--draft] [--waiting-on | --waiting-on=none]
//   --waiting-on       adds the fictional "Waiting on" lines (Report contents option on, some rows blocked)
//   --waiting-on=none  option on but zero open blockers (must match the default render byte for byte)
import { writeFileSync } from "node:fs";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { SampleReportData } from "@/lib/report/SampleReportData";

class RenderSample {
  static async main(argv: string[]): Promise<void> {
    const out = argv.find((a) => !a.startsWith("--")) ?? "sample-report.pdf";
    const draft = argv.includes("--draft");
    const waitingOn = argv.includes("--waiting-on") ? true : argv.includes("--waiting-on=none") ? ("none" as const) : false;
    const bytes = await PdfReportRenderer.renderDocument(SampleReportData.docInput({ draft }, { waitingOn }));
    writeFileSync(out, bytes);
    const pages = PdfReportRenderer.layout(SampleReportData.docInput({ draft }, { waitingOn })).pages.length;
    console.log(`Wrote ${out} (${bytes.length} bytes, ${pages} pages)`);
  }
}

void RenderSample.main(process.argv.slice(2));
