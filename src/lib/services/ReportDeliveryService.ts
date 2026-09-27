import type { Prisma, PrismaClient, ReportArtifact } from "@/generated/prisma/client";
import { ReportEnv, type EnvSource } from "@/lib/config/ReportEnv";
import { Db } from "@/lib/db/Db";
import { GoogleDriveClient, type FetchLike } from "@/lib/report/GoogleDriveClient";
import { ReportLog } from "@/lib/report/ReportLog";
import { SignedLink } from "@/lib/report/SignedLink";
import { ServiceLineDrive } from "@/lib/report/ServiceLineDrive";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";

/** Latest delivery outcome, stored in ReportSnapshot.deliveryJson (admin-only). */
export interface DeliveryRecord {
  /** drive = uploaded to Google Drive; signed_link = fallback link issued; failed = neither worked. */
  status: "drive" | "signed_link" | "failed";
  attemptedAt: string;
  triggeredBy: string;
  drive?: { folderId: string; files: { name: string; id: string; webViewLink: string | null }[] };
  /** Why Drive was not used ("not configured" or the error). */
  driveError?: string;
  signedLink?: { pdfUrl: string; handoffUrl: string; expiresAt: string };
  signedLinkError?: string;
}

export interface DeliveryDeps {
  env?: EnvSource;
  fetch?: FetchLike;
  now?: Date;
}

/**
 * Delivers a frozen report. PRIMARY: upload the PDF and handoff.json to Nick's Google Drive
 * (OAuth refresh token, scope drive.file). FALLBACK when Drive is unconfigured or fails: a 7-day
 * HMAC-signed link that serves both files without app sign-in. Every attempt is logged
 * append-only in report_deliveries and the latest outcome is kept on the snapshot.
 */
export class ReportDeliveryService {
  static readonly NOT_CONFIGURED = "Google Drive is not configured";

  static parse(json: unknown): DeliveryRecord | null {
    return json && typeof json === "object" && "status" in json ? (json as DeliveryRecord) : null;
  }

  /** Deliver when never delivered, when everything failed, or when Drive is configured but was not used yet. */
  static needsDelivery(existing: DeliveryRecord | null, env: EnvSource = process.env): boolean {
    if (!existing || existing.status === "failed") return true;
    return existing.status === "signed_link" && ReportEnv.drive(env) !== null;
  }

  private static async log(
    db: PrismaClient,
    snapshotId: string,
    method: "drive" | "signed_link",
    status: "ok" | "failed" | "skipped",
    detail: Record<string, unknown>,
    triggeredBy: string,
    at: Date,
  ): Promise<void> {
    await db.reportDelivery.create({
      data: { snapshotId, method, status, detailJson: detail as Prisma.InputJsonValue, triggeredBy, attemptedAt: at },
    });
  }

  static async deliver(
    snapshotId: string,
    files: { pdf: ReportArtifact; handoff: ReportArtifact },
    triggeredBy: string,
    deps: DeliveryDeps = {},
    db: PrismaClient = Db.client,
    line: Pick<ServiceLineScope, "isDefault" | "shortName"> = ServiceLine.defaultScope(),
  ): Promise<DeliveryRecord> {
    // The Drive folder stays CVPSL-only (the Wednesday email reads the newest file there).
    ServiceLineDrive.assertRootAllowed(line);
    const env = deps.env ?? process.env;
    const now = deps.now ?? new Date();
    const record: DeliveryRecord = { status: "failed", attemptedAt: now.toISOString(), triggeredBy };

    const drive = ReportEnv.drive(env);
    if (drive) {
      try {
        const client = new GoogleDriveClient(drive, deps.fetch ?? fetch);
        const result = await client.upload(
          [files.pdf, files.handoff].map((f) => ({ name: f.fileName, contentType: f.contentType, bytes: f.bytes })),
        );
        record.status = "drive";
        record.drive = result;
        await ReportDeliveryService.log(db, snapshotId, "drive", "ok", { ...result }, triggeredBy, now);
        ReportLog.info("delivery.drive.ok", { snapshotId, folderId: result.folderId, fileIds: result.files.map((f) => f.id) });
      } catch (e) {
        record.driveError = e instanceof Error ? e.message : String(e);
        await ReportDeliveryService.log(db, snapshotId, "drive", "failed", { error: record.driveError }, triggeredBy, now);
        ReportLog.error("delivery.drive.failed", { snapshotId, error: record.driveError });
      }
    } else {
      record.driveError = ReportDeliveryService.NOT_CONFIGURED;
      await ReportDeliveryService.log(db, snapshotId, "drive", "skipped", { reason: record.driveError }, triggeredBy, now);
      ReportLog.warn("delivery.drive.skipped", { snapshotId, reason: record.driveError });
    }

    if (record.status !== "drive") {
      const secret = ReportEnv.shareLinkSecret(env);
      if (secret) {
        const expiresAt = SignedLink.expiryFor(now);
        const token = SignedLink.sign(snapshotId, expiresAt, secret);
        const baseUrl = ReportEnv.baseUrl(env);
        record.status = "signed_link";
        record.signedLink = { ...SignedLink.urls(baseUrl, token), expiresAt: expiresAt.toISOString() };
        await ReportDeliveryService.log(db, snapshotId, "signed_link", "ok", { ...record.signedLink }, triggeredBy, now);
        ReportLog.info("delivery.signed_link.issued", { snapshotId, expiresAt: record.signedLink.expiresAt, pdfUrl: record.signedLink.pdfUrl });
        if (!baseUrl) ReportLog.warn("delivery.signed_link.relative", { snapshotId, reason: "APP_BASE_URL is not set" });
      } else {
        record.signedLinkError = "SHARE_LINK_SECRET is not set (or shorter than 32 characters)";
        await ReportDeliveryService.log(db, snapshotId, "signed_link", "failed", { error: record.signedLinkError }, triggeredBy, now);
        ReportLog.error("delivery.failed", { snapshotId, driveError: record.driveError, signedLinkError: record.signedLinkError });
      }
    }

    await db.reportSnapshot.update({
      where: { id: snapshotId },
      data: { deliveryJson: record as unknown as Prisma.InputJsonValue },
    });
    return record;
  }
}
