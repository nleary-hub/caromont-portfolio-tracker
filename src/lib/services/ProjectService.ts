import type { Prisma, PrismaClient, Project } from "@/generated/prisma/client";
import type { ViewContext } from "@/generated/prisma/enums";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { HistoryDiff, type FieldChange } from "@/lib/history/HistoryDiff";
import { ProjectValidationError, ProjectValidator, type ProjectInput } from "@/lib/validation/ProjectValidator";

export interface Actor {
  /** Email (or name) of the signed-in user making the change. */
  changedBy: string;
  comment?: string | null;
}

export interface MilestoneCompletion {
  /** New next milestone. Required unless markComplete is true. */
  nextMilestone?: string | null;
  /** New due date, "YYYY-MM-DD". Required unless markComplete is true. */
  dueDate?: string | null;
  /** Optional replacement note (validated against AppConfig.NOTE_MAX_LENGTH). */
  note?: string | null;
  /** Mark the whole project Complete instead of setting a new milestone. */
  markComplete?: boolean;
}

export class MilestoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MilestoneError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} not found`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectArchivedError extends Error {
  constructor(id: string) {
    super(`Project ${id} is archived and cannot be modified`);
    this.name = "ProjectArchivedError";
  }
}

export type Tx = Prisma.TransactionClient;

/**
 * The only write path for projects. Every mutation writes ProjectHistory rows in the
 * same transaction. There is intentionally no hard-delete method.
 */
export type PeopleField = "owner" | "physicianChampion" | "physicianChampionEmail" | "serviceArea";

export class ProjectService {
  static async create(input: ProjectInput, actor: Actor, db: PrismaClient = Db.client): Promise<Project> {
    ProjectValidator.parse(input); // fail fast, before opening a transaction
    return db.$transaction((tx) => ProjectService.createInTx(tx, input, actor));
  }

  /**
   * Create inside a caller-owned transaction (e.g. an all-or-nothing CSV import).
   * Validates, inserts, and writes the "created" history row on the same transaction.
   */
  static async createInTx(tx: Tx, input: ProjectInput, actor: Actor): Promise<Project> {
    const data = ProjectValidator.parse(input);
    const now = new Date();
    const project = await tx.project.create({ data: { ...data, updatedBy: actor.changedBy } });
    const snapshot: Record<string, string | null> = {};
    for (const field of HistoryDiff.TRACKED_FIELDS) {
      if (field in data) snapshot[field] = HistoryDiff.serialize(field, data[field as keyof typeof data]);
    }
    await tx.projectHistory.create({
      data: {
        projectId: project.id,
        field: "created",
        oldValue: null,
        newValue: JSON.stringify(snapshot),
        changedAt: now,
        changedBy: actor.changedBy,
        comment: actor.comment ?? null,
      },
    });
    return project;
  }

  /**
   * Apply a partial update. The patch is merged onto the stored project and the merged
   * result is validated as a whole (e.g. nextMilestone vs status).
   * No-op (no writes) when nothing actually changes.
   */
  static async update(
    id: string,
    patch: Partial<ProjectInput>,
    actor: Actor,
    db: PrismaClient = Db.client,
  ): Promise<Project> {
    return db.$transaction((tx) => ProjectService.updateInTx(tx, id, patch, actor));
  }

  /** update() inside a caller-owned transaction (e.g. an all-or-nothing CSV wording update). */
  static async updateInTx(tx: Tx, id: string, patch: Partial<ProjectInput>, actor: Actor): Promise<Project> {
    const existing = await ProjectService.loadMutable(tx, id);
    const merged: ProjectInput = { ...ProjectValidator.toInput(existing), ...ProjectService.pickEditable(patch) };
    const data: Record<string, unknown> = { ...ProjectValidator.parse(merged) };

    // Reopening (status leaves Complete) clears completionReportedAt, so a later completion is listed
    // in "Completed this period" again. Bookkeeping only: not a tracked history field.
    if (existing.status === "Complete" && data.status !== "Complete" && existing.completionReportedAt) {
      data.completionReportedAt = null;
    }

    const changes = HistoryDiff.diff(existing, data);
    if (changes.length === 0) return existing;

    const updated = await tx.project.update({
      where: { id },
      data: { ...(data as Prisma.ProjectUpdateInput), updatedBy: actor.changedBy },
    });
    await ProjectService.writeHistory(tx, id, changes, actor, new Date());
    return updated;
  }

  /**
   * "Milestone met": in one transaction, append a `milestone_completed` history row
   * (oldValue = previous milestone + due date), then set the new nextMilestone/dueDate
   * (or mark the project Complete). Field-level history rows are written as usual.
   */
  static async completeMilestone(
    id: string,
    completion: MilestoneCompletion,
    actor: Actor,
    db: PrismaClient = Db.client,
  ): Promise<Project> {
    return db.$transaction(async (tx) => {
      const existing = await ProjectService.loadMutable(tx, id);
      if (!existing.nextMilestone) throw new MilestoneError("Project has no current milestone to complete");
      if (ProjectStatusInfo.isClosed(existing.status)) {
        throw new MilestoneError("Project is already Complete or Cancelled");
      }

      const nextMilestone = completion.nextMilestone?.trim() || null;
      const dueDate = completion.dueDate?.trim() || null;
      if (!completion.markComplete) {
        const missing: Record<string, string[]> = {};
        if (!nextMilestone) missing.nextMilestone = ["New next milestone is required"];
        if (!dueDate) missing.dueDate = ["New due date is required"];
        if (Object.keys(missing).length) throw new ProjectValidationError(missing);
      }

      const merged: ProjectInput = {
        ...ProjectValidator.toInput(existing),
        nextMilestone,
        dueDate,
        ...(completion.note !== undefined ? { note: completion.note } : {}),
        ...(completion.markComplete ? { status: "Complete" } : {}),
      };
      const data = ProjectValidator.parse(merged);
      const now = new Date();

      await tx.projectHistory.create({
        data: {
          projectId: id,
          field: ProjectService.MILESTONE_COMPLETED_FIELD,
          oldValue: ProjectService.describeMilestone(existing.nextMilestone, existing.dueDate),
          newValue: completion.markComplete ? "Project marked Complete" : null,
          changedAt: now,
          changedBy: actor.changedBy,
          comment: actor.comment ?? null,
        },
      });

      const changes = HistoryDiff.diff(existing, { ...data });
      const updated = await tx.project.update({
        where: { id },
        data: { ...data, updatedBy: actor.changedBy },
      });
      await ProjectService.writeHistory(tx, id, changes, actor, now);
      return updated;
    });
  }

  static readonly MILESTONE_COMPLETED_FIELD = "milestone_completed";

  /** "Kickoff meeting (due 2026-10-03)" or just the milestone when there is no due date. */
  static describeMilestone(milestone: string, dueDate: Date | null): string {
    const due = HistoryDiff.serialize("dueDate", dueDate);
    return due ? `${milestone} (due ${due})` : milestone;
  }

  /**
   * Admin "Delete": soft delete (archivedAt + deletedBy). The record and its history are kept;
   * the DB still blocks hard deletes. Audited like every other change. Archived projects throw.
   */
  static async softDelete(id: string, admin: Viewer, db: PrismaClient = Db.client, comment?: string): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const existing = await ProjectService.loadMutable(tx, id);
      const now = new Date();
      const data = { archivedAt: now, deletedBy: admin.email };
      const updated = await tx.project.update({ where: { id }, data: { ...data, updatedBy: admin.email } });
      await ProjectService.writeHistory(tx, id, HistoryDiff.diff(existing, data), ProjectService.actorOf(admin, comment), now);
      return updated;
    });
  }

  /** Admin restore of a soft-deleted project. Writes audit rows. */
  static async restore(id: string, admin: Viewer, db: PrismaClient = Db.client, comment?: string): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const existing = await tx.project.findUnique({ where: { id } });
      if (!existing) throw new ProjectNotFoundError(id);
      if (!existing.archivedAt) return existing;
      const now = new Date();
      const data = { archivedAt: null, deletedBy: null };
      const updated = await tx.project.update({ where: { id }, data: { ...data, updatedBy: admin.email } });
      await ProjectService.writeHistory(tx, id, HistoryDiff.diff(existing, data), ProjectService.actorOf(admin, comment), now);
      return updated;
    });
  }

  /** Admin per-project hide/unhide for one context. No-op when unchanged; otherwise audited. */
  /** Fields the admin drawer panel edits, one at a time (saved on change). */
  static readonly PEOPLE_FIELDS = ["owner", "physicianChampion", "physicianChampionEmail", "serviceArea"] as const;

  static isPeopleField(field: string): field is PeopleField {
    return (ProjectService.PEOPLE_FIELDS as readonly string[]).includes(field);
  }

  /**
   * Admin drawer panel: set owner, physician champion (and email) or service area. Blank owner or champion
   * clears it back to "To assign". Goes through update(), so validation applies and ProjectHistory records
   * the change (no-op when unchanged).
   */
  static async setPeopleField(id: string, field: PeopleField, value: string, admin: Viewer, db: PrismaClient = Db.client): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    return ProjectService.update(id, { [field]: value }, ProjectService.actorOf(admin), db);
  }

  static async setHidden(
    id: string,
    context: ViewContext,
    hidden: boolean,
    admin: Viewer,
    db: PrismaClient = Db.client,
  ): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    const field = context === "dashboard" ? "hiddenFromDashboard" : "hiddenFromReport";
    return db.$transaction(async (tx) => {
      const existing = await ProjectService.loadMutable(tx, id);
      if (existing[field] === hidden) return existing;
      const data = { [field]: hidden };
      const updated = await tx.project.update({ where: { id }, data: { ...data, updatedBy: admin.email } });
      await ProjectService.writeHistory(tx, id, HistoryDiff.diff(existing, data), ProjectService.actorOf(admin), new Date());
      return updated;
    });
  }

  /**
   * Freeze bookkeeping: mark projects listed in a frozen report's "Completed this period" block so they
   * are listed only once. Runs inside the snapshot transaction. Writes no history row on purpose: a
   * history row would set the Changed flag and the "Updated" date, and nothing about the project changed.
   * Only rows still unmarked are touched, so re-running is harmless.
   */
  static async markCompletionReported(tx: Tx, projectIds: readonly string[], at: Date): Promise<number> {
    let count = 0;
    for (const id of projectIds) {
      const p = await tx.project.findUnique({ where: { id } });
      if (!p || p.completionReportedAt || p.status !== "Complete") continue;
      await tx.project.update({ where: { id }, data: { completionReportedAt: at } });
      count += 1;
    }
    return count;
  }

  private static actorOf(admin: Viewer, comment?: string): Actor {
    return { changedBy: admin.email, comment: comment ?? null };
  }

  private static async loadMutable(tx: Tx, id: string): Promise<Project> {
    const existing = await tx.project.findUnique({ where: { id } });
    if (!existing) throw new ProjectNotFoundError(id);
    if (existing.archivedAt) throw new ProjectArchivedError(id);
    return existing;
  }

  private static readonly EDITABLE_FIELDS: readonly (keyof ProjectInput)[] = [
    "name",
    "description",
    "inforRequestNumber",
    "serviceArea",
    "owner",
    "physicianChampion",
    "physicianChampionEmail",
    "status",
    "nextMilestone",
    "dueDate",
    "targetCompletion",
    "percentComplete",
    "note",
    "accomplishment",
    "completedOn",
    "includeInReport",
  ];

  /** Drop anything that is not a user-editable field (ids, audit fields, archivedAt, hide flags, ...). */
  private static pickEditable(patch: Partial<ProjectInput>): Partial<ProjectInput> {
    const out: Record<string, unknown> = {};
    for (const key of ProjectService.EDITABLE_FIELDS) {
      if (key in patch) out[key] = patch[key];
    }
    return out as Partial<ProjectInput>;
  }

  private static async writeHistory(
    tx: Tx,
    projectId: string,
    changes: FieldChange[],
    actor: Actor,
    at: Date,
  ): Promise<void> {
    if (changes.length === 0) return;
    await tx.projectHistory.createMany({
      data: changes.map((c) => ({
        projectId,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        changedAt: at,
        changedBy: actor.changedBy,
        comment: actor.comment ?? null,
      })),
    });
  }
}
