import { DateOnly } from "@/lib/domain/DateOnly";

/** A step as the drawer sends it on Save (array order = position). */
export interface MilestoneDraft {
  /** Stored step id, or null for a step added in this edit. */
  id: string | null;
  name: string;
  /** "YYYY-MM-DD" or "". */
  dueDate: string;
  done: boolean;
  /** Template the step was copied from (null for a hand-added step). */
  sourceTemplateId: string | null;
}

/** A stored step (ProjectMilestone row fields the plan needs). */
export interface StoredStep {
  id: string;
  name: string;
  dueDate: Date | null;
  done: boolean;
  doneAt: Date | null;
  position: number;
  sourceTemplateId: string | null;
}

/** "Apply template" in this edit, for the history row. */
export interface TemplateApplied {
  templateId: string;
  templateName: string;
  mode: "replace" | "append";
}

/** The drawer's checklist on Save: the full list in order, and the template applied in this edit, if any. */
export interface MilestoneEdit {
  drafts: MilestoneDraft[];
  applied?: TemplateApplied | null;
}

export interface StepWrite {
  name: string;
  dueDate: Date | null;
  done: boolean;
  doneAt: Date | null;
  position: number;
  sourceTemplateId: string | null;
}

export interface HistoryChange {
  field: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface MilestonePlan {
  creates: StepWrite[];
  updates: { id: string; data: Partial<StepWrite> }[];
  deletes: string[];
  /** One row per action, all written with the save's timestamp (one history group). */
  history: HistoryChange[];
  /** Steps after the save, in order (for the derived next milestone and the legacy mirror). */
  result: StepWrite[];
}

export class MilestoneValidationError extends Error {
  constructor(readonly messages: string[]) {
    super(messages.join(" "));
    this.name = "MilestoneValidationError";
  }
}

/**
 * Pure rules for editing a checklist: validation (40-character cap on new and renamed steps; migrated
 * legacy text is accepted until it is edited) and the plan of writes plus one history row per action.
 */
export class MilestoneRules {
  /** Hard cap for a new or renamed step, and for every template step. */
  static readonly NAME_MAX = 40;
  /** Template names. */
  static readonly TEMPLATE_NAME_MAX = 60;
  /** Steps per project or template. */
  static readonly MAX_STEPS = 40;

  /** History fields (ProjectHistory.field) for checklist actions. Public: they set the Changed flag. */
  static readonly FIELDS = {
    added: "milestone_added",
    renamed: "milestone_renamed",
    due: "milestone_due",
    done: "milestone_done",
    reopened: "milestone_reopened",
    deleted: "milestone_deleted",
    reordered: "milestones_reordered",
    templateApplied: "milestone_template_applied",
  } as const;

  static readonly FIELD_LABELS: Readonly<Record<string, string>> = {
    milestone_added: "Milestone added",
    milestone_renamed: "Milestone renamed",
    milestone_due: "Milestone due date",
    milestone_done: "Milestone done",
    milestone_reopened: "Milestone reopened",
    milestone_deleted: "Milestone deleted",
    milestones_reordered: "Milestones reordered",
    milestone_template_applied: "Template applied",
  };

  /** Collapse whitespace and trim. */
  static clean(name: unknown): string {
    return typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  }

  /** Error for a new or renamed step name, or null when it is fine. */
  static nameError(name: string, max: number = MilestoneRules.NAME_MAX): string | null {
    const n = MilestoneRules.clean(name);
    if (!n) return "Name is required";
    if (n.length > max) return `At most ${max} characters`;
    return null;
  }

  /** Normalize whatever the client sent into drafts (unknown keys dropped, types coerced). */
  static drafts(raw: unknown): MilestoneDraft[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => {
      const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return {
        id: typeof o.id === "string" && o.id ? o.id : null,
        name: typeof o.name === "string" ? o.name : "",
        dueDate: typeof o.dueDate === "string" ? o.dueDate.trim() : "",
        done: o.done === true,
        sourceTemplateId: typeof o.sourceTemplateId === "string" && o.sourceTemplateId ? o.sourceTemplateId : null,
      };
    });
  }

  static describe(name: string, dueDate: Date | string | null): string {
    const due = dueDate instanceof Date ? DateOnly.fromDbDate(dueDate) : dueDate || null;
    return due ? `${name} (due ${due})` : name;
  }

  /**
   * Plan the writes for a Save. `today` is the America/New_York date used for doneAt. Throws
   * MilestoneValidationError with one message per bad step ("Step 3: At most 40 characters").
   */
  static plan(stored: readonly StoredStep[], drafts: readonly MilestoneDraft[], today: string, applied: TemplateApplied | null = null): MilestonePlan {
    const F = MilestoneRules.FIELDS;
    const byId = new Map(stored.map((s) => [s.id, s]));
    const errors: string[] = [];
    if (drafts.length > MilestoneRules.MAX_STEPS) errors.push(`At most ${MilestoneRules.MAX_STEPS} milestones`);
    const seen = new Set<string>();
    drafts.forEach((d, i) => {
      const existing = d.id ? byId.get(d.id) : undefined;
      const name = MilestoneRules.clean(d.name);
      const edited = !existing || name !== MilestoneRules.clean(existing.name);
      const err = edited ? MilestoneRules.nameError(name) : name ? null : "Name is required";
      if (err) errors.push(`Step ${i + 1}: ${err}`);
      if (d.dueDate && !DateOnly.isIso(d.dueDate)) errors.push(`Step ${i + 1}: Enter a valid due date`);
      if (d.id && seen.has(d.id)) errors.push(`Step ${i + 1}: Duplicate step`);
      if (d.id) seen.add(d.id);
    });
    if (errors.length) throw new MilestoneValidationError(errors);

    const todayDate = DateOnly.toDbDate(today);
    const plan: MilestonePlan = { creates: [], updates: [], deletes: [], history: [], result: [] };
    const kept = new Set<string>();
    let templateSteps = 0;

    drafts.forEach((d, i) => {
      const position = i + 1;
      const name = MilestoneRules.clean(d.name);
      const dueDate = d.dueDate ? DateOnly.toDbDate(d.dueDate) : null;
      const existing = d.id ? byId.get(d.id) : undefined;
      if (!existing) {
        const write: StepWrite = { name, dueDate, done: d.done, doneAt: d.done ? todayDate : null, position, sourceTemplateId: d.sourceTemplateId };
        plan.creates.push(write);
        plan.result.push(write);
        if (applied && d.sourceTemplateId === applied.templateId) templateSteps += 1;
        else plan.history.push({ field: F.added, oldValue: null, newValue: MilestoneRules.describe(name, dueDate) });
        if (d.done) plan.history.push({ field: F.done, oldValue: null, newValue: name });
        return;
      }
      kept.add(existing.id);
      const data: Partial<StepWrite> = {};
      if (name !== existing.name && name !== MilestoneRules.clean(existing.name)) {
        data.name = name;
        plan.history.push({ field: F.renamed, oldValue: existing.name, newValue: name });
      }
      const oldDue = DateOnly.fromDbDate(existing.dueDate);
      const newDue = d.dueDate || null;
      if (oldDue !== newDue) {
        data.dueDate = dueDate;
        plan.history.push({ field: F.due, oldValue: MilestoneRules.dueLabel(name, oldDue), newValue: MilestoneRules.dueLabel(name, newDue) });
      }
      if (d.done !== existing.done) {
        data.done = d.done;
        data.doneAt = d.done ? todayDate : null;
        plan.history.push(d.done ? { field: F.done, oldValue: null, newValue: name } : { field: F.reopened, oldValue: name, newValue: null });
      }
      if (position !== existing.position) data.position = position;
      if (Object.keys(data).length) plan.updates.push({ id: existing.id, data });
      plan.result.push({
        name: data.name ?? existing.name,
        dueDate: "dueDate" in data ? (data.dueDate ?? null) : existing.dueDate,
        done: data.done ?? existing.done,
        doneAt: "doneAt" in data ? (data.doneAt ?? null) : existing.doneAt,
        position,
        sourceTemplateId: existing.sourceTemplateId,
      });
    });

    const ordered = [...stored].sort((a, b) => a.position - b.position);
    for (const s of ordered) {
      if (kept.has(s.id)) continue;
      plan.deletes.push(s.id);
      plan.history.push({ field: F.deleted, oldValue: MilestoneRules.describe(s.name, s.dueDate), newValue: null });
    }

    // Reordered: the kept steps are in a different relative order than before.
    const before = ordered.filter((s) => kept.has(s.id)).map((s) => s.id);
    const after = drafts.filter((d) => d.id && kept.has(d.id)).map((d) => d.id as string);
    if (before.join("|") !== after.join("|")) {
      const nameOf = (id: string) => byId.get(id)!.name;
      plan.history.push({ field: F.reordered, oldValue: JSON.stringify(before.map(nameOf)), newValue: JSON.stringify(after.map(nameOf)) });
    }

    if (applied && templateSteps > 0) {
      const mode = applied.mode === "replace" ? "Replace" : "Add to end";
      plan.history.unshift({ field: F.templateApplied, oldValue: null, newValue: `${applied.templateName} (${mode}, ${templateSteps} ${templateSteps === 1 ? "step" : "steps"})` });
    }
    return plan;
  }

  private static dueLabel(name: string, due: string | null): string | null {
    return due ? `${name}: ${due}` : null;
  }

  static hasChanges(plan: MilestonePlan): boolean {
    return plan.creates.length > 0 || plan.updates.length > 0 || plan.deletes.length > 0;
  }
}
