import { DriveError } from "@/lib/report/GoogleDriveClient";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { ReportDeliveryService, type DeliveryRecord } from "@/lib/services/ReportDeliveryService";

/** The warning the Owner sees on Report archive > Report freeze when the newest report didn't reach Google Drive. */
export interface DriveWarning {
  /** One plain sentence: what went wrong. */
  title: string;
  /** What it means and what to do. */
  body: string;
  /** Google's or the app's error text, for the record (never a secret). */
  detail: string | null;
}

/** The newest frozen report and its latest delivery record (archive entries are newest first). */
export interface DriveWarningInput {
  periodStart: string;
  periodEnd: string;
  delivery?: DeliveryRecord | null;
}

/**
 * Drive save failures used to show only as "Signed link until ..." in the archive's Delivery column, so a dead Drive
 * sign-in went unnoticed for weeks while the Wednesday email (which reads the newest file in the Drive folder) had
 * nothing new to send. This turns the newest report's delivery record into a warning banner, or null when the newest
 * report is in Drive, has no delivery yet, or Drive is deliberately not set up.
 */
export class DriveDeliveryWarning {
  static readonly EXPIRED_TITLE = "The latest report didn't save to Google Drive: the app's Google sign-in for Drive has expired.";
  static readonly FAILED_TITLE = "The latest report didn't save to Google Drive.";
  static readonly EXPIRED_FIX =
    "Press Reconnect Drive below and sign in to Google, then press Check Drive. If the Google OAuth app is in Testing, publish it first, or the new sign-in expires again in 7 days.";
  static readonly FAILED_FIX = "Press Check Drive to see whether it still fails. The freeze retries the save every day until it works.";

  static from(newest: DriveWarningInput | null | undefined): DriveWarning | null {
    const d = newest?.delivery;
    if (!newest || !d || d.status === "drive") return null;
    const error = d.driveError ?? null;
    // Drive left unset on purpose: the signed link is the expected delivery, not a failure.
    if (error === ReportDeliveryService.NOT_CONFIGURED && d.status === "signed_link") return null;
    const period = ReportFormat.period(newest.periodStart, newest.periodEnd);
    const tried = DriveDeliveryWarning.triedAt(d.attemptedAt);
    const fallback =
      d.status === "signed_link"
        ? `The report for ${period} went out only as a signed link, so the Wednesday email has no new report in Drive to read.`
        : `The report for ${period} wasn't delivered at all (no Drive file and no signed link).`;
    const expired = DriveError.isExpiredSignIn(error);
    return {
      title: expired ? DriveDeliveryWarning.EXPIRED_TITLE : DriveDeliveryWarning.FAILED_TITLE,
      body: `${fallback}${tried ? ` Last tried ${tried}.` : ""} ${expired ? DriveDeliveryWarning.EXPIRED_FIX : DriveDeliveryWarning.FAILED_FIX}`,
      detail: error ?? d.signedLinkError ?? null,
    };
  }

  private static triedAt(iso: string): string | null {
    const at = new Date(iso);
    return iso && !Number.isNaN(at.getTime()) ? ReportFormat.dateTimeEt(at) : null;
  }
}
