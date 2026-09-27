import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { PrismaClient, ReportArtifact } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ReportEnv, type EnvSource } from "@/lib/config/ReportEnv";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ReportLog } from "@/lib/report/ReportLog";
import { SignedLink } from "@/lib/report/SignedLink";
import { ReportDeliveryService, type DeliveryRecord } from "@/lib/services/ReportDeliveryService";
import { ReportArtifactService, type ArtifactKind } from "@/lib/services/ReportArtifactService";

export interface ArchiveEntry {
  id: string;
  periodStart: string;
  periodEnd: string;
  frozenAt: Date;
  hasPdf: boolean;
  /** Admin only. */
  delivery?: DeliveryRecord | null;
  generatedBy?: string;
}

/** Signed-in archive of frozen reports (/reports). Delivery details and handoff.json are admin-only. */
export class ReportArchiveService {
  /** Frozen reports of the viewer's service line (only the default line has scheduled reports). */
  static async list(viewer: Viewer, db: PrismaClient = Db.client, scope: Pick<ServiceLineScope, "id"> = ServiceLine.defaultScope()): Promise<ArchiveEntry[]> {
    const snapshots = await db.reportSnapshot.findMany({
      where: ServiceLineAccess.where(scope),
      orderBy: { periodEnd: "desc" },
      select: { id: true, periodStart: true, periodEnd: true, generatedAt: true, generatedBy: true, pdfStorageKey: true, deliveryJson: true },
    });
    return snapshots.map((s) => ({
      id: s.id,
      periodStart: DateOnly.fromDbDate(s.periodStart)!,
      periodEnd: DateOnly.fromDbDate(s.periodEnd)!,
      frozenAt: s.generatedAt,
      hasPdf: Boolean(s.pdfStorageKey),
      ...(viewer.isAdmin ? { delivery: ReportDeliveryService.parse(s.deliveryJson), generatedBy: s.generatedBy } : {}),
    }));
  }

  /** A stored file for download, or null (unknown snapshot, not rendered yet, or handoff.json for a non-admin). */
  static async file(
    viewer: Viewer,
    snapshotId: string,
    kind: ArtifactKind,
    db: PrismaClient = Db.client,
    scope: Pick<ServiceLineScope, "id"> = ServiceLine.defaultScope(),
  ): Promise<ReportArtifact | null> {
    if (kind === "handoff" && !viewer.isAdmin) return null;
    if (!/^[0-9a-f-]{36}$/i.test(snapshotId)) return null;
    const snapshot = await db.reportSnapshot.findFirst({ where: { id: snapshotId }, select: { serviceLineId: true } });
    if (!ServiceLineAccess.inScope(snapshot, scope)) return null;
    return ReportArtifactService.get(snapshotId, kind, db);
  }

  /**
   * File behind a signed fallback link (no sign-in). Null for a bad, tampered or expired token, so
   * the route answers 404 without saying why; the reason is logged.
   */
  static async shared(
    token: string,
    kind: ArtifactKind,
    db: PrismaClient = Db.client,
    env: EnvSource = process.env,
    now: Date = new Date(),
  ): Promise<ReportArtifact | null> {
    const v = SignedLink.verify(token, ReportEnv.shareLinkSecret(env), now);
    if (!v.ok) {
      ReportLog.warn("share.rejected", { reason: v.reason, kind });
      return null;
    }
    return ReportArtifactService.get(v.snapshotId, kind, db);
  }
}
