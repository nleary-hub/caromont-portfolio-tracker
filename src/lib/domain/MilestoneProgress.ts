import { DateOnly } from "@/lib/domain/DateOnly";

/** The step fields the derivation reads (a DB row, a draft in the drawer, or a test literal). */
export interface MilestoneStepLike {
  name: string;
  /** DB DATE (UTC midnight) or "YYYY-MM-DD". */
  dueDate: Date | string | null;
  done: boolean;
  position: number;
  /** Step owner (migration 0029); null or absent = Unassigned. */
  owner?: string | null;
}

/** Done and total steps of a checklist. */
export interface MilestoneCount {
  done: number;
  total: number;
}

/** What the dashboard, the PDF, the flags and the CSV export show for a project's milestone. */
export interface DerivedMilestone {
  /** Next milestone text: the first step not done; the last step when all are done; the legacy text with no steps. */
  nextMilestone: string | null;
  /** "YYYY-MM-DD" driving Due and Overdue: the next step's due date; null when all steps are done. */
  dueDate: string | null;
  /** Null with no steps (legacy fields in use). */
  count: MilestoneCount | null;
  allDone: boolean;
  source: "steps" | "legacy";
  /** The next open step's owner; null when Unassigned, all done, or no steps. */
  owner: string | null;
}

/** Legacy fields as stored on the project (Project.nextMilestone and Project.dueDate). */
export interface LegacyMilestone {
  nextMilestone: string | null;
  dueDate: Date | string | null;
}

/**
 * THE derivation of a project's next milestone from its checklist (migration 0015). Every reader goes
 * through here: the dashboard and the report (via applyAll in their loaders), so Due, Overdue, Changed,
 * "Completed this period", the PDF, handoff.json and the CSV export all see the same values.
 *
 * Rules:
 * - Next milestone = the first step that is not done, by position. Its due date drives Due and Overdue.
 * - No steps: the legacy fields, exactly as before the checklist existed.
 * - All steps done: no due date, so Overdue never fires on a finished checklist. The dashboard and PDF
 *   line reads "All milestones done" (teal) followed by "· Y of Y" (2+ steps). The data value (CSV
 *   export, legacy mirror) stays the last step's name.
 * - Progress "X of Y" shows only with 2 or more steps, so a migrated single-step project looks exactly
 *   as it did.
 */
export class MilestoneProgress {
  /** Shown on the dashboard and PDF milestone line once every step is done. */
  static readonly ALL_DONE_TEXT = "All milestones done";

  /** Every step done (a checklist with at least one step). */
  static allDone(count: MilestoneCount | null | undefined): boolean {
    return !!count && count.total > 0 && count.done === count.total;
  }

  static ordered<T extends MilestoneStepLike>(steps: readonly T[]): T[] {
    return steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.position - b.s.position || a.i - b.i).map((x) => x.s);
  }

  /** First step not done, by position (null when there is none). */
  static next<T extends MilestoneStepLike>(steps: readonly T[]): T | null {
    return MilestoneProgress.ordered(steps).find((s) => !s.done) ?? null;
  }

  static count(steps: readonly MilestoneStepLike[]): MilestoneCount | null {
    return steps.length ? { done: steps.filter((s) => s.done).length, total: steps.length } : null;
  }

  static derive(steps: readonly MilestoneStepLike[], legacy: LegacyMilestone): DerivedMilestone {
    if (steps.length === 0) {
      return { nextMilestone: legacy.nextMilestone, dueDate: MilestoneProgress.iso(legacy.dueDate), count: null, allDone: false, source: "legacy", owner: null };
    }
    const ordered = MilestoneProgress.ordered(steps);
    const next = ordered.find((s) => !s.done) ?? null;
    const count = MilestoneProgress.count(ordered);
    if (next) return { nextMilestone: next.name, dueDate: MilestoneProgress.iso(next.dueDate), count, allDone: false, source: "steps", owner: next.owner?.trim() ? next.owner.trim() : null };
    return { nextMilestone: ordered[ordered.length - 1].name, dueDate: null, count, allDone: true, source: "steps", owner: null };
  }

  /** "2 of 6", or null when the label is not shown (see the class rules). */
  static progressLabel(count: MilestoneCount | null | undefined): string | null {
    if (!count || count.total < 2) return null;
    return `${count.done} of ${count.total}`;
  }

  /**
   * The project with its derived next milestone and due date in place of the legacy fields, plus the
   * step count. Everything downstream (ReportBuilder, DashboardViewModel, CSV export) reads these.
   */
  static applyTo<P extends LegacyMilestone & { dueDate: Date | null }>(
    project: P,
    steps: readonly MilestoneStepLike[],
  ): P & { milestoneProgress: MilestoneCount | null } {
    if (steps.length === 0) return { ...project, milestoneProgress: null };
    const d = MilestoneProgress.derive(steps, project);
    // The next step's owner only when set, so projects without owners carry exactly the fields they had before.
    return {
      ...project,
      nextMilestone: d.nextMilestone,
      dueDate: d.dueDate ? DateOnly.toDbDate(d.dueDate) : null,
      milestoneProgress: d.count,
      ...(d.owner ? { nextMilestoneOwner: d.owner } : {}),
    };
  }

  /** applyTo for many projects; `steps` rows carry their projectId. */
  static applyAll<P extends LegacyMilestone & { id: string; dueDate: Date | null }>(
    projects: readonly P[],
    steps: readonly (MilestoneStepLike & { projectId: string })[],
  ): (P & { milestoneProgress: MilestoneCount | null })[] {
    const byProject = new Map<string, (MilestoneStepLike & { projectId: string })[]>();
    for (const s of steps) {
      const list = byProject.get(s.projectId);
      if (list) list.push(s);
      else byProject.set(s.projectId, [s]);
    }
    return projects.map((p) => MilestoneProgress.applyTo(p, byProject.get(p.id) ?? []));
  }

  /**
   * Values written to the legacy columns after a checklist edit, so they always match what the app shows
   * and a rollback of migration 0015 loses nothing. An emptied checklist clears them.
   */
  static mirror(steps: readonly MilestoneStepLike[]): { nextMilestone: string | null; dueDate: Date | null } {
    if (steps.length === 0) return { nextMilestone: null, dueDate: null };
    const d = MilestoneProgress.derive(steps, { nextMilestone: null, dueDate: null });
    return { nextMilestone: d.nextMilestone, dueDate: d.dueDate ? DateOnly.toDbDate(d.dueDate) : null };
  }

  private static iso(value: Date | string | null): string | null {
    if (value === null) return null;
    return value instanceof Date ? DateOnly.fromDbDate(value) : value || null;
  }
}
