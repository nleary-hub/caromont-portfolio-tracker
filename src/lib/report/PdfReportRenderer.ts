import type { ReportSnapshot } from "@/generated/prisma/client";
import type { ReportHeader, ReportRow } from "@/lib/domain/types";
import { ViewSettings, type ViewSettingsValue } from "@/lib/domain/ViewSettings";

export interface RenderedReport {
  /** Storage reference (URL or blob key), or null if nothing was stored. */
  storageKey: string | null;
}

/** Everything the renderer needs, all taken from the frozen snapshot. */
export interface ReportRenderInput {
  snapshotId: string;
  rows: readonly ReportRow[];
  /** Null only for snapshots created before view settings existed. */
  header: ReportHeader | null;
  /** Report-context settings frozen at generation (column order and visibility). */
  viewSettings: ViewSettingsValue;
}

/**
 * STUB. Will render the biweekly one-row-per-project PDF per PdfReportLayout and upload it
 * (e.g. Vercel Blob), returning the storage key. For now it renders nothing and stores nothing.
 */
export class PdfReportRenderer {
  static readonly IS_STUB = true;

  /** Rebuild the render input from a stored snapshot (old snapshots fall back to report defaults). */
  static inputFromSnapshot(
    snapshot: Pick<ReportSnapshot, "id" | "rowsJson" | "headerJson" | "viewSettingsJson">,
  ): ReportRenderInput {
    return {
      snapshotId: snapshot.id,
      rows: snapshot.rowsJson as unknown as ReportRow[],
      header: (snapshot.headerJson as unknown as ReportHeader | null) ?? null,
      viewSettings: ViewSettings.normalize("report", snapshot.viewSettingsJson ?? undefined),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  static async render(_input: ReportRenderInput): Promise<RenderedReport> {
    return { storageKey: null };
  }
}
