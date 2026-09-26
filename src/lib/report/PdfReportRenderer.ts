import { createElement, type ReactElement } from "react";
import { Font, renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import type { ReportSnapshot } from "@/generated/prisma/client";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { CompletedRow, ReportHeader, ReportRow } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import { PdfReportLayout } from "@/lib/report/PdfReportLayout";
import { ReportDocument } from "@/lib/report/pdf/ReportDocument";
import { ReportFonts } from "@/lib/report/pdf/ReportFonts";
import { ReportLayout, type DocumentLayout, type ReportDocInput } from "@/lib/report/pdf/ReportLayout";
import { ReportOptionsService, type ReportOptionsValue } from "@/lib/services/ReportOptionsService";

/** Everything the renderer needs, all taken from the frozen snapshot. */
export interface ReportRenderInput {
  snapshotId: string;
  rows: readonly ReportRow[];
  /** Null only for snapshots created before view settings existed. */
  header: ReportHeader | null;
  /** "Completed this period" rows frozen at generation. Absent (undefined) before migration 0012. */
  completed?: readonly CompletedRow[];
  /** Report-context settings frozen at generation (column order and visibility). */
  viewSettings: ViewSettingsValue;
  /** Report options frozen at generation (defaults for snapshots before 0004). */
  options: ReportOptionsValue;
  periodStart: string;
  periodEnd: string;
  generatedAt: Date;
  /** YYYY-MM-DD, America/New_York date of generatedAt. */
  reportDate: string;
}

/**
 * Renders the report PDF with @react-pdf/renderer (pure JS, no headless browser, so it runs in a
 * Vercel serverless function). Layout and pagination are decided by ReportLayout; this class only
 * turns the layout into PDF bytes with the embedded Inter fonts.
 */
export class PdfReportRenderer {
  static readonly CONTENT_TYPE = "application/pdf";
  private static fontsRegistered = false;

  /** Rebuild the render input from a stored snapshot (old snapshots fall back to report defaults). */
  static inputFromSnapshot(
    snapshot: Pick<ReportSnapshot, "id" | "rowsJson" | "headerJson" | "completedJson" | "viewSettingsJson" | "optionsJson" | "periodStart" | "periodEnd" | "generatedAt">,
  ): ReportRenderInput {
    return {
      snapshotId: snapshot.id,
      rows: snapshot.rowsJson as unknown as ReportRow[],
      header: (snapshot.headerJson as unknown as ReportHeader | null) ?? null,
      ...(snapshot.completedJson ? { completed: snapshot.completedJson as unknown as CompletedRow[] } : {}),
      viewSettings: ViewSettings.normalize("report", snapshot.viewSettingsJson ?? undefined),
      options: ReportOptionsService.normalize(snapshot.optionsJson),
      periodStart: DateOnly.fromDbDate(snapshot.periodStart)!,
      periodEnd: DateOnly.fromDbDate(snapshot.periodEnd)!,
      generatedAt: snapshot.generatedAt,
      reportDate: DateOnly.inZone(snapshot.generatedAt),
    };
  }

  static docInput(input: ReportRenderInput): ReportDocInput {
    return {
      rows: input.rows,
      header: input.header,
      ...(input.completed ? { completed: input.completed } : {}),
      viewSettings: input.viewSettings,
      showKeyPage: input.options.showKeyPage,
      reportDate: input.reportDate,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      generatedAt: input.generatedAt,
    };
  }

  static registerFonts(): void {
    if (PdfReportRenderer.fontsRegistered) return;
    Font.register({
      family: ReportFonts.FAMILY,
      fonts: ReportFonts.weights().map((w) => ({ src: ReportFonts.file(w), fontWeight: w })),
    });
    // Lines are pre-wrapped by ReportLayout; never hyphenate.
    Font.registerHyphenationCallback((word) => [word]);
    PdfReportRenderer.fontsRegistered = true;
  }

  static layout(doc: ReportDocInput): DocumentLayout {
    return ReportLayout.layout(doc);
  }

  /** Render any document input (frozen snapshot, draft preview or sample) to PDF bytes. */
  static async renderDocument(doc: ReportDocInput): Promise<Buffer> {
    PdfReportRenderer.registerFonts();
    const layout = PdfReportRenderer.layout(doc);
    const element = createElement(ReportDocument, {
      layout,
      draft: Boolean(doc.draft),
      title: PdfReportLayout.TITLE,
    }) as unknown as ReactElement<DocumentProps>;
    return renderToBuffer(element);
  }

  /** Render a frozen snapshot. */
  static async render(input: ReportRenderInput): Promise<Buffer> {
    return PdfReportRenderer.renderDocument(PdfReportRenderer.docInput(input));
  }

  /** File name for a frozen report PDF. */
  static fileName(periodEnd: string): string {
    return `cardiac-portfolio-report-${periodEnd}.pdf`;
  }

  static draftFileName(reportDate: string): string {
    return `cardiac-portfolio-report-draft-${reportDate}.pdf`;
  }
}
