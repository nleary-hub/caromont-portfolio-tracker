import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ProjectEditPolicy } from "@/lib/access/ProjectEditPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { OwnerNameLists } from "@/lib/people/OwnerNameLists";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { BlockerHistory, type BlockerHistoryValue, type DependencyHistoryValue } from "@/lib/projects/BlockerHistory";
import { BlockerRules, type BlockerProblem } from "@/lib/projects/BlockerRules";
import { DependencyCopy } from "@/lib/projects/DependencyCopy";
import { DependencyGraph, type DependencyProblem } from "@/lib/projects/DependencyGraph";

/** The scope fields used here. People lists are optional so callers without them (tests) still work. */
type Scope = Pick<ServiceLineScope, "id" | "departmentLimit"> & Partial<Pick<ServiceLineScope, "owners" | "requesters" | "contractsLeads">>;

export type DependencyDb = Pick<PrismaClient, "project" | "projectDependency"> &
  Partial<Pick<PrismaClient, "projectBlocker" | "projectMilestone" | "projectHistory" | "milestoneOwnerName" | "dependencyPromptDismissal">>;
type Tx = Pick<Prisma.TransactionClient, "project" | "projectDependency" | "projectBlocker" | "projectMilestone" | "projectHistory" | "milestoneOwnerName">;
type WriteDb = Pick<PrismaClient, "$transaction">;

/** A project as the pickers show it. */
export interface DependencyProjectDto {
  id: string;
  name: string;
}

export interface MilestoneRefDto {
  id: string;
  name: string;
}

/** One row of the "Blocked by" or "Blocking" list. `project` is the OTHER project. */
export interface DependencyRowDto {
  project: DependencyProjectDto & { status: ProjectStatus };
  note: string | null;
  /** The blocked project's milestone this holds up. */
  milestone: MilestoneRefDto | null;
  /** YYYY-MM-DD (America/New_York) the dependency was added. */
  since: string;
  /** Blocked-by rows for an editor only: the blocker is Complete and this viewer has not dismissed "Clear it?" (1b). */
  prompt?: boolean;
}

export interface BlockerDto {
  id: string;
  description: string;
  waitingOn: string;
  since: string;
  followUpOn: string | null;
  followUpOwner: string | null;
  milestone: MilestoneRefDto | null;
  resolvedOn: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface DependencyView {
  /** True when this viewer may change anything here (ProjectEditPolicy). False = read-only drawer. */
  canEdit: boolean;
  /** Projects this one is blocked by (open, visible to the viewer), A to Z. */
  blockedBy: DependencyRowDto[];
  /** Projects blocked by this one (open, visible to the viewer), A to Z. */
  blocking: DependencyRowDto[];
  /** Open external blockers, oldest first. */
  blockers: BlockerDto[];
  /** Resolved external blockers, newest first (kept, never deleted). */
  resolved: BlockerDto[];
  /** Projects that may be added as blockers: the viewer's open projects, not this one, not already listed. A to Z. */
  options: DependencyProjectDto[];
  /** This project's open milestones, in order (the "Blocked milestone" picker). */
  milestones: MilestoneRefDto[];
  /** Follow-up owner choices: every people list of the line (OwnerNameLists.combined). */
  people: string[];
  /** Open items: blocked-by rows plus open external blockers (the section's count chip). */
  openCount: number;
  /** Today, America/New_York (overdue follow-ups). */
  today: string;
}

/** A rejected edge: self, duplicate or cycle. The message is safe to show. */
export class DependencyRuleError extends Error {
  constructor(
    readonly problem: DependencyProblem,
    message: string = DependencyGraph.MESSAGES[problem],
  ) {
    super(message);
    this.name = "DependencyRuleError";
  }
}

/** A refused blocker or note value. The message is safe to show. */
export class BlockerInputError extends Error {
  constructor(readonly problem: BlockerProblem) {
    super(BlockerRules.MESSAGES[problem]);
    this.name = "BlockerInputError";
  }
}

/** The project or the blocker is not one this viewer may edit or see (always the same generic answer). */
export class DependencyAccessError extends Error {
  constructor() {
    super("Not found.");
    this.name = "DependencyAccessError";
  }
}

export interface DependencyInput {
  note?: unknown;
  blockedMilestoneId?: unknown;
}

export interface BlockerInput {
  description: unknown;
  waitingOn: unknown;
  followUpOn?: unknown;
  followUpOwner?: unknown;
  blockedMilestoneId?: unknown;
}

type ProjectRow = { id: string; name: string; status: ProjectStatus; serviceLineId: string; departmentId: string | null; archivedAt: Date | null };

/**
 * Project dependencies (0037) and external blockers (0055). Only a viewer who may edit the BLOCKED project
 * (ProjectEditPolicy: admin of the line, inside their department access, project not deleted) may change them; a
 * blocker project must be an open project of the same line inside that access. Any edge that would create a cycle is
 * rejected, checked against every open edge of the line under a per-line advisory lock. Every add, edit, remove and
 * resolve writes a ProjectHistory row on the blocked project in the SAME transaction (BlockerHistory fields; not
 * updates, so Changed, Stale and "Updated" never move). Dependencies are soft-removed (removedAt/removedBy) and
 * re-used if the same pair is added again; external blockers are never deleted, only resolved. Nothing here is read
 * by FreezeService, snapshots, stored PDFs or handoff.json.
 */
export class ProjectDependencyService {
  private static readonly SELECT = { id: true, name: true, status: true, serviceLineId: true, departmentId: true, archivedAt: true } as const;
  static readonly LOCK_PREFIX = "project_dependencies:";

  private static async project(id: string, db: Pick<DependencyDb, "project">): Promise<ProjectRow | null> {
    return (await db.project.findUnique({ where: { id: String(id) }, select: ProjectDependencyService.SELECT })) as ProjectRow | null;
  }

  private static async editable(viewer: Viewer, scope: Scope, id: string, db: Pick<DependencyDb, "project">): Promise<ProjectRow> {
    const p = await ProjectDependencyService.project(id, db);
    if (!p || !ProjectEditPolicy.canEdit(viewer, scope, p)) throw new DependencyAccessError();
    return p;
  }

  private static visible(scope: Scope, p: { serviceLineId: string; departmentId: string | null; archivedAt: Date | null }): boolean {
    return !p.archivedAt && ServiceLineAccess.inScope(p, scope) && DepartmentAccess.allows(scope, p.departmentId);
  }

  private static byName<T extends { name: string; id: string }>(a: T, b: T): number {
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  }

  private static people(scope: Scope, milestoneOwners: readonly string[]): string[] {
    return OwnerNameLists.combined({ owners: scope.owners ?? [], requesters: scope.requesters ?? [], contractsLeads: scope.contractsLeads ?? [] }, milestoneOwners);
  }

  private static async milestoneOwners(scope: Scope, db: Partial<Pick<DependencyDb, "milestoneOwnerName">>): Promise<string[]> {
    if (!db.milestoneOwnerName) return [];
    try {
      const rows = await db.milestoneOwnerName.findMany({ where: { serviceLineId: scope.id }, select: { name: true } });
      return PeopleDirectory.merge(rows.map((r) => r.name));
    } catch {
      return [];
    }
  }

  private static blockerDto(b: {
    id: string;
    description: string;
    waitingOn: string;
    since: Date;
    followUpOn: Date | null;
    followUpOwner: string | null;
    blockedMilestoneId: string | null;
    resolvedAt: Date | null;
    resolvedBy: string | null;
    resolution: string | null;
  }, steps: ReadonlyMap<string, string>, people: readonly string[] = []): BlockerDto {
    return {
      id: b.id,
      description: b.description,
      waitingOn: b.waitingOn,
      since: DateOnly.fromDbDate(b.since)!,
      followUpOn: DateOnly.fromDbDate(b.followUpOn),
      followUpOwner: b.followUpOwner,
      milestone: b.blockedMilestoneId && steps.has(b.blockedMilestoneId) ? { id: b.blockedMilestoneId, name: steps.get(b.blockedMilestoneId)! } : null,
      resolvedOn: b.resolvedAt ? DateOnly.inZone(b.resolvedAt) : null,
      // The People-list name for the email when one matches (as History shows it), else the name read from the email.
      resolvedBy: b.resolvedBy ? UpdateTimeline.actor(b.resolvedBy, people) : null,
      resolution: b.resolution,
    };
  }

  /**
   * The drawer section. Editors get the full view; `readOnly` (a non-admin who may open the project, checked by the
   * caller) gets the same lists with canEdit false and no picker options. Anyone else gets the generic denial.
   */
  static async view(viewer: Viewer, scope: Scope, projectId: string, db: DependencyDb = Db.client, opts: { readOnly?: boolean; now?: Date } = {}): Promise<DependencyView> {
    const p = await ProjectDependencyService.project(projectId, db);
    if (!p) throw new DependencyAccessError();
    const canEdit = ProjectEditPolicy.canEdit(viewer, scope, p);
    if (!canEdit && !(opts.readOnly && ProjectDependencyService.visible(scope, p))) throw new DependencyAccessError();
    const today = DateOnly.inZone(opts.now ?? new Date());

    const [inEdges, outEdges] = await Promise.all([
      db.projectDependency.findMany({ where: { projectId: p.id, removedAt: null } }),
      db.projectDependency.findMany({ where: { blockedById: p.id, removedAt: null } }),
    ]);
    const projects = (await db.project.findMany({ where: { ...ServiceLineAccess.projectWhere(scope), archivedAt: null }, select: ProjectDependencyService.SELECT })) as ProjectRow[];
    const shown = new Map(projects.filter((x) => ProjectDependencyService.visible(scope, x)).map((x) => [x.id, x]));

    // Milestone names: this project's steps (blocked-by and external rows) and the blocked projects' steps (blocking rows).
    const stepIds = [...inEdges, ...outEdges].map((e) => e.blockedMilestoneId).filter((x): x is string => Boolean(x));
    const blockers = db.projectBlocker ? await db.projectBlocker.findMany({ where: { projectId: p.id }, orderBy: [{ since: "asc" }, { createdAt: "asc" }] }) : [];
    for (const b of blockers) if (b.blockedMilestoneId) stepIds.push(b.blockedMilestoneId);
    const ownSteps = db.projectMilestone
      ? await db.projectMilestone.findMany({ where: { projectId: p.id }, select: { id: true, name: true, done: true, position: true }, orderBy: { position: "asc" } })
      : [];
    const otherSteps = db.projectMilestone && stepIds.length ? await db.projectMilestone.findMany({ where: { id: { in: [...new Set(stepIds)] } }, select: { id: true, name: true } }) : [];
    const steps = new Map<string, string>([...ownSteps, ...otherSteps].map((s) => [s.id, s.name]));

    const row = (e: { createdAt: Date; note?: string | null; blockedMilestoneId?: string | null }, other: ProjectRow): DependencyRowDto => ({
      project: { id: other.id, name: other.name, status: other.status },
      note: e.note ?? null,
      milestone: e.blockedMilestoneId && steps.has(e.blockedMilestoneId) ? { id: e.blockedMilestoneId, name: steps.get(e.blockedMilestoneId)! } : null,
      since: DateOnly.inZone(e.createdAt),
    });
    // Completion prompts (1b): editors only, per-user dismissal (0056) keyed to the dependency's createdAt.
    const dismissed = new Map<string, number>();
    if (canEdit && db.dependencyPromptDismissal && inEdges.length) {
      try {
        for (const d of await db.dependencyPromptDismissal.findMany({ where: { email: viewer.email.trim().toLowerCase(), dependencyId: { in: inEdges.map((e) => e.id) } }, select: { dependencyId: true, dependencyCreatedAt: true } }))
          dismissed.set(d.dependencyId, d.dependencyCreatedAt.getTime());
      } catch {
        // Table not there yet (0056 not applied): every prompt shows, which is harmless.
      }
    }
    const blockedBy = inEdges
      .filter((e) => shown.has(e.blockedById))
      .map((e) => {
        const other = shown.get(e.blockedById)!;
        const r = row(e, other);
        return canEdit && other.status === "Complete" ? { ...r, prompt: dismissed.get(e.id) !== e.createdAt.getTime() } : r;
      });
    const blocking = outEdges.filter((e) => shown.has(e.projectId)).map((e) => row(e, shown.get(e.projectId)!));
    const sort = (a: DependencyRowDto, b: DependencyRowDto) => ProjectDependencyService.byName(a.project, b.project);
    const listed = new Set(inEdges.map((e) => e.blockedById));
    const open = blockers.filter((b) => !b.resolvedAt).map((b) => ProjectDependencyService.blockerDto(b, steps));
    const resolved = blockers
      .filter((b) => b.resolvedAt)
      .sort((a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime())
      .map((b) => ProjectDependencyService.blockerDto(b, steps, ProjectDependencyService.people(scope, [])));
    return {
      canEdit,
      blockedBy: blockedBy.sort(sort),
      blocking: blocking.sort(sort),
      blockers: open,
      resolved,
      options: canEdit ? [...shown.values()].filter((x) => x.id !== p.id && !listed.has(x.id)).map(({ id, name }) => ({ id, name })).sort(ProjectDependencyService.byName) : [],
      milestones: canEdit ? ownSteps.filter((s) => !s.done).map(({ id, name }) => ({ id, name })) : [],
      people: canEdit ? ProjectDependencyService.people(scope, await ProjectDependencyService.milestoneOwners(scope, db)) : [],
      openCount: blockedBy.length + open.length,
      today,
    };
  }

  // ---------------------------------------------------------------- writes (all inside one transaction each)

  private static async lock(tx: Pick<Prisma.TransactionClient, "$executeRaw"> | unknown, scope: Scope): Promise<void> {
    const t = tx as Partial<Pick<Prisma.TransactionClient, "$executeRaw">>;
    if (t.$executeRaw) await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ProjectDependencyService.LOCK_PREFIX + scope.id}))`;
  }

  private static async milestone(tx: Pick<Tx, "projectMilestone">, projectId: string, raw: unknown, requireOpen: boolean, keepId?: string | null): Promise<{ id: string; name: string } | null> {
    const id = BlockerRules.optional(raw);
    if (!id) return null;
    const s = await tx.projectMilestone.findUnique({ where: { id }, select: { id: true, name: true, done: true, projectId: true } });
    if (!s || s.projectId !== projectId) throw new BlockerInputError("badMilestone");
    // A done step can stay on a row that already pointed at it; it can't be picked new.
    if (requireOpen && s.done && s.id !== keepId) throw new BlockerInputError("badMilestone");
    return { id: s.id, name: s.name };
  }

  private static history(tx: Pick<Tx, "projectHistory">, projectId: string, field: string, oldValue: object | null, newValue: object | null, by: string, now: Date, comment: string | null = null) {
    return tx.projectHistory.create({
      data: { projectId, field, oldValue: oldValue ? JSON.stringify(oldValue) : null, newValue: newValue ? JSON.stringify(newValue) : null, changedAt: now, changedBy: by, comment },
    });
  }

  private static depValue(blocker: { id: string; name: string }, note: string | null, milestone: string | null): DependencyHistoryValue {
    return { projectId: blocker.id, name: blocker.name, note, milestone };
  }

  /**
   * Add "projectId is blocked by blockedById" with an optional note and milestone. Rejects self, duplicate (an open
   * row) and cycles against every open edge of the line. A soft-removed row for the same pair is re-used.
   */
  static async addDependency(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, input: DependencyInput = {}, db: WriteDb = Db.client, now: Date = new Date()): Promise<void> {
    await db.$transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      await ProjectDependencyService.lock(raw, scope);
      const p = await ProjectDependencyService.editable(viewer, scope, projectId, tx);
      if (String(blockedById) === p.id) throw new DependencyRuleError("self");
      const b = await ProjectDependencyService.project(blockedById, tx);
      if (!b || !ProjectDependencyService.visible(scope, b)) throw new DependencyAccessError();
      const note = BlockerRules.note(input.note);
      if (!note.ok) throw new BlockerInputError(note.problem);
      const milestone = await ProjectDependencyService.milestone(tx, p.id, input.blockedMilestoneId, true);
      // Every open edge of the line: a chain may pass through projects this viewer can't see.
      const edges = await tx.projectDependency.findMany({ where: { serviceLineId: scope.id, removedAt: null }, select: { projectId: true, blockedById: true } });
      const problem = DependencyGraph.check(edges, p.id, b.id);
      if (problem) throw new DependencyRuleError(problem, ProjectDependencyService.ruleMessage(problem, b.name));
      const existing = await tx.projectDependency.findUnique({ where: { projectId_blockedById: { projectId: p.id, blockedById: b.id } } });
      const data = { note: note.value, blockedMilestoneId: milestone?.id ?? null, removedAt: null, removedBy: null, updatedAt: now, updatedBy: viewer.email };
      if (existing) await tx.projectDependency.update({ where: { id: existing.id }, data: { ...data, createdAt: now, createdBy: viewer.email } });
      else await tx.projectDependency.create({ data: { serviceLineId: scope.id, projectId: p.id, blockedById: b.id, createdAt: now, createdBy: viewer.email, ...data } });
      await ProjectDependencyService.history(tx, p.id, BlockerHistory.DEPENDENCY_ADDED, null, ProjectDependencyService.depValue(b, note.value, milestone?.name ?? null), viewer.email, now);
    });
  }

  /** Change the note or milestone of an open dependency. A no-op change writes nothing. */
  static async updateDependency(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, input: DependencyInput, db: WriteDb = Db.client, now: Date = new Date()): Promise<void> {
    await db.$transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      const p = await ProjectDependencyService.editable(viewer, scope, projectId, tx);
      const e = await tx.projectDependency.findUnique({ where: { projectId_blockedById: { projectId: p.id, blockedById: String(blockedById) } } });
      if (!e || e.removedAt || e.serviceLineId !== scope.id) throw new DependencyAccessError();
      const b = await ProjectDependencyService.project(e.blockedById, tx);
      if (!b) throw new DependencyAccessError();
      const note = BlockerRules.note(input.note);
      if (!note.ok) throw new BlockerInputError(note.problem);
      const milestone = await ProjectDependencyService.milestone(tx, p.id, input.blockedMilestoneId, true, e.blockedMilestoneId);
      if ((e.note ?? null) === note.value && (e.blockedMilestoneId ?? null) === (milestone?.id ?? null)) return;
      const before = e.blockedMilestoneId ? await tx.projectMilestone.findUnique({ where: { id: e.blockedMilestoneId }, select: { name: true } }) : null;
      await tx.projectDependency.update({ where: { id: e.id }, data: { note: note.value, blockedMilestoneId: milestone?.id ?? null, updatedAt: now, updatedBy: viewer.email } });
      await ProjectDependencyService.history(
        tx,
        p.id,
        BlockerHistory.DEPENDENCY_UPDATED,
        ProjectDependencyService.depValue(b, e.note ?? null, before?.name ?? null),
        ProjectDependencyService.depValue(b, note.value, milestone?.name ?? null),
        viewer.email,
        now,
      );
    });
  }

  /** Soft-remove "projectId is blocked by blockedById" (nothing open to remove is fine). */
  static async removeDependency(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, db: WriteDb = Db.client, now: Date = new Date(), comment: string | null = null): Promise<void> {
    await db.$transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      const p = await ProjectDependencyService.editable(viewer, scope, projectId, tx);
      const e = await tx.projectDependency.findUnique({ where: { projectId_blockedById: { projectId: p.id, blockedById: String(blockedById) } } });
      if (!e || e.removedAt || e.serviceLineId !== scope.id) return;
      const b = await ProjectDependencyService.project(e.blockedById, tx);
      const step = e.blockedMilestoneId ? await tx.projectMilestone.findUnique({ where: { id: e.blockedMilestoneId }, select: { name: true } }) : null;
      await tx.projectDependency.update({ where: { id: e.id }, data: { removedAt: now, removedBy: viewer.email, updatedAt: now, updatedBy: viewer.email } });
      await ProjectDependencyService.history(tx, p.id, BlockerHistory.DEPENDENCY_REMOVED, ProjectDependencyService.depValue({ id: e.blockedById, name: b?.name ?? "" }, e.note ?? null, step?.name ?? null), null, viewer.email, now, comment);
    });
  }

  /** Validated external blocker fields. */
  private static async blockerFields(tx: Pick<Tx, "projectMilestone" | "milestoneOwnerName">, scope: Scope, projectId: string, input: BlockerInput, keepMilestoneId?: string | null) {
    const description = BlockerRules.required(input.description, BlockerRules.DESCRIPTION_MAX, "descriptionRequired", "descriptionTooLong");
    if (!description.ok) throw new BlockerInputError(description.problem);
    const waitingOn = BlockerRules.required(input.waitingOn, BlockerRules.WAITING_ON_MAX, "waitingOnRequired", "waitingOnTooLong");
    if (!waitingOn.ok) throw new BlockerInputError(waitingOn.problem);
    const followUpOn = BlockerRules.date(input.followUpOn);
    if (!followUpOn.ok) throw new BlockerInputError(followUpOn.problem);
    const ownerRaw = BlockerRules.optional(input.followUpOwner);
    let followUpOwner: string | null = null;
    if (ownerRaw) {
      const found = PeopleDirectory.find(ProjectDependencyService.people(scope, await ProjectDependencyService.milestoneOwners(scope, tx)), ownerRaw);
      if (!found) throw new BlockerInputError("unknownOwner");
      followUpOwner = found;
    }
    const milestone = await ProjectDependencyService.milestone(tx, projectId, input.blockedMilestoneId, true, keepMilestoneId);
    return { description: description.value, waitingOn: waitingOn.value, followUpOn: followUpOn.value, followUpOwner, milestone };
  }

  private static blockerValue(id: string, f: { description: string; waitingOn: string; followUpOn: string | null; followUpOwner: string | null; milestone: string | null }): BlockerHistoryValue {
    return { id, description: f.description, waitingOn: f.waitingOn, followUpOn: f.followUpOn, followUpOwner: f.followUpOwner, milestone: f.milestone };
  }

  /** Add an external blocker; "since" is today (America/New_York). Returns its id. */
  static async addBlocker(viewer: Viewer, scope: Scope, projectId: string, input: BlockerInput, db: WriteDb = Db.client, now: Date = new Date()): Promise<string> {
    return db.$transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      const p = await ProjectDependencyService.editable(viewer, scope, projectId, tx);
      const f = await ProjectDependencyService.blockerFields(tx, scope, p.id, input);
      const created = await tx.projectBlocker.create({
        data: {
          serviceLineId: scope.id,
          projectId: p.id,
          description: f.description,
          waitingOn: f.waitingOn,
          since: DateOnly.toDbDate(DateOnly.inZone(now)),
          followUpOn: f.followUpOn ? DateOnly.toDbDate(f.followUpOn) : null,
          followUpOwner: f.followUpOwner,
          blockedMilestoneId: f.milestone?.id ?? null,
          createdAt: now,
          createdBy: viewer.email,
        },
        select: { id: true },
      });
      await ProjectDependencyService.history(tx, p.id, BlockerHistory.BLOCKER_ADDED, null, ProjectDependencyService.blockerValue(created.id, { ...f, milestone: f.milestone?.name ?? null }), viewer.email, now);
      return created.id;
    });
  }

  private static async openBlocker(tx: Pick<Tx, "projectBlocker">, scope: Scope, projectId: string, blockerId: string) {
    const b = await tx.projectBlocker.findUnique({ where: { id: String(blockerId) } });
    if (!b || b.projectId !== projectId || b.serviceLineId !== scope.id) throw new BlockerInputError("notFound");
    if (b.resolvedAt) throw new BlockerInputError("alreadyResolved");
    return b;
  }

  /** Edit an open external blocker ("since" never changes). A no-op change writes nothing. */
  static async updateBlocker(viewer: Viewer, scope: Scope, projectId: string, blockerId: string, input: BlockerInput, db: WriteDb = Db.client, now: Date = new Date()): Promise<void> {
    await db.$transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      const p = await ProjectDependencyService.editable(viewer, scope, projectId, tx);
      const b = await ProjectDependencyService.openBlocker(tx, scope, p.id, blockerId);
      const f = await ProjectDependencyService.blockerFields(tx, scope, p.id, input, b.blockedMilestoneId);
      const before = {
        description: b.description,
        waitingOn: b.waitingOn,
        followUpOn: DateOnly.fromDbDate(b.followUpOn),
        followUpOwner: b.followUpOwner,
        milestoneId: b.blockedMilestoneId,
      };
      if (
        before.description === f.description &&
        before.waitingOn === f.waitingOn &&
        before.followUpOn === f.followUpOn &&
        before.followUpOwner === f.followUpOwner &&
        before.milestoneId === (f.milestone?.id ?? null)
      )
        return;
      const oldStep = b.blockedMilestoneId ? await tx.projectMilestone.findUnique({ where: { id: b.blockedMilestoneId }, select: { name: true } }) : null;
      await tx.projectBlocker.update({
        where: { id: b.id },
        data: {
          description: f.description,
          waitingOn: f.waitingOn,
          followUpOn: f.followUpOn ? DateOnly.toDbDate(f.followUpOn) : null,
          followUpOwner: f.followUpOwner,
          blockedMilestoneId: f.milestone?.id ?? null,
          updatedAt: now,
          updatedBy: viewer.email,
        },
      });
      await ProjectDependencyService.history(
        tx,
        p.id,
        BlockerHistory.BLOCKER_UPDATED,
        ProjectDependencyService.blockerValue(b.id, { ...before, milestone: oldStep?.name ?? null }),
        ProjectDependencyService.blockerValue(b.id, { ...f, milestone: f.milestone?.name ?? null }),
        viewer.email,
        now,
      );
    });
  }

  /** Resolve an open external blocker with the required "What resolved it?" text. The row is kept. */
  static async resolveBlocker(viewer: Viewer, scope: Scope, projectId: string, blockerId: string, resolution: unknown, db: WriteDb = Db.client, now: Date = new Date()): Promise<void> {
    await db.$transaction(async (raw) => {
      const tx = raw as unknown as Tx;
      const p = await ProjectDependencyService.editable(viewer, scope, projectId, tx);
      const r = BlockerRules.required(resolution, BlockerRules.RESOLUTION_MAX, "resolutionRequired", "resolutionTooLong");
      if (!r.ok) throw new BlockerInputError(r.problem);
      const b = await ProjectDependencyService.openBlocker(tx, scope, p.id, blockerId);
      const step = b.blockedMilestoneId ? await tx.projectMilestone.findUnique({ where: { id: b.blockedMilestoneId }, select: { name: true } }) : null;
      await tx.projectBlocker.update({ where: { id: b.id }, data: { resolvedAt: now, resolvedBy: viewer.email, resolution: r.value, updatedAt: now, updatedBy: viewer.email } });
      const value = ProjectDependencyService.blockerValue(b.id, {
        description: b.description,
        waitingOn: b.waitingOn,
        followUpOn: DateOnly.fromDbDate(b.followUpOn),
        followUpOwner: b.followUpOwner,
        milestone: step?.name ?? null,
      });
      await ProjectDependencyService.history(tx, p.id, BlockerHistory.BLOCKER_RESOLVED, value, { ...value, resolution: r.value }, viewer.email, now);
    });
  }

  /**
   * Completion banner "Clear" (1b): soft-remove a dependency whose blocker is Complete, with the CLEARED_ON_COMPLETE
   * comment on its history row. Refused (generic) when the blocker is not Complete.
   */
  static async clearCompleted(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, db: WriteDb & Pick<DependencyDb, "project"> = Db.client, now: Date = new Date()): Promise<void> {
    const b = await ProjectDependencyService.project(blockedById, db);
    if (!b || b.status !== "Complete") throw new DependencyAccessError();
    await ProjectDependencyService.removeDependency(viewer, scope, projectId, blockedById, db, now, BlockerHistory.CLEARED_ON_COMPLETE);
  }

  /** Completion banner "Dismiss" (1b): stays dismissed for this person until the pair is re-added. No history row. */
  static async dismissPrompt(viewer: Viewer, scope: Scope, projectId: string, blockedById: string, db: Pick<PrismaClient, "project" | "projectDependency" | "dependencyPromptDismissal"> = Db.client, now: Date = new Date()): Promise<void> {
    const p = await ProjectDependencyService.editable(viewer, scope, projectId, db);
    const e = await db.projectDependency.findUnique({ where: { projectId_blockedById: { projectId: p.id, blockedById: String(blockedById) } } });
    if (!e || e.removedAt || e.serviceLineId !== scope.id) throw new DependencyAccessError();
    const email = viewer.email.trim().toLowerCase();
    await db.dependencyPromptDismissal.upsert({
      where: { dependencyId_email: { dependencyId: e.id, email } },
      create: { dependencyId: e.id, email, dependencyCreatedAt: e.createdAt, dismissedAt: now },
      update: { dependencyCreatedAt: e.createdAt, dismissedAt: now },
    });
  }

  /** The drawer's plain wording for a rejected edge (DependencyCopy.rule). */
  static ruleMessage(problem: DependencyProblem, blockerName: string): string {
    return DependencyCopy.rule(problem, blockerName);
  }
}

/** One row of Admin > Dependencies review (read only). */
export interface DependencyReviewRow {
  id: string;
  project: string;
  blockedBy: string;
  createdAt: Date;
  createdBy: string;
}

/**
 * Read-only list of the active line's `project_dependencies` rows, so an admin can review rows the drawer's old
 * AI "Find related" Link saved as Blocked by. Rows from that bug look like any other row (same createdBy), so nothing
 * is flagged or removed here. Only rows whose two projects are inside the viewer's department access are listed.
 */
export class DependencyReviewService {
  static async list(viewer: Viewer, scope: Scope, db: DependencyDb = Db.client): Promise<DependencyReviewRow[]> {
    if (!viewer.isAdmin) return [];
    // Open rows only: a removed (soft-deleted, 1a) dependency is no longer a Blocked-by row.
    const rows = await db.projectDependency.findMany({
      where: { serviceLineId: scope.id, removedAt: null },
      select: {
        id: true,
        createdAt: true,
        createdBy: true,
        project: { select: { name: true, departmentId: true } },
        blockedBy: { select: { name: true, departmentId: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
    return rows
      .filter((r) => DepartmentAccess.allows(scope, r.project.departmentId) && DepartmentAccess.allows(scope, r.blockedBy.departmentId))
      .map((r) => ({ id: r.id, project: r.project.name, blockedBy: r.blockedBy.name, createdAt: r.createdAt, createdBy: r.createdBy }));
  }
}
