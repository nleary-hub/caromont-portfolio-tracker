import { AppConfig } from "@/lib/config/AppConfig";
import { MilestoneRules, type MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { DepartmentInfo } from "@/lib/domain/ServiceAreaInfo";
import { AiToolsModel } from "@/lib/ai/AiToolsModel";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { BlockerRules } from "@/lib/projects/BlockerRules";

/** Project fields the shared action layer can set (item B). requester = the physician champion column. */
export type AiActionField = "status" | "nextMilestone" | "dueDate" | "targetCompletion" | "note" | "owner" | "requester" | "contractsLead" | "department";

export type AiActionOp =
  | "set_field"
  | "complete_milestone"
  | "add_milestone"
  | "move_milestone"
  | "skip_milestone"
  | "milestone_owner"
  | "milestone_due"
  | "mark_reviewed"
  | "add_blocker"
  | "update_blocker"
  | "resolve_blocker"
  | "add_dependency"
  | "remove_dependency";

/** One checked change line, as stored in ai_proposals.lines. Values are already validated and in saved spelling. */
export interface AiActionLine {
  line: number;
  op: AiActionOp;
  projectId: string;
  projectName: string;
  field?: AiActionField;
  /** The value to save: status key, date "YYYY-MM-DD", list spelling of a name, department id ("" clears). */
  value?: string;
  /** Target step (milestone ops). */
  stepId?: string;
  stepName?: string;
  /** add_milestone. */
  name?: string;
  dueDate?: string;
  owner?: string | null;
  /** add_milestone and move_milestone: "next" (becomes the current milestone), "end", "start" or a step id to go after. */
  position?: string;
  /** Blocker ops. */
  blockerId?: string;
  description?: string;
  waitingOn?: string;
  followUpOn?: string | null;
  followUpOwner?: string | null;
  resolution?: string;
  /** Dependency ops: the project this one is (or was) blocked by. */
  otherId?: string;
  otherName?: string;
  note?: string | null;
  /** Short words for the review card and the spoken read-back. */
  label: string;
  before: string;
  after: string;
  reason: string;
}

/** A line the layer refused, with the reason in plain words (sent back to the model so it can tell the user). */
export interface AiActionRefusal {
  ref: string;
  op: string;
  why: string;
}

/** What the action layer knows about one project when it checks or applies a line. */
export interface AiActionProject {
  id: string;
  name: string;
  status: string;
  nextMilestone: string | null;
  dueDate: string | null;
  targetCompletion: string | null;
  note: string | null;
  owner: string | null;
  requester: string | null;
  requesterNotApplicable: boolean;
  contractsLead: string | null;
  departmentId: string | null;
  steps: MilestoneDraft[];
  blockers: { id: string; description: string; waitingOn: string; followUpOn: string | null; followUpOwner: string | null }[];
  /** Ids of the projects this one is blocked by (open rows). */
  blockedBy: string[];
  /** The note on each open Blocked-by row, by blocker id (kept so an undo can put a removed row back as it was). */
  dependencyNotes?: Record<string, string | null>;
}

/** The line's pick lists (validation never invents a person, department or status). */
export interface AiActionLists {
  owners: readonly string[];
  requesters: readonly string[];
  contractsLeads: readonly string[];
  /** Milestone owner picker: every list of the line together (OwnerNameLists.combined). */
  stepOwners: readonly string[];
  departments: readonly DepartmentInfo[];
}

export const AI_ACTION_FIELDS: readonly AiActionField[] = ["status", "nextMilestone", "dueDate", "targetCompletion", "note", "owner", "requester", "contractsLead", "department"];
export const AI_ACTION_OPS: readonly AiActionOp[] = [
  "set_field",
  "complete_milestone",
  "add_milestone",
  "move_milestone",
  "skip_milestone",
  "milestone_owner",
  "milestone_due",
  "mark_reviewed",
  "add_blocker",
  "update_blocker",
  "resolve_blocker",
  "add_dependency",
  "remove_dependency",
];

const FIELD_LABEL: Record<AiActionField, string> = {
  status: "Status",
  nextMilestone: "Next milestone",
  dueDate: "Due date",
  targetCompletion: "Target completion",
  note: "Latest update",
  owner: "Owner",
  requester: "Requester",
  contractsLead: "Contracts lead",
  department: "Department",
};

type Raw = Record<string, unknown>;
type Checked = { ok: true; line: Omit<AiActionLine, "line" | "reason"> } | { ok: false; why: string };

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const TO_ASSIGN = "To assign";

/**
 * Item B: the pure rules of the shared AI action layer (unit tested). Reads a model's propose_changes call, checks each
 * change against the project as stored and the line's pick lists, and plans the exact milestone list a checklist op
 * saves. Nothing here writes; AiActionService applies through the normal project services.
 */
export class AiActionModel {
  static readonly MAX_LINES = AiToolsModel.MAX_LINES;

  static label(field: AiActionField): string {
    return FIELD_LABEL[field];
  }

  /** P3 -> the third project of the list; also accepts a project id. */
  static byRef(ref: unknown, projects: readonly { id: string }[]): number {
    const s = str(ref);
    const m = /^P(\d+)$/i.exec(s);
    if (m) {
      const i = Number(m[1]) - 1;
      return i >= 0 && i < projects.length ? i : -1;
    }
    return s ? projects.findIndex((p) => p.id === s) : -1;
  }

  /** A name from `list` in its saved spelling: exact (any case or spacing), else a unique first-name or last-name match. */
  static person(list: readonly string[], raw: string): string | null {
    const name = PeopleDirectory.normalizeName(raw);
    if (!name) return null;
    const exact = PeopleDirectory.find(list, name);
    if (exact) return exact;
    if (name.includes(" ")) return null;
    const key = name.toLowerCase();
    const hits = list.filter((n) => {
      const words = n.replace(/^dr\.?\s+/i, "").toLowerCase().split(/\s+/);
      return words[0] === key || words[words.length - 1] === key;
    });
    return hits.length === 1 ? hits[0] : null;
  }

  /** An open department by id, full name or short name. */
  static department(list: readonly DepartmentInfo[], raw: string): DepartmentInfo | null {
    const k = raw.trim().toLowerCase();
    if (!k) return null;
    return list.find((d) => !d.archived && !d.deleted && (d.id.toLowerCase() === k || d.name.toLowerCase() === k || d.shortName.toLowerCase() === k)) ?? null;
  }

  /** "current" (or blank) = the first open step; else a step by name: exact, then a unique partial match. */
  static step(steps: readonly MilestoneDraft[], raw: unknown, openOnly = false): MilestoneDraft | null | "ambiguous" {
    const k = str(raw).toLowerCase();
    const pool = openOnly ? steps.filter((s) => !s.done) : steps;
    if (!k || k === "current" || k === "next") return steps.find((s) => !s.done) ?? null;
    const exact = pool.filter((s) => s.name.trim().toLowerCase() === k);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return "ambiguous";
    const part = pool.filter((s) => s.name.toLowerCase().includes(k) || k.includes(s.name.toLowerCase()));
    if (part.length === 1) return part[0];
    return part.length > 1 ? "ambiguous" : null;
  }

  /** An open external blocker by its description or who it waits on (exact, then a unique partial match). */
  static blocker(p: AiActionProject, raw: unknown): AiActionProject["blockers"][number] | null | "ambiguous" {
    const k = str(raw).toLowerCase();
    if (!k) return p.blockers.length === 1 ? p.blockers[0] : p.blockers.length ? "ambiguous" : null;
    const exact = p.blockers.filter((b) => b.id === str(raw) || b.description.toLowerCase() === k || b.waitingOn.toLowerCase() === k);
    if (exact.length === 1) return exact[0];
    const part = p.blockers.filter((b) => b.description.toLowerCase().includes(k) || b.waitingOn.toLowerCase().includes(k) || k.includes(b.waitingOn.toLowerCase()));
    if (part.length === 1) return part[0];
    return part.length > 1 || exact.length > 1 ? "ambiguous" : null;
  }

  /** The current value of a field as words ("" = blank). */
  static current(p: AiActionProject, field: AiActionField, lists: AiActionLists): string {
    switch (field) {
      case "requester":
        return p.requesterNotApplicable ? "Not applicable" : (p.requester ?? "");
      case "department":
        return p.departmentId ? (lists.departments.find((d) => d.id === p.departmentId)?.name ?? "") : "";
      case "status":
        return ProjectStatusInfo.label(p.status as never) ?? p.status;
      default:
        return p[field] ?? "";
    }
  }

  private static dateOrNull(v: string): string | null | "bad" {
    if (!v) return null;
    return AiToolsModel.validDate(v) ? v : "bad";
  }

  /** Checks one raw change. */
  static check(c: Raw, p: AiActionProject, projects: readonly AiActionProject[], lists: AiActionLists): Checked {
    const op = (AI_ACTION_OPS as readonly string[]).includes(str(c.op)) ? (str(c.op) as AiActionOp) : c.field !== undefined ? "set_field" : null;
    if (!op) return { ok: false, why: "unknown change type" };
    const base = { op, projectId: p.id, projectName: p.name };
    switch (op) {
      case "set_field": {
        const field = AI_ACTION_FIELDS.find((f) => f === str(c.field));
        if (!field) return { ok: false, why: `"${str(c.field)}" is not a field the AI can change` };
        const raw = str(c.value);
        const before = AiActionModel.current(p, field, lists);
        let value: string;
        let after: string;
        switch (field) {
          case "status": {
            const s = AiToolsModel.status(raw);
            if (!s) return { ok: false, why: `"${raw}" is not a status` };
            value = s;
            after = ProjectStatusInfo.label(s as never);
            break;
          }
          case "dueDate":
          case "targetCompletion":
          case "nextMilestone":
          case "note": {
            const v = AiToolsModel.clean(field, raw);
            if (v === null) return { ok: false, why: `"${raw.slice(0, 40)}" is not a valid ${FIELD_LABEL[field].toLowerCase()}` };
            value = v;
            after = v;
            break;
          }
          case "owner":
          case "contractsLead": {
            if (!raw || PeopleDirectory.isToAssignText(raw)) {
              value = "";
              after = "";
              break;
            }
            const n = AiActionModel.person(field === "owner" ? lists.owners : lists.contractsLeads, raw);
            if (!n) return { ok: false, why: `${raw} is not on the ${field === "owner" ? "Owners" : "Contracts leads"} list` };
            value = n;
            after = n;
            break;
          }
          case "requester": {
            if (PeopleDirectory.isNotApplicableText(raw)) {
              value = "Not applicable";
              after = "Not applicable";
              break;
            }
            if (!raw || PeopleDirectory.isToAssignText(raw)) {
              value = "";
              after = "";
              break;
            }
            const n = AiActionModel.person(lists.requesters, raw);
            if (!n) return { ok: false, why: `${raw} is not on the Requesters list` };
            value = n;
            after = n;
            break;
          }
          case "department": {
            const d = AiActionModel.department(lists.departments, raw);
            if (!d) return { ok: false, why: `"${raw}" is not a department of this service line` };
            value = d.id;
            after = d.name;
            break;
          }
        }
        if (after === before) return { ok: false, why: `${FIELD_LABEL[field]} is already ${after || "blank"}` };
        return { ok: true, line: { ...base, field, value, label: FIELD_LABEL[field], before: before || (field === "owner" || field === "requester" ? TO_ASSIGN : ""), after: after || (field === "owner" || field === "requester" ? TO_ASSIGN : "") } };
      }
      case "complete_milestone":
      case "skip_milestone":
      case "milestone_owner":
      case "milestone_due":
      case "move_milestone": {
        const s = AiActionModel.step(p.steps, c.milestone, op === "complete_milestone" || op === "skip_milestone");
        if (s === "ambiguous") return { ok: false, why: `more than one milestone matches "${str(c.milestone)}"` };
        if (!s) return { ok: false, why: str(c.milestone) ? `no milestone "${str(c.milestone)}" on this project` : "this project has no open milestone" };
        const target = { stepId: s.id ?? undefined, stepName: s.name };
        if (op === "complete_milestone") {
          if (s.done) return { ok: false, why: `${s.name} is already done` };
          return { ok: true, line: { ...base, ...target, label: "Complete milestone", before: s.name, after: "Done" } };
        }
        if (op === "skip_milestone") {
          if (p.steps.length <= 1) return { ok: false, why: "a project needs at least one milestone" };
          return { ok: true, line: { ...base, ...target, label: "Remove milestone", before: s.name, after: "Removed" } };
        }
        if (op === "milestone_owner") {
          const raw = str(c.owner ?? c.value);
          const n = !raw || PeopleDirectory.isToAssignText(raw) ? "" : AiActionModel.person(lists.stepOwners, raw);
          if (n === null) return { ok: false, why: `${raw} is not on the People lists` };
          if ((s.owner ?? "") === n) return { ok: false, why: `${s.name} owner is already ${n || "Unassigned"}` };
          return { ok: true, line: { ...base, ...target, owner: n || null, label: `Milestone owner (${s.name})`, before: s.owner || "Unassigned", after: n || "Unassigned" } };
        }
        if (op === "milestone_due") {
          const d = AiActionModel.dateOrNull(str(c.dueDate ?? c.value));
          if (d === "bad") return { ok: false, why: `"${str(c.dueDate ?? c.value)}" is not a date` };
          if ((s.dueDate || null) === d) return { ok: false, why: `${s.name} is already due ${d ?? "with no date"}` };
          return { ok: true, line: { ...base, ...target, dueDate: d ?? "", label: `Milestone due (${s.name})`, before: s.dueDate || "", after: d ?? "" } };
        }
        const pos = AiActionModel.position(p.steps, c.after, s.id);
        if (!pos) return { ok: false, why: `can't find where to move ${s.name}` };
        return { ok: true, line: { ...base, ...target, position: pos.position, label: "Move milestone", before: s.name, after: pos.words } };
      }
      case "add_milestone": {
        const name = PeopleDirectory.normalizeName(str(c.name ?? c.value));
        if (!name || name.length > MilestoneRules.NAME_MAX) return { ok: false, why: "a new milestone needs a name (short)" };
        if (p.steps.length >= MilestoneRules.MAX_STEPS) return { ok: false, why: "this project already has the most milestones allowed" };
        if (p.steps.some((s) => !s.done && s.name.toLowerCase() === name.toLowerCase())) return { ok: false, why: `${name} is already an open milestone` };
        const d = AiActionModel.dateOrNull(str(c.dueDate));
        if (d === "bad") return { ok: false, why: `"${str(c.dueDate)}" is not a date` };
        const rawOwner = str(c.owner);
        const owner = rawOwner ? AiActionModel.person(lists.stepOwners, rawOwner) : null;
        if (rawOwner && !owner) return { ok: false, why: `${rawOwner} is not on the People lists` };
        const pos = AiActionModel.position(p.steps, c.after ?? "next", null);
        if (!pos) return { ok: false, why: "can't find where to add the milestone" };
        const words = [name, d ? `due ${d}` : null, owner ? `owner ${owner}` : null].filter(Boolean).join(", ");
        return { ok: true, line: { ...base, name, dueDate: d ?? "", owner, position: pos.position, label: "Add milestone", before: "", after: `${words} (${pos.words})` } };
      }
      case "mark_reviewed":
        return { ok: true, line: { ...base, label: "Mark as reviewed", before: "", after: "Reviewed" } };
      case "add_blocker": {
        const description = str(c.description);
        const waitingOn = str(c.waitingOn);
        if (!description || description.length > BlockerRules.DESCRIPTION_MAX) return { ok: false, why: "a blocker needs a short description" };
        if (!waitingOn || waitingOn.length > BlockerRules.WAITING_ON_MAX) return { ok: false, why: "a blocker needs who or what it waits on" };
        const f = AiActionModel.followUp(c, lists);
        if (!f.ok) return f;
        const words = [`Waiting on ${waitingOn}: ${description}`, f.followUpOn ? `follow up ${f.followUpOn}` : null, f.followUpOwner ? `by ${f.followUpOwner}` : null].filter(Boolean).join(", ");
        return { ok: true, line: { ...base, description, waitingOn, followUpOn: f.followUpOn, followUpOwner: f.followUpOwner, label: "Add blocker", before: "", after: words } };
      }
      case "update_blocker":
      case "resolve_blocker": {
        const b = AiActionModel.blocker(p, c.blocker);
        if (b === "ambiguous") return { ok: false, why: "say which blocker (more than one is open)" };
        if (!b) return { ok: false, why: "no open blocker matches" };
        if (op === "resolve_blocker") {
          const resolution = str(c.resolution ?? c.value);
          if (!resolution || resolution.length > BlockerRules.RESOLUTION_MAX) return { ok: false, why: "say what resolved it" };
          return { ok: true, line: { ...base, blockerId: b.id, resolution, label: "Resolve blocker", before: `${b.waitingOn}: ${b.description}`, after: `Resolved: ${resolution}` } };
        }
        const f = AiActionModel.followUp({ followUpOn: c.followUpOn ?? (b.followUpOn ?? ""), followUpOwner: c.followUpOwner ?? (b.followUpOwner ?? "") }, lists);
        if (!f.ok) return f;
        const waitingOn = str(c.waitingOn) || b.waitingOn;
        const description = str(c.description) || b.description;
        if (waitingOn.length > BlockerRules.WAITING_ON_MAX || description.length > BlockerRules.DESCRIPTION_MAX) return { ok: false, why: "blocker text is too long" };
        const words = (x: { waitingOn: string; description: string; followUpOn: string | null; followUpOwner: string | null }) =>
          [`${x.waitingOn}: ${x.description}`, x.followUpOn ? `follow up ${x.followUpOn}` : null, x.followUpOwner ? `by ${x.followUpOwner}` : null].filter(Boolean).join(", ");
        const before = words(b);
        const after = words({ waitingOn, description, followUpOn: f.followUpOn, followUpOwner: f.followUpOwner });
        if (before === after) return { ok: false, why: "nothing to change on that blocker" };
        return { ok: true, line: { ...base, blockerId: b.id, waitingOn, description, followUpOn: f.followUpOn, followUpOwner: f.followUpOwner, label: "Change blocker", before, after } };
      }
      case "add_dependency":
      case "remove_dependency": {
        const i = AiActionModel.byRef(c.other ?? c.blockedBy, projects);
        const o = i >= 0 ? projects[i] : undefined;
        if (!o) return { ok: false, why: "say which listed project it is blocked by" };
        if (o.id === p.id) return { ok: false, why: "a project can't block itself" };
        const open = p.blockedBy.includes(o.id);
        if (op === "remove_dependency") {
          if (!open) return { ok: false, why: `${p.name} is not blocked by ${o.name}` };
          return { ok: true, line: { ...base, otherId: o.id, otherName: o.name, label: "Remove Blocked by", before: o.name, after: "Removed" } };
        }
        if (open) return { ok: false, why: `${p.name} is already blocked by ${o.name}` };
        const note = str(c.note ?? c.reason);
        const kept = note && note.length <= BlockerRules.NOTE_MAX ? note : note ? note.slice(0, BlockerRules.NOTE_MAX).trim() : null;
        return { ok: true, line: { ...base, otherId: o.id, otherName: o.name, note: kept, label: "Blocked by", before: "", after: kept ? `${o.name} (${kept})` : o.name } };
      }
    }
  }

  private static followUp(c: Raw, lists: AiActionLists): { ok: true; followUpOn: string | null; followUpOwner: string | null } | { ok: false; why: string } {
    const d = AiActionModel.dateOrNull(str(c.followUpOn));
    if (d === "bad") return { ok: false, why: `"${str(c.followUpOn)}" is not a date` };
    const raw = str(c.followUpOwner);
    const owner = raw ? AiActionModel.person(lists.stepOwners, raw) : null;
    if (raw && !owner) return { ok: false, why: `${raw} is not on the People lists` };
    return { ok: true, followUpOn: d, followUpOwner: owner };
  }

  /** Where a step goes: "next", "end", "start" or after a named step. */
  static position(steps: readonly MilestoneDraft[], raw: unknown, self: string | null): { position: string; words: string } | null {
    const k = str(raw).toLowerCase();
    if (!k || k === "next" || k === "current") return { position: "next", words: "as the next milestone" };
    if (k === "end" || k === "last") return { position: "end", words: "at the end" };
    if (k === "start" || k === "first") return { position: "start", words: "first" };
    const s = AiActionModel.step(steps, raw);
    if (!s || s === "ambiguous" || !s.id || s.id === self) return null;
    return { position: s.id, words: `after ${s.name}` };
  }

  /**
   * Reads {"changes":[...]} (or a bare array) into checked lines plus refusals. Unknown refs, unknown people, invalid
   * values, no-ops and repeats are refused with a reason. null = unreadable.
   */
  static parse(raw: unknown, projects: readonly AiActionProject[], lists: AiActionLists): { lines: AiActionLine[]; refused: AiActionRefusal[] } | null {
    let body: unknown = raw;
    if (typeof raw === "string") body = AiToolsModel.json(raw.trim().startsWith("[") ? `{"changes":${raw}}` : raw);
    const list = Array.isArray(body) ? body : body && typeof body === "object" && Array.isArray((body as Raw).changes) ? ((body as Raw).changes as unknown[]) : null;
    if (!list) return null;
    const lines: AiActionLine[] = [];
    const refused: AiActionRefusal[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (lines.length >= AiActionModel.MAX_LINES) break;
      if (!item || typeof item !== "object") continue;
      const c = item as Raw;
      const ref = str(c.ref ?? c.project);
      const i = AiActionModel.byRef(ref, projects);
      if (i < 0) {
        refused.push({ ref, op: str(c.op) || "set_field", why: "unknown project ref" });
        continue;
      }
      const r = AiActionModel.check(c, projects[i], projects, lists);
      if (!r.ok) {
        refused.push({ ref, op: str(c.op) || "set_field", why: r.why });
        continue;
      }
      const key = [r.line.projectId, r.line.op, r.line.field ?? "", r.line.stepId ?? r.line.name ?? "", r.line.blockerId ?? "", r.line.otherId ?? ""].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      const reason = str(c.reason).slice(0, AiToolsModel.REASON_MAX);
      lines.push({ ...r.line, line: lines.length, reason });
    }
    return { lines, refused };
  }

  /** One sentence for the voice read-back: "Set Status to At risk on Sample A; add milestone Flooring on Sample B." */
  static summary(lines: readonly AiActionLine[]): string {
    const parts = lines.map((l) => {
      if (l.op === "set_field") return `${l.label} to ${l.after || "blank"} on ${l.projectName}`;
      return `${l.label}: ${l.after || l.before} on ${l.projectName}`;
    });
    return parts.join("; ");
  }

  /** The milestone list after a checklist op, or an error. `steps` is the list as stored now. */
  static planSteps(steps: readonly MilestoneDraft[], l: AiActionLine): MilestoneDraft[] | string {
    const list = steps.map((s) => ({ ...s }));
    const at = list.findIndex((s) => s.id === l.stepId);
    const needStep = l.op !== "add_milestone";
    if (needStep && at < 0) return `${l.stepName ?? "That milestone"} is no longer on the project`;
    const insertAt = (pos: string | undefined, without: MilestoneDraft[]): number => {
      if (pos === "start") return 0;
      if (pos === "end") return without.length;
      if (!pos || pos === "next") {
        const open = without.findIndex((s) => !s.done);
        return open < 0 ? without.length : open;
      }
      const j = without.findIndex((s) => s.id === pos);
      return j < 0 ? -1 : j + 1;
    };
    switch (l.op) {
      case "complete_milestone":
        if (list[at].done) return `${list[at].name} is already done`;
        list[at].done = true;
        return list;
      case "skip_milestone":
        if (list.length <= 1) return "a project needs at least one milestone";
        list.splice(at, 1);
        return list;
      case "milestone_owner":
        list[at].owner = l.owner ?? null;
        return list;
      case "milestone_due":
        list[at].dueDate = l.dueDate ?? "";
        return list;
      case "move_milestone": {
        const [s] = list.splice(at, 1);
        const j = insertAt(l.position, list);
        if (j < 0) return "can't find where to move it";
        list.splice(j, 0, s);
        return list;
      }
      case "add_milestone": {
        const j = insertAt(l.position, list);
        if (j < 0) return "can't find where to add it";
        list.splice(j, 0, { id: null, name: l.name ?? "", dueDate: l.dueDate ?? "", done: false, sourceTemplateId: null, owner: l.owner ?? null });
        return list;
      }
      default:
        return "not a milestone change";
    }
  }

  /** Same plan, ignoring ids (a step added by the AI has no id until saved). */
  static sameSteps(a: readonly MilestoneDraft[], b: readonly MilestoneDraft[]): boolean {
    const k = (s: MilestoneDraft) => `${s.name.trim().toLowerCase()}|${s.dueDate || ""}|${s.done}|${s.owner ?? ""}`;
    return a.length === b.length && a.every((s, i) => k(s) === k(b[i]));
  }

  /** Before-values for restoring a list: ids no longer stored become new steps (a removed step comes back as new). */
  static restorable(before: readonly MilestoneDraft[], storedIds: ReadonlySet<string>): MilestoneDraft[] {
    return before.map((s) => ({ ...s, id: s.id && storedIds.has(s.id) ? s.id : null }));
  }

  /** The value as the normal project save takes it for a set_field line. */
  static patch(field: AiActionField, value: string): Record<string, string | boolean | null> {
    switch (field) {
      case "requester":
        return value === "Not applicable" ? { requesterNotApplicable: true } : { physicianChampion: value || null };
      case "department":
        return { serviceArea: value || null };
      default:
        return { [field]: value === "" ? null : value };
    }
  }

  /** Long note text is fine to store (the normal save checks the cap again). */
  static readonly NOTE_MAX = AppConfig.NOTE_MAX_LENGTH;
}
