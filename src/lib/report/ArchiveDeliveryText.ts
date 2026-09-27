import type { DeliveryRecord } from "@/lib/services/ReportDeliveryService";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/** Delivery column text on the report archive (admins only). Never throws on a partial delivery record. */
export class ArchiveDeliveryText {
  static readonly NONE = "Not delivered yet";
  static readonly DRIVE = "Uploaded to Google Drive";
  static readonly SIGNED_LINK_NO_DETAILS = "Signed link issued. Link details weren't saved.";
  static readonly FAILED = "Delivery failed";

  static label(d: DeliveryRecord | null | undefined): string {
    if (!d) return ArchiveDeliveryText.NONE;
    if (d.status === "drive") return ArchiveDeliveryText.DRIVE;
    if (d.status === "signed_link") {
      const at = d.signedLink ? new Date(d.signedLink.expiresAt) : null;
      return at && !Number.isNaN(at.getTime()) ? `Signed link until ${ReportFormat.dateTimeEt(at)}` : ArchiveDeliveryText.SIGNED_LINK_NO_DETAILS;
    }
    return ArchiveDeliveryText.FAILED;
  }

  /** The "link" anchor target, or null when the record has no usable link. */
  static linkHref(d: DeliveryRecord | null | undefined): string | null {
    return d?.status === "signed_link" && d.signedLink?.pdfUrl ? d.signedLink.pdfUrl : null;
  }

  /** Hover text: the Drive or signed-link error, if any. */
  static title(d: DeliveryRecord | null | undefined): string {
    return d?.driveError ?? d?.signedLinkError ?? "";
  }
}
