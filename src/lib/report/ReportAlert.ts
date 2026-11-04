import * as Sentry from "@sentry/nextjs";
import { DriveError } from "@/lib/report/GoogleDriveClient";

/**
 * Alerts for report delivery problems that would otherwise only reach the runtime logs. Sent to Sentry (a no-op when
 * NEXT_PUBLIC_SENTRY_DSN is unset). One fixed fingerprint per kind, so every daily retry lands on the same Sentry issue
 * instead of opening a new one; the message holds no error text (that stays in report_deliveries and the logs).
 */
export class ReportAlert {
  static readonly DRIVE_FINGERPRINT = ["report-delivery", "drive-save-failed"];
  static readonly DRIVE_EXPIRED = "Weekly report: Google Drive sign-in expired, report not saved to Drive";
  static readonly DRIVE_FAILED = "Weekly report: save to Google Drive failed";

  static driveSaveFailed(error: string, capture: typeof Sentry.captureMessage = Sentry.captureMessage): void {
    try {
      const expired = DriveError.isExpiredSignIn(error);
      capture(expired ? ReportAlert.DRIVE_EXPIRED : ReportAlert.DRIVE_FAILED, {
        level: "error",
        fingerprint: ReportAlert.DRIVE_FINGERPRINT,
        tags: { area: "report-delivery", reason: expired ? "expired_sign_in" : "drive_error" },
      });
    } catch {
      // An alert must never break the delivery (the signed link still has to go out).
    }
  }
}
