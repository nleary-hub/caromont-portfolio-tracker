import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { LineLayoutService } from "@/lib/services/LineLayoutService";
import { ServiceAreaInfo, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { Requester } from "@/lib/domain/Requester";
import type { Prisma, PrismaClient, Project as PrismaProject, ProjectMilestone } from "@/generated/prisma/client";
import { ProjectRows } from "@/lib/domain/ProjectRows";
import type { ViewContext } from "@/generated/prisma/enums";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { HistoryDiff, type FieldChange } from "@/lib/history/HistoryDiff";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { RestoreRules, type RestoreTarget } from "@/lib/closed/RestoreRules";
import { DateOnly } from "@/lib/domain/DateOnly";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import { MilestoneRules, MilestoneValidationError, type MilestoneEdit } from "@/lib/domain/MilestoneRules";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { StartDate } from "@/lib/projects/StartDate";
import { ProjectValidationError, ProjectValidator, type ProjectData, type ProjectInput } from "@/lib/validation/ProjectValidator";

/** A stored project in domain terms: `serviceArea` is the department key (Project.departmentId), see ProjectRows. */
export type ProjectRow = Omit<PrismaProject, "serviceArea"> & { serviceArea: DepartmentKey | null };
type Project = ProjectRow;

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

/** Restore to active on a project that is no longer Cancelled (restored or changed elsewhere). */
export class ProjectNotCancelledError extends Error {
  constructor(id: string) {
    super(`Project ${id} is not cancelled`);
    this.name = "ProjectNotCancelledError";
  }
}

export type Tx = Prisma.TransactionClient;

export type { MilestoneEdit };

interface UpdateOptions {
  /** Legacy column values from a checklist save: written with the update but not diffed into history. */
  mirror?: { nextMilestone: string | null; dueDate: Date | null };
  /** Timestamp for the history rows (a form save shares one with its checklist rows). */
  at?: Date;
}

/**
 * The only write path for projects. Every mutation writes ProjectHistory rows in the
 * same transaction. There is intentionally no hard-delete method.
 */
export type PeopleField = "owner" | "physicianChampion" | "requesterNotApplicable" | "contractsLead" | "serviceArea";

export class ProjectService {
  static async create(input: ProjectInput, actor: Actor, db: PrismaClient = Db.client, scope: ServiceLineScope = ServiceLine.defaultScope()): Promise<Project> {
    ProjectValidator.parse(input, ProjectValidator.rulesOf(scope)); // fail fast, before opening a transaction
    return db.$transaction((tx) => ProjectService.createInTx(tx, input, actor, undefined, new Date(), scope));
  }

  /**
   * Create inside a caller-owned transaction (e.g. an all-or-nothing CSV import).
   * Validates, inserts, and writes the "created" history row on the same transaction.
   */
  static async createInTx(
    tx: Tx,
    input: ProjectInput,
    actor: Actor,
    parsed?: ProjectData,
    at: Date = new Date(),
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    const data = parsed ?? ProjectValidator.parse(input, ProjectValidator.rulesOf(scope));
    const now = at;
    const start = ProjectService.startDateForCreate(input, data, at);
    // The line is not a tracked field: it is set once here and never changes. Neither is the start date: it is not
    // part of the public "created" row below.
    const project = ProjectRows.fromDb(
      await tx.project.create({
        data: {
          ...(ProjectRows.toDb(data) as Omit<Prisma.ProjectUncheckedCreateInput, "serviceLineId" | "updatedBy">),
          serviceLineId: scope.id,
          updatedBy: actor.changedBy,
          startDate: DateOnly.toDbDate(start.date),
          startDateIsDefault: start.isDefault,
        },
      }),
    );
    // Manual row order: a new project goes to the bottom of its department.
    await LineLayoutService.placeNew(tx, scope, project.id, ServiceAreaInfo.groupOf(project.serviceArea), actor.changedBy);
    const snapshot: Record<string, string | null> = {};
    for (const field of HistoryDiff.TRACKED_FIELDS) {
      if (field in data) snapshot[field] = HistoryDiff.serialize(field, field === "serviceArea" ? ProjectService.departmentText(scope.departments, data.serviceArea) : data[field as keyof typeof data]);
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
   * The start date of a new project: the one entered (checked with StartDate rules), else the import day (ET) marked
   * as a default (CSV import, callers that do not send one).
   */
  private static startDateForCreate(input: ProjectInput, data: ProjectData, at: Date): { date: string; isDefault: boolean } {
    if (input.startDate === undefined || input.startDate === null) return { date: StartDate.fromInstant(at), isDefault: true };
    const errors = StartDate.errors(input.startDate, { status: data.status, completedOn: DateOnly.fromDbDate(data.completedOn), today: DateOnly.inZone(at) });
    if (errors.length) throw new ProjectValidationError({ startDate: errors });
    return { date: String(input.startDate).trim(), isDefault: false };
  }

  /**
   * Start date messages for a form save (StartDate.errors on the merged values). A stored start date that is still the
   * import default and not edited is not checked against the completed date (its real value is unknown), so editing
   * an old Complete project never gets blocked by it.
   */
  static startDateErrors(
    existing: Pick<Project, "status" | "completedOn"> & { startDate?: Date | null; startDateIsDefault?: boolean },
    values: Pick<Partial<ProjectInput>, "startDate" | "status" | "completedOn">,
    today: string,
  ): string[] {
    const edited = values.startDate !== undefined;
    const stored = DateOnly.fromDbDate(existing.startDate ?? null);
    const startDate = edited ? values.startDate : stored;
    const status = values.status !== undefined ? String(values.status) : existing.status;
    const completedOn = values.completedOn !== undefined ? values.completedOn : DateOnly.fromDbDate(existing.completedOn);
    const closeChanged = values.status !== undefined || values.completedOn !== undefined;
    if (!edited && (!closeChanged || existing.startDateIsDefault || stored === null)) return [];
    return StartDate.errors(startDate, { status, completedOn, today });
  }

  /**
   * Set a project's start date. NOT a status update: no tracked-field history row (so no Changed flag, no Stale
   * reset, no "Updated" date) and updatedBy is left alone. The change is audited in one admin-only "startDate"
   * ProjectHistory row (old and new day, who, when); the default flag clears. No-op when the day is unchanged.
   */
  static async applyStartDate(tx: Tx, id: string, startDate: string, actor: Actor, at: Date): Promise<Project> {
    const current = ProjectRows.fromDb((await tx.project.findUnique({ where: { id } }))!);
    const before = DateOnly.fromDbDate(current.startDate ?? null);
    const after = startDate.trim();
    if (before === after) return current;
    const updated = ProjectRows.fromDb(await tx.project.update({ where: { id }, data: { startDate: DateOnly.toDbDate(after), startDateIsDefault: false } }));
    await tx.projectHistory.create({
      data: { projectId: id, field: StartDate.HISTORY_FIELD, oldValue: before, newValue: after, changedAt: at, changedBy: actor.changedBy, comment: actor.comment ?? null },
    });
    return updated;
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
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    return db.$transaction((tx) => ProjectService.updateInTx(tx, id, patch, actor, "default", {}, scope));
  }

  /**
   * update() inside a caller-owned transaction (e.g. an all-or-nothing CSV wording update).
   * `mode: "form"` validates with the drawer form rules (ProjectValidator.validateForm): soft milestone
   * limit, and stored over-cap values accepted unless that field changes. Every other caller, including
   * the People autosave, uses the default rules through ProjectValidator.parseUpdate, so an unchanged stored
   * over-cap value never blocks them either.
   */
  static async updateInTx(
    tx: Tx,
    id: string,
    patch: Partial<ProjectInput>,
    actor: Actor,
    mode: "default" | "form" = "default",
    options: UpdateOptions = {},
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    const existing = await ProjectService.loadMutable(tx, id, scope);
    const rules = ProjectValidator.rulesOf(scope);
    // Requester: a new name clears Not applicable and Not applicable clears the name.
    const stored = ProjectValidator.toInput(existing);
    const editable = ProjectService.pickEditable(patch);
    // A checklist save owns the legacy milestone fields: its mirror replaces anything the patch says.
    if (options.mirror) {
      delete editable.nextMilestone;
      delete editable.dueDate;
    }
    const mirrorInput = options.mirror
      ? { nextMilestone: options.mirror.nextMilestone, dueDate: HistoryDiff.serialize("dueDate", options.mirror.dueDate) }
      : {};
    const merged: ProjectInput = { ...stored, ...Requester.normalizePatch(editable), ...mirrorInput };
    const data: Record<string, unknown> = {
      ...(mode === "form" ? ProjectValidator.parseForm(merged, { existing: stored, rules }) : ProjectValidator.parseUpdate(merged, stored, rules)),
    };

    // Reopening (status leaves Complete) clears completionReportedAt, so a later completion is listed
    // in "Completed this period" again. Bookkeeping only: not a tracked history field.
    if (existing.status === "Complete" && data.status !== "Complete" && existing.completionReportedAt) {
      data.completionReportedAt = null;
    }

    // Mirrored legacy fields are bookkeeping for a checklist save (its own history rows record the change).
    const diffed = options.mirror ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== "nextMilestone" && k !== "dueDate")) : data;
    const changes = HistoryDiff.diff(existing, diffed);
    const mirrorChanged = options.mirror ? HistoryDiff.diff(existing, { nextMilestone: data.nextMilestone, dueDate: data.dueDate }).length > 0 : false;
    if (changes.length === 0 && !mirrorChanged) return existing;

    const updated = ProjectRows.fromDb(
      await tx.project.update({
        where: { id },
        data: { ...(ProjectRows.toDb(data) as Prisma.ProjectUncheckedUpdateInput), updatedBy: actor.changedBy },
      }),
    );
    await ProjectService.writeHistory(tx, id, changes, actor, options.at ?? new Date(), scope.departments);
    // Manual row order: a project moved to another department goes to the bottom of that department.
    if (ServiceAreaInfo.groupOf(existing.serviceArea) !== ServiceAreaInfo.groupOf(updated.serviceArea)) {
      await LineLayoutService.placeMoved(tx, scope, id, ServiceAreaInfo.groupOf(updated.serviceArea), actor.changedBy);
    }
    // Outside the drawer (CSV wording update, Milestone met) the legacy fields lead: keep the checklist in step.
    if (!options.mirror && changes.some((c) => c.field === "nextMilestone" || c.field === "dueDate")) {
      await MilestoneService.syncLegacyEditInTx(tx, id, { nextMilestone: updated.nextMilestone, dueDate: updated.dueDate });
    }
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
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    return db.$transaction(async (tx) => {
      const existing = await ProjectService.loadMutable(tx, id, scope);
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

      const stored = ProjectValidator.toInput(existing);
      const merged: ProjectInput = {
        ...stored,
        nextMilestone,
        dueDate,
        ...(completion.note !== undefined ? { note: completion.note } : {}),
        ...(completion.markComplete ? { status: "Complete" } : {}),
      };
      const data = ProjectValidator.parseUpdate(merged, stored, ProjectValidator.rulesOf(scope));
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
      const updated = ProjectRows.fromDb(
        await tx.project.update({
          where: { id },
          data: { ...(ProjectRows.toDb(data) as Prisma.ProjectUncheckedUpdateInput), updatedBy: actor.changedBy },
        }),
      );
      await ProjectService.writeHistory(tx, id, changes, actor, now, scope.departments);
      if (changes.some((c) => c.field === "nextMilestone" || c.field === "dueDate")) {
        await MilestoneService.syncLegacyEditInTx(tx, id, { nextMilestone: updated.nextMilestone, dueDate: updated.dueDate });
      }
      return updated;
    });
  }

  static readonly MILESTONE_COMPLETED_FIELD = "milestone_completed";

  /** The fields the drawer edit form saves together (People save on pick through setPeopleField). */
  static readonly FORM_FIELDS = [
    "name",
    "serviceArea",
    "status",
    "inforRequestNumber",
    "nextMilestone",
    "dueDate",
    "percentComplete",
    "note",
    "accomplishment",
    "description",
    "completedOn",
  ] as const satisfies readonly (keyof ProjectInput)[];

  /**
   * Admin drawer form save: every changed form field in one transaction, so the save is one history
   * entry (one timestamp, one author; HistoryEntries groups its field rows). No-op when nothing changed.
   */
  static async saveForm(
    id: string,
    values: Partial<ProjectInput>,
    admin: Viewer,
    db: PrismaClient = Db.client,
    milestones?: MilestoneEdit | null,
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    const patch = ProjectService.pickFormFields(values);
    const actor = ProjectService.actorOf(admin);
    const startDate = values.startDate === undefined || values.startDate === null ? undefined : String(values.startDate);
    return db.$transaction(async (tx) => {
      const at = new Date();
      const existing = await ProjectService.loadMutable(tx, id, scope);
      // Start date errors come back with the other field errors (one inline message each, Save blocked).
      const startErrors = ProjectService.startDateErrors(existing, { startDate: values.startDate === null ? "" : startDate, status: patch.status, completedOn: patch.completedOn }, DateOnly.inZone(at));
      let mirror: UpdateOptions["mirror"];
      let project: Project;
      try {
        if (milestones) {
          const saved = await ProjectService.withMilestoneErrors(() =>
            MilestoneService.saveInTx(tx, id, milestones.drafts, actor, at, milestones.applied ?? null, scope),
          );
          if (saved.changed) mirror = saved.mirror;
        }
        project = await ProjectService.updateInTx(tx, id, patch, actor, "form", { mirror, at }, scope);
      } catch (e) {
        if (e instanceof ProjectValidationError && startErrors.length) throw new ProjectValidationError({ ...e.errors, startDate: startErrors });
        throw e;
      }
      if (startErrors.length) throw new ProjectValidationError({ startDate: startErrors });
      return startDate === undefined ? project : ProjectService.applyStartDate(tx, id, startDate, actor, at);
    });
  }

  /**
   * Drawer Milestones autosave ("Saves as you go"): one checklist change (check, rename, reorder, due date,
   * add, delete, apply template) in its own transaction, with one history row per action and the derived
   * next milestone mirrored to the legacy columns. Returns the stored steps. Admin only.
   */
  static async saveMilestones(
    id: string,
    milestones: MilestoneEdit,
    admin: Viewer,
    db: PrismaClient = Db.client,
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<ProjectMilestone[]> {
    AdminPolicy.assertAdmin(admin);
    const actor = ProjectService.actorOf(admin);
    return db.$transaction(async (tx) => {
      const at = new Date();
      await ProjectService.loadMutable(tx, id, scope);
      const saved = await ProjectService.withMilestoneErrors(() => MilestoneService.saveInTx(tx, id, milestones.drafts, actor, at, milestones.applied ?? null, scope));
      if (saved.changed) {
        try {
          await ProjectService.updateInTx(tx, id, {}, actor, "form", { mirror: saved.mirror, at }, scope);
        } catch (e) {
          // The status needs a next milestone (e.g. deleting the last step of an On track project).
          if (e instanceof ProjectValidationError && e.errors.nextMilestone) {
            throw new ProjectValidationError({ milestones: [ProjectService.MILESTONE_NEEDED_MESSAGE] });
          }
          throw e;
        }
      }
      return MilestoneService.stepsFor(tx, id);
    });
  }

  static readonly MILESTONE_NEEDED_MESSAGE = "This status needs at least one open milestone. Change the status first, or keep a milestone.";

  /** Checklist validation errors come back to the form under "milestones". */
  private static async withMilestoneErrors<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof MilestoneValidationError) throw new ProjectValidationError({ milestones: e.messages });
      throw e;
    }
  }

  /**
   * Admin "New project" from the drawer: form rules (name and department required, status defaults to
   * Not started), then the usual create with its "created" history row. People are set afterwards.
   */
  static async createFromForm(
    values: Partial<ProjectInput>,
    admin: Viewer,
    db: PrismaClient = Db.client,
    milestones?: MilestoneEdit | null,
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    const input: ProjectInput = { name: "", ...ProjectService.pickFormFields(values), status: values.status || "NotStarted" };
    const drafts = milestones?.drafts ?? [];
    if (drafts.length > 0) {
      // Checklist first (validated on its own), then the project with the derived next milestone.
      const plan = await ProjectService.withMilestoneErrors(async () => MilestoneRules.plan([], drafts, DateOnly.today(), milestones?.applied ?? null));
      const mirror = MilestoneProgress.mirror(plan.result);
      input.nextMilestone = mirror.nextMilestone;
      input.dueDate = HistoryDiff.serialize("dueDate", mirror.dueDate);
    }
    // The form always sends a start date (pre-filled with today, ET); blank is an error, not the import default.
    input.startDate = values.startDate === undefined ? undefined : String(values.startDate ?? "");
    const checked = ProjectValidator.validateForm(input, { existing: null, rules: ProjectValidator.rulesOf(scope) });
    const startErrors =
      input.startDate === undefined ? [] : StartDate.errors(input.startDate, { status: String(input.status), completedOn: input.completedOn ?? null, today: DateOnly.today() });
    if (!checked.ok || startErrors.length) throw new ProjectValidationError({ ...(checked.ok ? {} : checked.errors), ...(startErrors.length ? { startDate: startErrors } : {}) });
    const data = checked.data;
    const actor = ProjectService.actorOf(admin);
    return db.$transaction(async (tx) => {
      const at = new Date();
      const project = await ProjectService.createInTx(tx, input, actor, data, at, scope);
      if (drafts.length > 0) {
        await ProjectService.withMilestoneErrors(() => MilestoneService.saveInTx(tx, project.id, drafts, actor, at, milestones?.applied ?? null, scope));
      }
      return project;
    });
  }

  private static pickFormFields(values: Partial<ProjectInput>): Partial<ProjectInput> {
    const out: Record<string, unknown> = {};
    for (const key of ProjectService.FORM_FIELDS) if (key in values) out[key] = values[key];
    return out as Partial<ProjectInput>;
  }

  /** "Kickoff meeting (due 2026-10-03)" or just the milestone when there is no due date. */
  static describeMilestone(milestone: string, dueDate: Date | null): string {
    const due = HistoryDiff.serialize("dueDate", dueDate);
    return due ? `${milestone} (due ${due})` : milestone;
  }

  /**
   * Admin "Delete": soft delete (archivedAt + deletedBy). The record and its history are kept;
   * the DB still blocks hard deletes. Audited like every other change. Archived projects throw.
   */
  static async softDelete(id: string, admin: Viewer, db: PrismaClient = Db.client, comment?: string, scope: ServiceLineScope = ServiceLine.defaultScope()): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const existing = await ProjectService.loadMutable(tx, id, scope);
      const now = new Date();
      const data = { archivedAt: now, deletedBy: admin.email };
      const updated = ProjectRows.fromDb(await tx.project.update({ where: { id }, data: { ...data, updatedBy: admin.email } }));
      await ProjectService.writeHistory(tx, id, HistoryDiff.diff(existing, data), ProjectService.actorOf(admin, comment), now);
      return updated;
    });
  }

  /** Admin restore of a soft-deleted project. Writes audit rows. */
  static async restore(id: string, admin: Viewer, db: PrismaClient = Db.client, comment?: string, scope: ServiceLineScope = ServiceLine.defaultScope()): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const found = await tx.project.findUnique({ where: { id } });
      if (!found || !ServiceLineAccess.inScope(found, scope)) throw new ProjectNotFoundError(id);
      const existing = ProjectRows.fromDb(found);
      if (!existing.archivedAt) return existing;
      const now = new Date();
      const data = { archivedAt: null, deletedBy: null };
      const updated = ProjectRows.fromDb(await tx.project.update({ where: { id }, data: { ...data, updatedBy: admin.email } }));
      await ProjectService.writeHistory(tx, id, HistoryDiff.diff(existing, data), ProjectService.actorOf(admin, comment), now);
      return updated;
    });
  }

  /**
   * Admin "Restore to active" (Cancelled page): the status goes back to what it was before the latest cancellation
   * (RestoreRules, from ProjectHistory), else Not started. One `status` history row with the restore comment (the
   * History timeline reads "Restored from Cancelled. ..."). A direct status write, like the cancellation it undoes:
   * the form's milestone rules are not re-run on data that was valid when it was cancelled. Throws when the project
   * is not Cancelled (already restored in another tab), deleted, or of another line.
   */
  static async restoreFromCancelled(id: string, admin: Viewer, db: PrismaClient = Db.client, scope: ServiceLineScope = ServiceLine.defaultScope(), at: Date = new Date()): Promise<{ project: Project; target: RestoreTarget }> {
    AdminPolicy.assertAdmin(admin);
    return db.$transaction(async (tx) => {
      const existing = await ProjectService.loadMutable(tx, id, scope);
      if (existing.status !== "Cancelled") throw new ProjectNotCancelledError(id);
      const history = await tx.projectHistory.findMany({ where: { projectId: id, field: "status" }, select: { field: true, oldValue: true, newValue: true, changedAt: true } });
      const target = RestoreRules.target(history);
      const data = { status: target.status };
      const project = ProjectRows.fromDb(await tx.project.update({ where: { id }, data: { ...data, updatedBy: admin.email } }));
      await ProjectService.writeHistory(tx, id, HistoryDiff.diff(existing, data), ProjectService.actorOf(admin, RestoreRules.commentFor(target)), at);
      return { project, target };
    });
  }

  /** Admin per-project hide/unhide for one context. No-op when unchanged; otherwise audited. */
  /** Fields the admin drawer panel edits, one at a time (saved on change). */
  static readonly PEOPLE_FIELDS = ["owner", "physicianChampion", "requesterNotApplicable", "contractsLead", "serviceArea"] as const;

  static isPeopleField(field: string): field is PeopleField {
    return (ProjectService.PEOPLE_FIELDS as readonly string[]).includes(field);
  }

  /**
   * Admin drawer panel: set owner, requester (physicianChampion), requester Not applicable ("true"/"false"), contracts lead (pick-list)
   * or service area. A blank owner or requester goes back to "To assign". Goes through update(), so
   * validation applies and ProjectHistory records the change (no-op when unchanged).
   */
  static async setPeopleField(
    id: string,
    field: PeopleField,
    value: string,
    admin: Viewer,
    db: PrismaClient = Db.client,
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    if (field === "owner" || field === "physicianChampion") {
      // Combobox names: trimmed, whitespace collapsed, length-checked (PeopleDirectory).
      const checked = PeopleDirectory.validateName(field === "owner" ? "owner" : "requester", value);
      if (!checked.ok) throw new ProjectValidationError({ [field]: [checked.error] });
      value = checked.name;
    }
    const patch: Partial<ProjectInput> =
      field === "requesterNotApplicable" ? { requesterNotApplicable: value === "true" } : { [field]: value };
    // Clearing Not applicable leaves the requester "not yet addressed" (no name).
    return ProjectService.update(id, patch, ProjectService.actorOf(admin), db, scope);
  }

  /**
   * Admin > People rename: every project of the line (not deleted) whose owner (or requester) is `from`, ignoring
   * case and spacing, gets `to`, with a history entry each (so it reads like an edit in the drawer). Runs inside the
   * caller's transaction; returns how many projects changed. Frozen reports are snapshots and keep the old name.
   */
  /** ProjectHistory.comment on rows written by a People page rename (the History timeline reads it). */
  static readonly PEOPLE_RENAME_COMMENT = UpdateTimeline.PEOPLE_RENAME_COMMENT;

  static async renamePerson(tx: Tx, scope: Pick<ServiceLineScope, "id">, field: "owner" | "physicianChampion", from: string, to: string, admin: Viewer): Promise<number> {
    AdminPolicy.assertAdmin(admin);
    const key = PeopleDirectory.normalizeName(from).toLowerCase();
    if (!key) return 0;
    const rows = await tx.project.findMany({ where: { archivedAt: null, [field]: { not: null }, ...ServiceLineAccess.where(scope) } });
    const hits = rows.filter((r) => PeopleDirectory.normalizeName(r[field]).toLowerCase() === key && r[field] !== to);
    const at = new Date();
    for (const row of hits) {
      const existing = ProjectRows.fromDb(row);
      const data = { [field]: to };
      await tx.project.update({ where: { id: row.id }, data: { ...data, updatedBy: admin.email } });
      await ProjectService.writeHistory(tx, row.id, HistoryDiff.diff(existing, data), ProjectService.actorOf(admin, ProjectService.PEOPLE_RENAME_COMMENT), at);
    }
    return hits.length;
  }

  static async setHidden(
    id: string,
    context: ViewContext,
    hidden: boolean,
    admin: Viewer,
    db: PrismaClient = Db.client,
    scope: ServiceLineScope = ServiceLine.defaultScope(),
  ): Promise<Project> {
    AdminPolicy.assertAdmin(admin);
    const field = context === "dashboard" ? "hiddenFromDashboard" : "hiddenFromReport";
    return db.$transaction(async (tx) => {
      const existing = await ProjectService.loadMutable(tx, id, scope);
      if (existing[field] === hidden) return existing;
      const data = { [field]: hidden };
      const updated = ProjectRows.fromDb(await tx.project.update({ where: { id }, data: { ...data, updatedBy: admin.email } }));
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

  /** A department key as history text: its short name (null stays null; an unknown key stays as is). */
  static departmentText(list: DepartmentList, key: string | null | undefined): string | null {
    return key ? ServiceAreaInfo.label(key, list) : null;
  }

  private static actorOf(admin: Viewer, comment?: string): Actor {
    return { changedBy: admin.email, comment: comment ?? null };
  }

  /**
   * A project of `scope` that may be changed. A project of another service line, or of a department a limited user
   * doesn't have, is "not found" (no leak). Unassigned projects are open to everyone with the line.
   */
  private static async loadMutable(tx: Tx, id: string, scope: Pick<ServiceLineScope, "id" | "departmentLimit">): Promise<Project> {
    const found = await tx.project.findUnique({ where: { id } });
    if (!found || !ServiceLineAccess.inScope(found, scope) || !DepartmentAccess.allows(scope, found.departmentId)) {
      throw new ProjectNotFoundError(id);
    }
    if (found.archivedAt) throw new ProjectArchivedError(id);
    return ProjectRows.fromDb(found);
  }

  private static readonly EDITABLE_FIELDS: readonly (keyof ProjectInput)[] = [
    "name",
    "description",
    "inforRequestNumber",
    "serviceArea",
    "owner",
    "physicianChampion",
    "physicianChampionEmail",
    "requesterNotApplicable",
    "contractsLead",
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
    departments?: DepartmentList,
  ): Promise<void> {
    if (changes.length === 0) return;
    // A department change is recorded by its short name at the time (as before 0018, when values were "Cath"),
    // so the history keeps the name the project had even after a rename.
    const text = (c: FieldChange, v: string | null) => (c.field === "serviceArea" && departments ? ProjectService.departmentText(departments, v) : v);
    await tx.projectHistory.createMany({
      data: changes.map((c) => ({
        projectId,
        field: c.field,
        oldValue: text(c, c.oldValue),
        newValue: text(c, c.newValue),
        changedAt: at,
        changedBy: actor.changedBy,
        comment: actor.comment ?? null,
      })),
    });
  }
}
