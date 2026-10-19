import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { AiBulkEdit, type AiBulkAction, type AiBulkFilter, type AiBulkSummary } from "../AiBulkEdit";
import type { AiToolProject } from "../AiToolsModel";
import type { AiActionLists, AiActionProject } from "../actions/AiActionModel";

/** Item 4: the filter of the full-field bulk edit (the original keys plus who, where and what state). */
export interface AiBulkFullFilter extends AiBulkFilter {
  departments: string[];
  owners: string[];
  ownerUnassigned: boolean;
  overdue: boolean;
  blocked: boolean;
}

export type AiBulkPeopleField = "owner" | "contractsLead" | "requester" | "department" | "milestoneOwner";
/** One action for every matching project. The app works out each line; the AI never writes a per-project value. */
export type AiBulkFullAction = AiBulkAction | { field: AiBulkPeopleField; set: string } | { op: "complete_milestone" } | { op: "mark_reviewed" };
export interface AiBulkFullPlan {
  filter: AiBulkFullFilter;
  action: AiBulkFullAction;
}

const PEOPLE_FIELDS: readonly AiBulkPeopleField[] = ["owner", "contractsLead", "requester", "department", "milestoneOwner"];
const LABEL: Record<AiBulkPeopleField, string> = { owner: "owner", contractsLead: "contracts lead", requester: "requester", department: "department", milestoneOwner: "current milestone's owner" };
const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim().slice(0, 100)).slice(0, n) : []);

/**
 * Item 4: plain-English bulk edit over the full field set. The model returns one filter and one action (same rule as
 * step 5: it never lists projects or writes a value per row). This code picks the projects, writes one change line per
 * project in the shared action layer's shape (item B checks every value against the pick lists), and describes the
 * filter in plain words for the person to read before the preview. Pure, unit tested.
 */
export class AiBulkEditFull {
  static readonly MAX_TOKENS = 600;

  static parse(text: string): AiBulkFullPlan | null {
    const body = JSONish(text) as { filter?: unknown; action?: unknown } | null;
    if (!body || typeof body.filter !== "object" || body.filter === null || typeof body.action !== "object" || body.action === null || "changes" in body) return null;
    const f = body.filter as Record<string, unknown>;
    const base = AiBulkEdit.parseFilter(f);
    if (!base) return null;
    const filter: AiBulkFullFilter = { ...base, departments: strs(f.departments, 10), owners: strs(f.owners, 10), ownerUnassigned: f.ownerUnassigned === true, overdue: f.overdue === true, blocked: f.blocked === true };
    const a = body.action as Record<string, unknown>;
    if (a.op === "complete_milestone" || a.op === "mark_reviewed") return { filter, action: { op: a.op } };
    const field = PEOPLE_FIELDS.find((x) => x === a.field);
    if (field) {
      const set = typeof a.set === "string" ? PeopleDirectory.normalizeName(a.set).slice(0, 120) : "";
      if (!set && field === "department") return null;
      return { filter, action: { field, set: set || "To assign" } };
    }
    const old = AiBulkEdit.parseAction(a);
    return old ? { filter, action: old } : null;
  }

  static matches(p: AiActionProject, f: AiBulkFullFilter, today: string, lists: AiActionLists): boolean {
    if (!AiBulkEdit.matches(p as AiToolProject, f)) return false;
    if (f.departments.length) {
      const dept = lists.departments.find((d) => d.id === p.departmentId);
      const names = dept ? [dept.name, (dept as { shortName?: string | null }).shortName ?? ""].filter(Boolean).map((x) => x.toLowerCase()) : [];
      if (!f.departments.some((d) => names.includes(d.toLowerCase()) || d === p.departmentId)) return false;
    }
    if (f.owners.length && !f.owners.some((o) => (p.owner ?? "").toLowerCase() === o.toLowerCase())) return false;
    if (f.ownerUnassigned && p.owner && !PeopleDirectory.isToAssignText(p.owner)) return false;
    if (f.overdue && !(p.dueDate && p.dueDate < today && p.status !== "Complete" && p.status !== "Cancelled")) return false;
    if (f.blocked && !(p.blockers.length || p.blockedBy.length)) return false;
    return true;
  }

  /** One raw change per matching project (P refs of `projects`), for AiActionService.propose. `only` limits to chosen ids. */
  static changes(plan: AiBulkFullPlan, projects: readonly AiActionProject[], today: string, lists: AiActionLists, only: ReadonlySet<string> | null): { changes: Record<string, unknown>[]; matched: number } {
    const out: Record<string, unknown>[] = [];
    let matched = 0;
    projects.forEach((p, i) => {
      if (only && !only.has(p.id)) return;
      if (!AiBulkEditFull.matches(p, plan.filter, today, lists)) return;
      matched += 1;
      const ref = `P${i + 1}`;
      const a = plan.action;
      if ("op" in a) out.push({ ref, op: a.op });
      else if (a.field === "milestoneOwner") out.push({ ref, op: "milestone_owner", owner: a.set });
      else if (a.field === "owner" || a.field === "contractsLead" || a.field === "requester" || a.field === "department") out.push({ ref, op: "set_field", field: a.field, value: a.set });
      else {
        const v = AiBulkEdit.valueFor(p as AiToolProject, a as AiBulkAction);
        if (v !== null) out.push({ ref, op: "set_field", field: a.field, value: v });
      }
    });
    return { changes: out, matched };
  }

  static describeFilter(f: AiBulkFullFilter, onlyCount: number | null): string {
    const base = AiBulkEdit.describeFilter(f);
    const parts = [
      onlyCount !== null ? `it is one of the ${onlyCount} selected` : null,
      base === "All open projects." ? null : base.replace(/^Open projects where /, "").replace(/\.$/, ""),
      f.departments.length ? `department is ${f.departments.join(" or ")}` : null,
      f.owners.length ? `owner is ${f.owners.join(" or ")}` : null,
      f.ownerUnassigned ? "no owner is assigned" : null,
      f.overdue ? "it is overdue" : null,
      f.blocked ? "it is blocked" : null,
    ].filter((x): x is string => x !== null);
    return parts.length ? `Open projects where ${parts.join(", and ")}.` : "All open projects.";
  }

  static describeAction(a: AiBulkFullAction): string {
    if ("op" in a) return a.op === "mark_reviewed" ? "Mark as reviewed." : "Complete the current milestone.";
    if (AiBulkEditFull.isPeople(a)) return PeopleDirectory.isToAssignText(a.set) ? `Clear the ${LABEL[a.field]} (To assign).` : `Set the ${LABEL[a.field]} to ${a.set}.`;
    return AiBulkEdit.describeAction(a as AiBulkAction);
  }

  static isPeople(a: AiBulkFullAction): a is { field: AiBulkPeopleField; set: string } {
    return "field" in a && PEOPLE_FIELDS.includes(a.field as AiBulkPeopleField);
  }

  static summary(plan: AiBulkFullPlan, matched: number, changed: number, onlyCount: number | null): AiBulkSummary {
    return { filterText: AiBulkEditFull.describeFilter(plan.filter, onlyCount), actionText: AiBulkEditFull.describeAction(plan.action), matched, changed };
  }

  static system(context: string): string {
    return [
      "You turn a plain-English bulk edit request into ONE filter and ONE action for a project portfolio tracker.",
      "Do not list projects and do not write a value for any project. The app finds the matching projects and works out every line, and the person reviews them before anything is saved.",
      'Reply with JSON only: {"filter":{...},"action":{...}}',
      "filter keys, all optional: statuses (list of NotStarted, OnTrack, AtRisk, OffTrack, OnHold, Complete, Cancelled), departments (names as in the context), owners (names as in the context), ownerUnassigned (true), overdue (true), blocked (true), dueFrom, dueTo, noDueDate (true), targetFrom, targetTo, nameContains. Dates YYYY-MM-DD, inclusive.",
      "action, exactly one of: {\"field\":\"status\",\"set\":\"OnHold\"}; {\"field\":\"nextMilestone\",\"set\":\"...\"}; {\"field\":\"dueDate\" or \"targetCompletion\", \"set\":\"YYYY-MM-DD\"} or with shiftDays or shiftMonths (whole numbers, negative = earlier); {\"field\":\"owner\" or \"contractsLead\" or \"requester\" or \"milestoneOwner\",\"set\":\"a name exactly as in the context, or To assign\"}; {\"field\":\"department\",\"set\":\"a department name\"}; {\"op\":\"complete_milestone\"} (each project's current milestone); {\"op\":\"mark_reviewed\"}.",
      "Never change the Latest update in bulk. Never invent a person or department. If the request needs more than one action or can't be expressed this way, reply {}.",
      "Portfolio context:",
      context,
    ].join("\n");
  }
}

/** The tolerant JSON reader of the AI tools (fences and stray text allowed). */
function JSONish(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
