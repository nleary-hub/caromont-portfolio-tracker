import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { Prisma, ProjectMilestone } from "@/generated/prisma/client";
import { DateOnly } from "@/lib/domain/DateOnly";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { StepCheckedBy } from "@/lib/projects/StepCheckedBy";
import { MilestoneRules, MilestoneValidationError, type MilestoneDraft, type MilestonePlan, type TemplateApplied } from "@/lib/domain/MilestoneRules";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

type StepReader = Pick<Prisma.TransactionClient, "projectMilestone">;
type Tx = Prisma.TransactionClient;

export interface Actor {
  changedBy: string;
  comment?: string | null;
}

/** A step as sent to the drawer (dates as "YYYY-MM-DD"). */
export interface MilestoneStepDto {
  id: string;
  name: string;
  dueDate: string | null;
  done: boolean;
  doneAt: string | null;
  /** Who checked it: a People list name, the name read from the email, or "Tracker"; null when not recorded. */
  checkedBy: string | null;
  /** ISO time it was checked; null when not recorded. */
  checkedAt: string | null;
  position: number;
  sourceTemplateId: string | null;
  /** Owner (migration 0029): a name from the line's Owners list, or null (Unassigned). */
  owner: string | null;
}

export interface MilestoneSaveResult {
  changed: boolean;
  /** Legacy column values matching the checklist after the save (MilestoneProgress.mirror). */
  mirror: { nextMilestone: string | null; dueDate: Date | null };
  plan: MilestonePlan;
  /** Steps before the save (done state and check day), for the completion rules (CompletionRules). */
  before: { done: boolean; doneAt: string | null }[];
  /** The save deleted the last milestone and "Project complete" was added back (ProjectService.addBackDefaultMilestone). */
  defaultAdded?: "open" | "done";
}

/**
 * The only read/write path for project_milestones. Writes happen inside the caller's transaction
 * (ProjectService), with one ProjectHistory row per action at the save's timestamp.
 */
export class MilestoneService {
  /** Prisma "table does not exist": migration 0015 not applied yet (e.g. a preview on an older database). */
  static readonly MISSING_TABLE = "P2021";
  /** Draft id the drawer uses for a legacy next milestone shown as step 1 before any step is stored. */
  static readonly LEGACY_STEP_ID = "legacy";

  /**
   * Steps for these projects, ordered. Outside a transaction a missing table (migration 0015 not applied)
   * reads as "no steps", so every project falls back to its legacy fields and renders exactly as before.
   */
  static async loadSteps(db: StepReader, projectIds: readonly string[]): Promise<ProjectMilestone[]> {
    if (projectIds.length === 0) return [];
    try {
      const rows = await db.projectMilestone.findMany({ where: { projectId: { in: [...projectIds] } } });
      return [...rows].sort((a, b) => a.projectId.localeCompare(b.projectId) || a.position - b.position);
    } catch (e) {
      if ((e as { code?: string })?.code === MilestoneService.MISSING_TABLE) {
        console.error("project_milestones is missing (migration 0015 not applied); using legacy milestone fields");
        return [];
      }
      throw e;
    }
  }

  static async stepsFor(db: StepReader, projectId: string): Promise<ProjectMilestone[]> {
    return MilestoneService.loadSteps(db, [projectId]);
  }

  /** `people`: the line's People list names, for the checker's display name (same rule as History). */
  static toDto(s: ProjectMilestone, people: readonly string[] = []): MilestoneStepDto {
    const checked = StepCheckedBy.recorded(s);
    return {
      id: s.id,
      name: s.name,
      dueDate: DateOnly.fromDbDate(s.dueDate),
      done: s.done,
      doneAt: DateOnly.fromDbDate(s.doneAt),
      checkedBy: checked?.by ? UpdateTimeline.actor(checked.by, people) : null,
      checkedAt: checked ? checked.at.toISOString() : null,
      position: s.position,
      sourceTemplateId: s.sourceTemplateId,
      owner: s.owner ?? null,
    };
  }

  /** Steps grouped by project, as DTOs (for the admin drawer). */
  static byProject(steps: readonly ProjectMilestone[], people: readonly string[] = []): Record<string, MilestoneStepDto[]> {
    const out: Record<string, MilestoneStepDto[]> = {};
    for (const s of MilestoneProgress.ordered(steps)) (out[s.projectId] ??= []).push(MilestoneService.toDto(s, people));
    return out;
  }

  /**
   * Apply the drawer's checklist to the project inside `tx`: creates, updates, deletes, and one history
   * row per action (all at `at`). Template ids that no longer exist (or belong to another service line) are stored as null. No-op without changes.
   */
  static async saveInTx(
    tx: Tx,
    projectId: string,
    drafts: readonly MilestoneDraft[],
    actor: Actor,
    at: Date,
    applied: TemplateApplied | null = null,
    scope: Pick<ServiceLineScope, "id"> & Partial<Pick<ServiceLineScope, "owners">> = ServiceLine.defaultScope(),
  ): Promise<MilestoneSaveResult> {
    let stored = await MilestoneService.stepsFor(tx, projectId);
    // A project without steps but with a legacy next milestone (e.g. created by CSV after 0015): the drawer
    // shows that text as step 1 with LEGACY_STEP_ID. Materialize it exactly as the migration backfill does
    // (same text and due date, not done, no history row: nothing changed), so it keeps its grandfathered length.
    if (stored.length === 0 && drafts.some((d) => d.id === MilestoneService.LEGACY_STEP_ID)) {
      const project = await tx.project.findUnique({ where: { id: projectId }, select: { nextMilestone: true, dueDate: true } });
      const text = project?.nextMilestone ?? "";
      if (text.trim()) {
        const row = await tx.projectMilestone.create({
          data: { projectId, name: text, dueDate: project?.dueDate ?? null, done: false, doneAt: null, position: 1, sourceTemplateId: null },
        });
        stored = [row];
        drafts = drafts.map((d) => (d.id === MilestoneService.LEGACY_STEP_ID ? { ...d, id: row.id } : d));
      }
    }
    drafts = drafts.map((d) => (d.id === MilestoneService.LEGACY_STEP_ID ? { ...d, id: null } : d));
    const templateIds = [...new Set(drafts.filter((d) => !d.id && d.sourceTemplateId).map((d) => d.sourceTemplateId as string))];
    const known = templateIds.length
      ? new Set((await tx.milestoneTemplate.findMany({ where: { id: { in: templateIds }, ...ServiceLineAccess.where(scope) }, select: { id: true } })).map((t) => t.id))
      : new Set<string>();
    const checked = drafts.map((d) => (d.sourceTemplateId && !d.id && !known.has(d.sourceTemplateId) ? { ...d, sourceTemplateId: null } : d));
    const owned = MilestoneService.checkOwners(stored, checked, scope.owners ?? []);
    const plan = MilestoneRules.plan(stored, owned, DateOnly.inZone(at), applied, { by: actor.changedBy, at });
    const mirror = MilestoneProgress.mirror(plan.result);
    const before = stored.map((st) => ({ done: st.done, doneAt: DateOnly.fromDbDate(st.doneAt) }));
    if (!MilestoneRules.hasChanges(plan)) return { changed: false, mirror, plan, before };

    for (const id of plan.deletes) await tx.projectMilestone.delete({ where: { id } });
    for (const u of plan.updates) await tx.projectMilestone.update({ where: { id: u.id }, data: u.data });
    for (const c of plan.creates) await tx.projectMilestone.create({ data: { ...c, projectId } });
    if (plan.history.length) {
      await tx.projectHistory.createMany({
        data: plan.history.map((h) => ({
          projectId,
          field: h.field,
          oldValue: h.oldValue,
          newValue: h.newValue,
          changedAt: at,
          changedBy: actor.changedBy,
          comment: actor.comment ?? null,
        })),
      });
    }
    return { changed: true, mirror, plan, before };
  }

  /** "Step 2: Pick an owner from the People list" when a step's new owner is not on the line's Owners list. */
  static readonly OWNER_NOT_LISTED = "Pick an owner from the People list";

  /**
   * Milestone owners come from the line's Owners list (Admin > People), list spelling. A step keeping its stored owner
   * is fine even when that name has since left the list (it still shows); a new pick must be on the list, and blocked
   * names (former staff) are never accepted. Throws MilestoneValidationError.
   */
  static checkOwners(stored: readonly ProjectMilestone[], drafts: readonly MilestoneDraft[], owners: readonly string[]): MilestoneDraft[] {
    const byId = new Map(stored.map((s) => [s.id, s]));
    const list = PeopleDirectory.merge(owners);
    const errors: string[] = [];
    const out = drafts.map((d, i) => {
      if (d.owner === undefined || d.owner === null) return d;
      const kept = d.id ? byId.get(d.id)?.owner ?? null : null;
      if (kept !== null && kept === d.owner) return d;
      const listed = PeopleDirectory.find(list, d.owner);
      if (!listed || PeopleDirectory.isBlocked(listed)) {
        errors.push(`Step ${i + 1}: ${MilestoneService.OWNER_NOT_LISTED}`);
        return d;
      }
      return { ...d, owner: listed };
    });
    if (errors.length) throw new MilestoneValidationError(errors);
    return out;
  }

  /**
   * A legacy-field edit from outside the drawer (CSV wording update, "Milestone met") on a project that
   * has steps: rename and re-date the current next step, or add a step when every step is done, so the
   * checklist keeps matching what was written. The field-level history rows already record the change.
   */
  static async syncLegacyEditInTx(
    tx: Tx,
    projectId: string,
    legacy: { nextMilestone: string | null; dueDate: Date | null },
  ): Promise<void> {
    const steps = await MilestoneService.stepsFor(tx, projectId);
    if (steps.length === 0 || !legacy.nextMilestone) return;
    const next = MilestoneProgress.next(steps);
    if (next) {
      await tx.projectMilestone.update({ where: { id: next.id }, data: { name: legacy.nextMilestone, dueDate: legacy.dueDate } });
      return;
    }
    const position = Math.max(...steps.map((s) => s.position)) + 1;
    await tx.projectMilestone.create({
      data: { projectId, name: legacy.nextMilestone, dueDate: legacy.dueDate, done: false, doneAt: null, position, sourceTemplateId: null },
    });
  }
}
