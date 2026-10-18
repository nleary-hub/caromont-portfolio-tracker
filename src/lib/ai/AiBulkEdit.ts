import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { AiToolsModel, type AiToolChange, type AiToolProject } from "./AiToolsModel";

/**
 * Step 5 (CTO condition): the AI returns only a structured filter and one action. This code picks the matching
 * projects and computes every value; the AI never writes a value for a row. Pure, unit tested.
 */
export interface AiBulkFilter {
  statuses: string[];
  dueFrom: string | null;
  dueTo: string | null;
  noDueDate: boolean;
  targetFrom: string | null;
  targetTo: string | null;
  nameContains: string | null;
}

export type AiBulkDateField = "dueDate" | "targetCompletion";
export type AiBulkAction =
  | { field: "status"; set: string }
  | { field: "nextMilestone"; set: string }
  | { field: AiBulkDateField; set: string }
  | { field: AiBulkDateField; shiftDays: number }
  | { field: AiBulkDateField; shiftMonths: number };

export interface AiBulkPlan {
  filter: AiBulkFilter;
  action: AiBulkAction;
}

/** What the review shows above the lines: the filter in plain words, the match count and the Changed count. */
export interface AiBulkSummary {
  filterText: string;
  actionText: string;
  matched: number;
  changed: number;
}

const SHIFT_MAX = 3660;

export class AiBulkEdit {
  static readonly DATE_FIELDS: readonly AiBulkDateField[] = ["dueDate", "targetCompletion"];

  private static date(v: unknown): string | null | undefined {
    if (v === undefined || v === null || v === "") return null;
    return typeof v === "string" && AiToolsModel.validDate(v.trim()) ? v.trim() : undefined;
  }

  /** Reads {"filter":{...},"action":{...}}. Anything else, including per-row changes, is unreadable (null). */
  static parse(text: string): AiBulkPlan | null {
    const body = AiToolsModel.json(text) as { filter?: unknown; action?: unknown } | null;
    if (!body || typeof body.filter !== "object" || body.filter === null || typeof body.action !== "object" || body.action === null) return null;
    if ("changes" in body) return null;
    const filter = AiBulkEdit.parseFilter(body.filter as Record<string, unknown>);
    const action = AiBulkEdit.parseAction(body.action as Record<string, unknown>);
    return filter && action ? { filter, action } : null;
  }

  /** The filter keys of the original bulk edit (also read by the full-field bulk edit). Null = unreadable. */
  static parseFilter(f: Record<string, unknown>): AiBulkFilter | null {
    const statuses: string[] = [];
    if (f.statuses !== undefined) {
      if (!Array.isArray(f.statuses)) return null;
      for (const s of f.statuses) {
        const st = typeof s === "string" ? AiToolsModel.status(s) : null;
        if (!st) return null;
        if (!statuses.includes(st)) statuses.push(st);
      }
    }
    const dueFrom = AiBulkEdit.date(f.dueFrom);
    const dueTo = AiBulkEdit.date(f.dueTo);
    const targetFrom = AiBulkEdit.date(f.targetFrom);
    const targetTo = AiBulkEdit.date(f.targetTo);
    if (dueFrom === undefined || dueTo === undefined || targetFrom === undefined || targetTo === undefined) return null;
    const nameContains = typeof f.nameContains === "string" && f.nameContains.trim() ? f.nameContains.trim().slice(0, 100) : null;
    return { statuses, dueFrom, dueTo, noDueDate: f.noDueDate === true, targetFrom, targetTo, nameContains };
  }

  /** The original four-field action (status, nextMilestone, dueDate, targetCompletion). Null = not one of these. */
  static parseAction(a: Record<string, unknown>): AiBulkAction | null {
    if (a.field === "status") {
      const st = typeof a.set === "string" ? AiToolsModel.status(a.set) : null;
      return st ? { field: "status", set: st } : null;
    }
    if (a.field === "nextMilestone") {
      const v = typeof a.set === "string" ? AiToolsModel.clean("nextMilestone", a.set) : null;
      return v ? { field: "nextMilestone", set: v } : null;
    }
    if (a.field === "dueDate" || a.field === "targetCompletion") {
      const field = a.field;
      const int = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n !== 0 && Math.abs(n) <= SHIFT_MAX ? n : null);
      if (a.set !== undefined) {
        const d = AiBulkEdit.date(a.set);
        return d ? { field, set: d } : null;
      }
      if (int(a.shiftDays) !== null) return { field, shiftDays: int(a.shiftDays)! };
      if (int(a.shiftMonths) !== null && Math.abs(a.shiftMonths as number) <= 120) return { field, shiftMonths: a.shiftMonths as number };
    }
    return null;
  }

  private static inRange(v: string | null, from: string | null, to: string | null): boolean {
    if (!from && !to) return true;
    if (!v) return false;
    return (!from || v >= from) && (!to || v <= to);
  }

  static matches(p: AiToolProject, f: AiBulkFilter): boolean {
    if (f.statuses.length && !f.statuses.includes(p.status)) return false;
    if (f.noDueDate && p.dueDate) return false;
    if (!AiBulkEdit.inRange(p.dueDate, f.dueFrom, f.dueTo)) return false;
    if (!AiBulkEdit.inRange(p.targetCompletion, f.targetFrom, f.targetTo)) return false;
    if (f.nameContains && !p.name.toLowerCase().includes(f.nameContains.toLowerCase())) return false;
    return true;
  }

  /** YYYY-MM-DD plus n months, the same day, kept inside the month (Jan 31 + 1 month = Feb 28 or 29). */
  static addMonths(v: string, n: number): string {
    const [y, m, d] = v.split("-").map(Number);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = total - ny * 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    return new Date(Date.UTC(ny, nm, Math.min(d, last))).toISOString().slice(0, 10);
  }

  static addDays(v: string, n: number): string {
    const d = new Date(`${v}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** The new value for one project, or null when the action leaves it as it is (or can't apply, like moving a blank date). */
  static valueFor(p: AiToolProject, a: AiBulkAction): string | null {
    const before = AiToolsModel.current(p, a.field);
    let after: string;
    if ("set" in a) after = a.set;
    else if (!before) return null;
    else after = "shiftDays" in a ? AiBulkEdit.addDays(before, a.shiftDays) : AiBulkEdit.addMonths(before, a.shiftMonths);
    return after === before ? null : after;
  }

  static run(plan: AiBulkPlan, projects: readonly AiToolProject[]): { changes: AiToolChange[]; summary: AiBulkSummary } {
    const matched = projects.filter((p) => AiBulkEdit.matches(p, plan.filter));
    const changes: AiToolChange[] = [];
    for (const p of matched) {
      if (changes.length >= AiToolsModel.MAX_LINES) break;
      const after = AiBulkEdit.valueFor(p, plan.action);
      if (after === null) continue;
      changes.push({ line: changes.length, projectId: p.id, projectName: p.name, field: plan.action.field, before: AiToolsModel.current(p, plan.action.field), after, reason: "" });
    }
    return { changes, summary: { filterText: AiBulkEdit.describeFilter(plan.filter), actionText: AiBulkEdit.describeAction(plan.action), matched: matched.length, changed: changes.length } };
  }

  private static range(label: string, from: string | null, to: string | null): string | null {
    if (from && to) return from === to ? `${label} is ${from}` : `${label} is from ${from} to ${to}`;
    if (from) return `${label} is on or after ${from}`;
    if (to) return `${label} is on or before ${to}`;
    return null;
  }

  /** The filter in plain words, for the review. */
  static describeFilter(f: AiBulkFilter): string {
    const parts = [
      f.statuses.length ? `status is ${f.statuses.map((s) => ProjectStatusInfo.label(s as never)).join(" or ")}` : null,
      f.noDueDate ? "there is no due date" : null,
      AiBulkEdit.range("due date", f.dueFrom, f.dueTo),
      AiBulkEdit.range("target completion", f.targetFrom, f.targetTo),
      f.nameContains ? `name contains "${f.nameContains}"` : null,
    ].filter((x): x is string => x !== null);
    return parts.length ? `Open projects where ${parts.join(", and ")}.` : "All open projects.";
  }

  static describeAction(a: AiBulkAction): string {
    const label = AiToolsModelLabel[a.field];
    if (a.field === "status") return `Set status to ${ProjectStatusInfo.label(a.set as never)}.`;
    if ("set" in a) return `Set ${label} to ${a.set}.`;
    const n = "shiftDays" in a ? a.shiftDays : a.shiftMonths;
    const unit = "shiftDays" in a ? "day" : "month";
    const abs = Math.abs(n);
    return `Move ${label} ${abs} ${unit}${abs === 1 ? "" : "s"} ${n > 0 ? "later" : "earlier"}.`;
  }
}

const AiToolsModelLabel: Record<AiBulkAction["field"], string> = { status: "status", nextMilestone: "next milestone", dueDate: "due date", targetCompletion: "target completion" };
