import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ProjectEditPolicy } from "@/lib/access/ProjectEditPolicy";

type Db = Pick<PrismaClient, "$transaction">;
type Tx = Pick<Prisma.TransactionClient, "project" | "projectHistory">;

/** Stored in the "reviewed" history row's oldValue/newValue. Null = not reviewed. */
export interface ReviewedValue {
  at: string;
  by: string;
}

export interface ReviewResult {
  /** Projects marked (or restored, for undo). */
  ids: string[];
  /** Requested projects skipped because the viewer may not edit them (or they do not exist). */
  skipped: number;
  /** The review time written (ISO), for Undo. */
  at: string;
}

/**
 * "Mark as reviewed" (migration 0034, Nick, Oct 12, 2026). Writes Project.reviewedAt/reviewedBy and one append-only
 * ProjectHistory row per project (field "reviewed", old and new {at, by}; comment "bulk" for Mark all, "undo" for Undo).
 * It clears the Changed flag only (ReportBuilder.isReviewed); it is not an update (VisibilityPolicy
 * NOT_AN_UPDATE_HISTORY_FIELDS), so it never sets Changed, never resets Stale and never moves "Updated". It never
 * touches updatedBy, snapshots, stored PDFs, handoff.json or report_artifacts, and never deletes history.
 * Every project is checked with ProjectEditPolicy; the ones the viewer may not edit are skipped.
 */
export class ReviewService {
  static readonly HISTORY_FIELD = "reviewed";
  static readonly BULK_COMMENT = "bulk";
  static readonly UNDO_COMMENT = "undo";
  /** Upper bound on one request (a line has far fewer projects). */
  static readonly MAX_IDS = 500;

  static value(at: Date | null | undefined, by: string | null | undefined): ReviewedValue | null {
    return at ? { at: at.toISOString(), by: by ?? "" } : null;
  }

  static parse(stored: string | null | undefined): ReviewedValue | null {
    if (!stored) return null;
    try {
      const v = JSON.parse(stored) as unknown;
      if (v && typeof v === "object" && typeof (v as ReviewedValue).at === "string") return { at: (v as ReviewedValue).at, by: String((v as ReviewedValue).by ?? "") };
    } catch {
      /* not a reviewed value */
    }
    return null;
  }

  private static ids(ids: readonly unknown[]): string[] {
    const ok = ids.filter((id): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id));
    return [...new Set(ok)].slice(0, ReviewService.MAX_IDS);
  }

  static async mark(db: Db, viewer: Viewer, scope: Pick<ServiceLineScope, "id" | "departmentLimit">, projectIds: readonly unknown[], bulk: boolean, now: Date = new Date()): Promise<ReviewResult> {
    const wanted = ReviewService.ids(projectIds);
    return db.$transaction(async (tx: Tx) => {
      const rows = await tx.project.findMany({ where: { id: { in: wanted } } });
      const editable = rows.filter((p) => ProjectEditPolicy.canEdit(viewer, scope, p));
      const next: ReviewedValue = { at: now.toISOString(), by: viewer.email };
      for (const p of editable) {
        await tx.project.update({ where: { id: p.id }, data: { reviewedAt: now, reviewedBy: viewer.email }, select: { id: true } });
        await tx.projectHistory.create({
          data: {
            projectId: p.id,
            field: ReviewService.HISTORY_FIELD,
            oldValue: ReviewService.stringify(ReviewService.value(p.reviewedAt, p.reviewedBy)),
            newValue: JSON.stringify(next),
            changedAt: now,
            changedBy: viewer.email,
            comment: bulk ? ReviewService.BULK_COMMENT : null,
          },
        });
      }
      return { ids: editable.map((p) => p.id), skipped: wanted.length - editable.length, at: next.at };
    });
  }

  /**
   * Undo (the 8 second toast): for each project still carrying exactly the review written at `at` by this viewer,
   * restore the value before it (from that review's history row) and append a reversal row. Nothing is deleted.
   */
  static async undo(db: Db, viewer: Viewer, scope: Pick<ServiceLineScope, "id" | "departmentLimit">, projectIds: readonly unknown[], at: string, now: Date = new Date()): Promise<ReviewResult> {
    const wanted = ReviewService.ids(projectIds);
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) return { ids: [], skipped: wanted.length, at };
    return db.$transaction(async (tx: Tx) => {
      const rows = await tx.project.findMany({ where: { id: { in: wanted } } });
      const restored: string[] = [];
      for (const p of rows) {
        if (!ProjectEditPolicy.canEdit(viewer, scope, p)) continue;
        if (p.reviewedAt?.getTime() !== when.getTime() || p.reviewedBy !== viewer.email) continue;
        const mark = await tx.projectHistory.findFirst({
          where: { projectId: p.id, field: ReviewService.HISTORY_FIELD, changedAt: when, changedBy: viewer.email },
          orderBy: { changedAt: "desc" },
        });
        const before = ReviewService.parse(mark?.oldValue ?? null);
        const beforeAt = before ? new Date(before.at) : null;
        await tx.project.update({ where: { id: p.id }, data: { reviewedAt: beforeAt, reviewedBy: before?.by || null }, select: { id: true } });
        await tx.projectHistory.create({
          data: {
            projectId: p.id,
            field: ReviewService.HISTORY_FIELD,
            oldValue: JSON.stringify({ at: when.toISOString(), by: viewer.email }),
            newValue: ReviewService.stringify(before),
            changedAt: now,
            changedBy: viewer.email,
            comment: ReviewService.UNDO_COMMENT,
          },
        });
        restored.push(p.id);
      }
      return { ids: restored, skipped: wanted.length - restored.length, at };
    });
  }

  private static stringify(v: ReviewedValue | null): string | null {
    return v ? JSON.stringify(v) : null;
  }
}
