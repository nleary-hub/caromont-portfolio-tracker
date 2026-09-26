import type { PrismaClient, ReportArtifact, ReportSnapshot } from "@/generated/prisma/client";
import { ReportEnv } from "@/lib/config/ReportEnv";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { ReportLog } from "@/lib/report/ReportLog";
import { ReportSchedule, type ReportPeriod } from "@/lib/report/ReportSchedule";
import { ReportArtifactService } from "@/lib/services/ReportArtifactService";
import { ReportDeliveryService, type DeliveryDeps, type DeliveryRecord } from "@/lib/services/ReportDeliveryService";
import { SnapshotExistsError, SnapshotService } from "@/lib/services/SnapshotService";

export type FreezeTrigger = "cron" | "manual";

export interface FreezeOptions extends DeliveryDeps {
  trigger: FreezeTrigger;
  /** Who is freezing: "cron" or the admin's email. */
  actor: string;
}

export type FreezeOutcome =
  /** New snapshot frozen (and rendered, delivered). */
  | "created"
  /** Snapshot already existed; any missing file or delivery was completed. */
  | "already_frozen"
  /** Nothing to do: before the first freeze, or not a freeze time yet. */
  | "skipped"
  /** Manual run refused (nothing due and today is not a freeze date). */
  | "refused";

export interface FreezeResult {
  outcome: FreezeOutcome;
  message: string;
  period?: ReportPeriod;
  snapshotId?: string;
  delivery?: DeliveryRecord | null;
}

/**
 * The biweekly freeze. Idempotent per report period: the snapshot is unique on (periodStart,
 * periodEnd), and every later step (PDF, handoff.json, delivery) is completed only if missing, so
 * the daily cron, a retry and the manual backstop can all run safely.
 *
 * Cron: freezes the latest freeze date whose 5 PM ET has passed if it has no snapshot yet; on any
 * other day it only finishes missing steps for that period. Manual "Freeze now": same target, and
 * if that period is already frozen but today is a freeze date before 5 PM, freezes today's period
 * early; otherwise refuses and names the next freeze date.
 */
export class FreezeService {
  static target(now: Date, trigger: FreezeTrigger, frozen: (p: ReportPeriod) => boolean): ReportPeriod | FreezeResult {
    const due = ReportSchedule.dueFreezeDate(now);
    const today = DateOnly.inZone(now);
    const next = ReportSchedule.nextFreezeOnOrAfter(due === today ? ReportSchedule.addDays(today, 1) : today);
    const nextLabel = `${ReportFormat.longDate(next)} at 5 PM ET`;
    if (trigger === "cron") {
      if (!due) return { outcome: "skipped", message: `Before the first freeze (${nextLabel}).` };
      return ReportSchedule.periodFor(due);
    }
    if (due && !frozen(ReportSchedule.periodFor(due))) return ReportSchedule.periodFor(due);
    if (ReportSchedule.isFreezeDate(today) && due !== today) {
      const early = ReportSchedule.periodFor(today);
      if (!frozen(early)) return early;
    }
    if (due) return ReportSchedule.periodFor(due); // already frozen: re-run completes any missing step
    return { outcome: "refused", message: `Nothing to freeze yet. The next freeze is ${nextLabel}.` };
  }

  static async run(options: FreezeOptions, db: PrismaClient = Db.client): Promise<FreezeResult> {
    const now = options.now ?? new Date();
    const frozenPeriods = new Map<string, ReportSnapshot>();
    const due = ReportSchedule.dueFreezeDate(now);
    const today = DateOnly.inZone(now);
    for (const d of new Set([due, ReportSchedule.isFreezeDate(today) ? today : null])) {
      if (!d) continue;
      const p = ReportSchedule.periodFor(d);
      const s = await SnapshotService.findForPeriod(p.periodStart, p.periodEnd, db);
      if (s) frozenPeriods.set(p.periodEnd, s);
    }
    const target = FreezeService.target(now, options.trigger, (p) => frozenPeriods.has(p.periodEnd));
    if ("outcome" in target) {
      ReportLog.info("freeze.noop", { trigger: options.trigger, outcome: target.outcome, message: target.message });
      return target;
    }

    let snapshot = frozenPeriods.get(target.periodEnd) ?? null;
    let outcome: FreezeOutcome = "already_frozen";
    if (!snapshot) {
      try {
        snapshot = await SnapshotService.create({ ...target, generatedBy: options.actor, now }, db);
        outcome = "created";
        ReportLog.info("freeze.snapshot.created", { snapshotId: snapshot.id, ...target, trigger: options.trigger });
      } catch (e) {
        // Lost a race with another run (unique period, or a serialization conflict): use the winner's row.
        const existing = await SnapshotService.findForPeriod(target.periodStart, target.periodEnd, db);
        if (!existing || !(e instanceof SnapshotExistsError || (e as { code?: unknown })?.code === "P2034")) throw e;
        snapshot = existing;
      }
    }

    const result = await FreezeService.complete(snapshot, options, db);
    const label = ReportFormat.period(target.periodStart, target.periodEnd);
    return {
      outcome,
      period: target,
      snapshotId: snapshot.id,
      delivery: result,
      message:
        outcome === "created"
          ? `Froze the report for ${label}.`
          : `The report for ${label} was already frozen${result ? "; missing steps were completed" : ""}.`,
    };
  }

  /** Render the PDF, write handoff.json and deliver, each only if not done yet. Returns the delivery done now, if any. */
  static async complete(snapshot: ReportSnapshot, options: FreezeOptions, db: PrismaClient = Db.client): Promise<DeliveryRecord | null> {
    const env = options.env ?? process.env;
    const input = PdfReportRenderer.inputFromSnapshot(snapshot);

    let pdf: ReportArtifact | null = await ReportArtifactService.get(snapshot.id, "pdf", db);
    if (!pdf) {
      const bytes = await PdfReportRenderer.render(input);
      pdf = await ReportArtifactService.store(
        {
          snapshotId: snapshot.id,
          kind: "pdf",
          fileName: PdfReportRenderer.fileName(input.periodEnd),
          contentType: PdfReportRenderer.CONTENT_TYPE,
          bytes,
        },
        db,
      );
      ReportLog.info("freeze.pdf.stored", { snapshotId: snapshot.id, bytes: pdf.byteSize });
    }
    if (!snapshot.pdfStorageKey) {
      snapshot = await db.reportSnapshot.update({
        where: { id: snapshot.id },
        data: { pdfStorageKey: ReportArtifactService.storageKey(pdf.id) },
      });
    }

    let handoff: ReportArtifact | null = await ReportArtifactService.get(snapshot.id, "handoff", db);
    if (!handoff) {
      const reportRecipient = ReportEnv.reportRecipient(env);
      if (!reportRecipient) {
        ReportLog.warn("handoff.recipient.missing", {
          snapshotId: snapshot.id,
          reason: "REPORT_RECIPIENT_EMAIL is unset or not a single valid address; reportRecipient omitted",
        });
      }
      const baseUrl = ReportEnv.baseUrl(env);
      if (!baseUrl) ReportLog.warn("handoff.base_url.missing", { snapshotId: snapshot.id, reason: "APP_BASE_URL is not set" });
      const json = HandoffBuilder.build({
        snapshotId: snapshot.id,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        reportDate: input.reportDate,
        frozenAt: snapshot.generatedAt,
        rows: input.rows,
        header: input.header,
        completed: input.completed,
        pdf: { fileName: pdf.fileName, sha256: pdf.sha256, byteSize: pdf.byteSize },
        baseUrl,
        reportRecipient,
        serviceLineName: input.serviceLine?.name,
      });
      handoff = await ReportArtifactService.store(
        {
          snapshotId: snapshot.id,
          kind: "handoff",
          fileName: HandoffBuilder.fileName(input.periodEnd),
          contentType: HandoffBuilder.CONTENT_TYPE,
          bytes: HandoffBuilder.toBytes(json),
        },
        db,
      );
    }

    if (!ReportDeliveryService.needsDelivery(ReportDeliveryService.parse(snapshot.deliveryJson), env)) return null;
    return ReportDeliveryService.deliver(snapshot.id, { pdf, handoff }, options.actor, options, db);
  }
}
