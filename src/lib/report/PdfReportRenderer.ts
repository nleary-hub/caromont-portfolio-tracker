import type { ReportRow } from "@/lib/domain/types";

export interface RenderedReport {
  /** Storage reference (URL or blob key), or null if nothing was stored. */
  storageKey: string | null;
}

/**
 * STUB. Will render the biweekly one-row-per-project PDF per PdfReportLayout and upload it
 * (e.g. Vercel Blob), returning the storage key. For now it renders nothing and stores nothing.
 */
export class PdfReportRenderer {
  static readonly IS_STUB = true;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async render(_snapshotId: string, _rows: readonly ReportRow[]): Promise<RenderedReport> {
    return { storageKey: null };
  }
}
