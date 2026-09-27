import { createElement, type ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { YearEndDocument } from "@/lib/report/pdf/YearEndDocument";
import { YearEndLayout } from "@/lib/report/pdf/YearEndLayout";
import type { YearEndData } from "@/lib/report/YearEndReportData";

/** Renders the year-end report PDF with the weekly report's embedded fonts. */
export class YearEndRenderer {
  static readonly CONTENT_TYPE = "application/pdf";

  static async render(data: YearEndData, generatedAt: Date, generatedBy: string): Promise<Buffer> {
    PdfReportRenderer.registerFonts();
    const layout = YearEndLayout.layout(data, generatedAt, generatedBy);
    const element = createElement(YearEndDocument, { layout, serviceLineName: data.serviceLineName }) as unknown as ReactElement<DocumentProps>;
    return renderToBuffer(element);
  }
}
