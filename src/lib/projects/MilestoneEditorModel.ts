import { LongTextCounter } from "@/lib/projects/LongTextCounter";
import { MilestoneProgress, type MilestoneCount } from "@/lib/domain/MilestoneProgress";
import { MilestoneRules, type MilestoneDraft, type MilestoneEdit, type TemplateApplied } from "@/lib/domain/MilestoneRules";
import type { MilestoneStepDto } from "@/lib/services/MilestoneService";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";
import type { PendingCheck } from "@/lib/projects/StepCheckedBy";

/** One row of the drawer's Milestones editor. */
export interface EditorStep {
  /** Stable React key (the id, or a client key for a new step). */
  key: string;
  /** Stored id; null for a step added in this edit; MilestoneEditorModel.LEGACY_ID for a legacy milestone. */
  id: string | null;
  name: string;
  /** "YYYY-MM-DD" or "". */
  dueDate: string;
  done: boolean;
  /** "YYYY-MM-DD" (America/New_York) or null. Display only; the server sets it on Save. */
  doneAt: string | null;
  /** Saved checker (display name) and ISO time, from the server; null when not recorded. */
  checkedBy?: string | null;
  checkedAt?: string | null;
  /** Checked in this session and not saved yet: who and when (the tooltip says "Not saved yet."). */
  pending?: PendingCheck | null;
  sourceTemplateId: string | null;
  /** Owner name, or null (Unassigned). */
  owner: string | null;
}

export interface EditorState {
  steps: EditorStep[];
  /** The template applied in this edit (for the history row), if any. */
  applied: TemplateApplied | null;
}

/**
 * Pure rules for the drawer's Milestones section (client side). Edits stay local and save with the form's
 * Save (one history group with the other fields). The server repeats every check (MilestoneRules).
 */
export class MilestoneEditorModel {
  static readonly LEGACY_ID = "legacy";
  static readonly NAME_MAX = MilestoneRules.NAME_MAX;
  private static counter = 0;

  static newKey(): string {
    MilestoneEditorModel.counter += 1;
    return `new-${Date.now().toString(36)}-${MilestoneEditorModel.counter}`;
  }

  /**
   * Stored steps, or (no steps yet) the legacy next milestone shown as step 1 so the drawer matches the
   * dashboard. The server stores that legacy step exactly as the migration backfill would.
   */
  static initial(stored: readonly MilestoneStepDto[], legacy: { nextMilestone: string; dueDate: string }): EditorState {
    if (stored.length > 0) {
      return {
        steps: MilestoneProgress.ordered(stored).map((s) => ({
          key: s.id,
          id: s.id,
          name: s.name,
          dueDate: s.dueDate ?? "",
          done: s.done,
          doneAt: s.doneAt,
          checkedBy: s.checkedBy ?? null,
          checkedAt: s.checkedAt ?? null,
          sourceTemplateId: s.sourceTemplateId,
          owner: s.owner ?? null,
        })),
        applied: null,
      };
    }
    const text = legacy.nextMilestone.trim();
    if (!text) return { steps: [], applied: null };
    const id = MilestoneEditorModel.LEGACY_ID;
    return { steps: [{ key: id, id, name: text, dueDate: legacy.dueDate, done: false, doneAt: null, sourceTemplateId: null, owner: null }], applied: null };
  }

  static add(state: EditorState, name: string): EditorState {
    const step: EditorStep = { key: MilestoneEditorModel.newKey(), id: null, name: MilestoneRules.clean(name), dueDate: "", done: false, doneAt: null, sourceTemplateId: null, owner: null };
    return { ...state, steps: [...state.steps, step] };
  }

  static update(state: EditorState, key: string, patch: Partial<Pick<EditorStep, "name" | "dueDate" | "owner">>): EditorState {
    return { ...state, steps: state.steps.map((s) => (s.key === key ? { ...s, ...patch } : s)) };
  }

  /**
   * Check or uncheck: checking sets doneAt to today (America/New_York) and marks the check as this session's
   * (`checker`, until the server returns the saved step); unchecking clears the date and every checker field, so
   * nothing from an earlier check is kept.
   */
  static setDone(state: EditorState, key: string, done: boolean, today: string, checker: PendingCheck | null = null): EditorState {
    return {
      ...state,
      steps: state.steps.map((s) =>
        s.key === key ? { ...s, done, doneAt: done ? today : null, checkedBy: null, checkedAt: null, pending: done ? checker : null } : s,
      ),
    };
  }

  static remove(state: EditorState, key: string): EditorState {
    return { ...state, steps: state.steps.filter((s) => s.key !== key) };
  }

  /** Move the step at `from` to `to` (drag and drop, or the keyboard). */
  static move(state: EditorState, from: number, to: number): EditorState {
    if (from === to || from < 0 || to < 0 || from >= state.steps.length || to >= state.steps.length) return state;
    const steps = [...state.steps];
    const [moved] = steps.splice(from, 1);
    steps.splice(to, 0, moved);
    return { ...state, steps };
  }

  /** Keyboard reorder on a drag handle: ArrowUp/ArrowDown move one place; anything else does nothing (null). */
  static keyMove(index: number, key: string, count: number): number | null {
    if (key === "ArrowUp" && index > 0) return index - 1;
    if (key === "ArrowDown" && index < count - 1) return index + 1;
    if (key === "Home" && index > 0) return 0;
    if (key === "End" && index < count - 1) return count - 1;
    return null;
  }

  /**
   * Apply a template: its steps are copied (with sourceTemplateId) and stay editable. "replace" removes the
   * current steps first; "append" adds to the end. An empty checklist needs no choice (either mode).
   */
  static applyTemplate(state: EditorState, template: TemplateDto, mode: "replace" | "append"): EditorState {
    const copied: EditorStep[] = template.items.map((i) => ({
      key: MilestoneEditorModel.newKey(),
      id: null,
      name: i.name,
      dueDate: "",
      done: false,
      doneAt: null,
      sourceTemplateId: template.id,
      owner: null,
    }));
    const steps = mode === "replace" ? copied : [...state.steps, ...copied];
    return { steps, applied: { templateId: template.id, templateName: template.name, mode } };
  }

  /** Whether applying needs the Replace / Add to end choice. */
  static needsApplyChoice(state: EditorState): boolean {
    return state.steps.length > 0;
  }

  static toDrafts(state: EditorState): MilestoneDraft[] {
    return state.steps.map((s) => ({ id: s.id, name: s.name, dueDate: s.dueDate, done: s.done, sourceTemplateId: s.sourceTemplateId, owner: s.owner ?? null }));
  }

  /** What Save sends: null when the checklist is unchanged (the server then leaves it alone). */
  static edit(state: EditorState, original: EditorState): MilestoneEdit | null {
    return MilestoneEditorModel.isDirty(state, original) ? { drafts: MilestoneEditorModel.toDrafts(state), applied: state.applied } : null;
  }

  static isDirty(state: EditorState, original: EditorState): boolean {
    const sig = (st: EditorState) => JSON.stringify(MilestoneEditorModel.toDrafts(st).map((d) => ({ ...d, name: MilestoneRules.clean(d.name) })));
    return sig(state) !== sig(original);
  }

  /**
   * Per-step errors (by key): a new or renamed step needs a name of at most 2,000 characters; a stored step
   * whose text is unchanged is accepted even when it is longer (migrated legacy text).
   */
  static errors(state: EditorState, original: EditorState): Record<string, string> {
    const before = new Map(original.steps.map((s) => [s.key, MilestoneRules.clean(s.name)]));
    const out: Record<string, string> = {};
    for (const s of state.steps) {
      const name = MilestoneRules.clean(s.name);
      const unchanged = s.id !== null && before.get(s.key) === name;
      const err = unchanged ? (name ? null : "Name is required") : MilestoneRules.nameError(name);
      if (err) out[s.key] = err;
    }
    return out;
  }

  /** A stored step over the cap that has not been edited (counter warns, no error). */
  static isGrandfathered(step: EditorStep, original: EditorState): boolean {
    const before = original.steps.find((s) => s.key === step.key);
    return !!before && step.id !== null && MilestoneRules.clean(before.name) === MilestoneRules.clean(step.name) && step.name.trim().length > MilestoneRules.NAME_MAX;
  }

  static count(state: EditorState): MilestoneCount | null {
    return MilestoneProgress.count(state.steps.map((s, i) => ({ ...s, position: i + 1 })));
  }

  /** Key of the Next step (first not done), or null. */
  static nextKey(state: EditorState): string | null {
    return state.steps.find((s) => !s.done)?.key ?? null;
  }

  /** "3 of 6 done". */
  static doneLabel(count: MilestoneCount | null): string {
    return count ? `${count.done} of ${count.total} done` : "";
  }

  /** Bar fill, 0 to 100. */
  static percent(count: MilestoneCount | null): number {
    return count && count.total ? Math.round((count.done / count.total) * 100) : 0;
  }

  /** "From 'New supply item'": the template most steps came from (null when none, or it was deleted). */
  static fromTemplate(state: EditorState, templates: readonly TemplateDto[]): string | null {
    const tally = new Map<string, number>();
    for (const s of state.steps) if (s.sourceTemplateId) tally.set(s.sourceTemplateId, (tally.get(s.sourceTemplateId) ?? 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const t = top ? templates.find((x) => x.id === top[0]) : undefined;
    return t ? t.name : null;
  }

  /** Apply template confirm when the project has steps: "This project has 3 milestones (1 done)." */
  static applyPrompt(state: EditorState): string {
    const total = state.steps.length;
    const done = state.steps.filter((s) => s.done).length;
    return `This project has ${total} ${total === 1 ? "milestone" : "milestones"} (${done} done).`;
  }

  /** "23/40" while naming a step. */
  /** "23 / 2,000" (at the cap "2,000 / 2,000, limit reached"); LongTextCounter copy. */
  static nameCounter(name: string): string {
    return LongTextCounter.text(name.length, MilestoneEditorModel.NAME_MAX);
  }

  /** Screen-reader counter: "23 of 2,000 characters used". */
  static nameCounterLabel(name: string): string {
    return LongTextCounter.label(name.length, MilestoneEditorModel.NAME_MAX);
  }

  private static readonly SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  /** "Sep 26" for a YYYY-MM-DD date. */
  static shortDate(iso: string): string {
    return MilestoneEditorModel.SHORT.format(new Date(`${iso}T00:00:00Z`));
  }

  /**
   * What sits where the due date goes: "Done Sep 26" (teal) on a done step, the due date on an open step
   * (overdue color once it is before today), or "Add due date" when there is none.
   */
  static dateLabel(step: EditorStep, today: string): { text: string; tone: "done" | "overdue" | "due" | "empty" } {
    if (step.done) return { text: step.doneAt ? `Done ${MilestoneEditorModel.shortDate(step.doneAt)}` : "Done", tone: "done" };
    if (!step.dueDate) return { text: "Add due date", tone: "empty" };
    return { text: MilestoneEditorModel.shortDate(step.dueDate), tone: step.dueDate < today ? "overdue" : "due" };
  }

  /** New project "Start from" value for no template. */
  static readonly BLANK_START = "blank";

  /** New project checklist for a "Start from" choice: empty for Blank, else the template's steps (editable). */
  static startFrom(id: string, templates: readonly TemplateDto[]): EditorState {
    const empty: EditorState = { steps: [], applied: null };
    const t = templates.find((x) => x.id === id);
    return t ? MilestoneEditorModel.applyTemplate(empty, t, "replace") : empty;
  }
}
