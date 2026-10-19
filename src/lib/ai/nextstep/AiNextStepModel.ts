import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { AiToolsModel } from "../AiToolsModel";

/** A template the project's milestones came from (or the line's templates, when none is linked). */
export interface AiNextStepTemplate {
  name: string;
  steps: string[];
}

/** The model's suggestion, checked: which milestone is really next, who owns it, when, and the action this week. */
export interface AiNextStep {
  milestone: string;
  existing: boolean;
  owner: string | null;
  dueDate: string | null;
  thisWeek: string;
  why: string;
}

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/**
 * Item 6: the next-step suggestion from the project's milestone plan and template, not just its Latest update. Pure:
 * prompt, reply parsing, and the change lines (in the shared action layer's shape) that make the suggestion real:
 * move an existing milestone up to current, add a missing one, set its owner and due date. The action for this week
 * is shown, never saved.
 */
export class AiNextStepModel {
  static readonly MAX_TOKENS = 700;
  static readonly MILESTONE_MAX = 40;

  static system(context: string, templates: readonly AiNextStepTemplate[]): string {
    const t = templates.length ? templates.map((x) => `- ${x.name}: ${x.steps.join(" > ")}`).join("\n") : "- (no template linked)";
    return [
      "You suggest the real next step for ONE project in a project portfolio tracker, from its milestone plan (every milestone with owner, due date and done state), its template, its blockers and its updates. The Latest update alone is not enough.",
      "Pick the milestone that is really next: usually the first open one, but say so if an earlier step is still open, if the template has a step the project skipped, or if the plan is missing a step the updates show is needed (then it is a new milestone).",
      "Owner: a person exactly as named in the context (milestone owners, the project owner, contracts lead) or leave it blank. Never invent anyone.",
      "Due date: realistic, on or after today, consistent with the project's due date and its blockers; leave it blank if nothing supports a date.",
      "thisWeek: one concrete action for this week with who does it, in 20 words or fewer. why: one short sentence citing the plan or update.",
      'Reply with JSON only: {"milestone":"name (40 characters max)","existing":true,"owner":"","dueDate":"YYYY-MM-DD","thisWeek":"...","why":"..."}',
      "Never put patient details anywhere.",
      "Templates for this project:",
      t,
      "Project context:",
      context,
    ].join("\n");
  }

  static parse(text: string, today: string): AiNextStep | null {
    const b = AiToolsModel.json(text) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") return null;
    const milestone = clip(b.milestone, AiNextStepModel.MILESTONE_MAX);
    if (!milestone) return null;
    const due = clip(b.dueDate, 10);
    return {
      milestone,
      existing: b.existing !== false,
      owner: clip(b.owner, 120) || null,
      dueDate: due && AiToolsModel.validDate(due) && due >= today ? due : null,
      thisWeek: clip(b.thisWeek, 240),
      why: clip(b.why, 240),
    };
  }

  /** The change lines for the project at `ref` (P1): what it takes to make the suggestion the current milestone. */
  static changes(ref: string, s: AiNextStep, steps: readonly MilestoneDraft[]): Record<string, unknown>[] {
    const key = (n: string) => n.trim().toLowerCase();
    const found = steps.find((x) => !x.done && key(x.name) === key(s.milestone));
    const reason = s.why || undefined;
    if (!found) return [{ ref, op: "add_milestone", name: s.milestone, after: "next", ...(s.owner ? { owner: s.owner } : {}), ...(s.dueDate ? { dueDate: s.dueDate } : {}), reason }];
    const out: Record<string, unknown>[] = [];
    const current = steps.find((x) => !x.done);
    if (current && current !== found) out.push({ ref, op: "move_milestone", milestone: found.name, after: "next", reason });
    if (s.owner && (found.owner ?? "") !== s.owner) out.push({ ref, op: "milestone_owner", milestone: found.name, owner: s.owner, reason });
    if (s.dueDate && (found.dueDate ?? "") !== s.dueDate) out.push({ ref, op: "milestone_due", milestone: found.name, dueDate: s.dueDate, reason });
    return out;
  }
}
