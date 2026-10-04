import { DateOnly } from "@/lib/domain/DateOnly";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/**
 * A frozen report's stored PDF (report_artifacts, kind "pdf"). Once a report is frozen its PDF is the record: it is
 * never rebuilt from the snapshot, because a rebuild would use today's layout (new columns, owner names, the fixed
 * Infor slot) and no longer match what was sent. When the stored file is missing, the app says so instead.
 */
export class StoredPdfCopy {
  /** Final copy (Writing Bot). No Rebuild button, on purpose. */
  static readonly TITLE = "Saved PDF not found";
  static readonly ICON_LABEL = "Error: saved PDF not found";

  /** `frozenOn`: the report's real freeze day (snapshot generatedAt in America/New_York), "Sep 29, 2026". */
  static message(frozenOn: string): string {
    return `This report was frozen on ${frozenOn}, but its saved PDF is missing. We won't rebuild it, so the copy that went out stays unchanged. Ask an admin to restore the file.`;
  }

  /** The freeze day as written in the message. */
  static frozenOn(generatedAt: Date): string {
    return ReportFormat.mediumDate(DateOnly.inZone(generatedAt));
  }
}

/** The snapshot was frozen and its PDF stored before (pdfStorageKey set), but the stored file is gone. */
export class StoredPdfMissingError extends Error {
  constructor(
    readonly snapshotId: string,
    readonly generatedAt: Date,
  ) {
    super(`Stored PDF missing for frozen report ${snapshotId}`);
    this.name = "StoredPdfMissingError";
  }
}
