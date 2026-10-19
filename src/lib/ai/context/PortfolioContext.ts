import type { ProjectStatus } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { PortfolioSignals, type ProjectSignals } from "./PortfolioSignals";

export interface ContextMilestone {
  name: string;
  owner: string | null;
  due: string | null;
  done: boolean;
}

export interface ContextUpdate {
  /** "YYYY-MM-DD" the update was saved. */
  on: string;
  text: string;
}

/** An open Blocked-by dependency (the blocker is another project of the line the viewer can see). */
export interface ContextBlockerProject {
  id: string;
  name: string;
  status: ProjectStatus;
  note: string | null;
  since: string;
  days: number | null;
}

/** An open external blocker (vendor, committee, review). */
export interface ContextBlockerExternal {
  description: string;
  waitingOn: string;
  since: string;
  days: number | null;
  followUpOn: string | null;
  followUpOwner: string | null;
}

/** One project with everything the AI may read about it (spec A). Only facts from the database or computed in code. */
export interface ContextProject {
  id: string;
  name: string;
  reqNumber: number | null;
  department: string | null;
  description: string | null;
  isMfi: boolean;
  inReport: boolean;
  owner: string | null;
  /** Requester (the physicianChampion column): the physician champion or requesting leader. */
  requester: string | null;
  requesterNotApplicable: boolean;
  contractsLead: string | null;
  /** The current (next open) milestone's owner. */
  milestoneOwner: string | null;
  status: ProjectStatus;
  statusSince: string | null;
  nextMilestone: string | null;
  dueDate: string | null;
  targetCompletion: string | null;
  milestones: ContextMilestone[];
  latestUpdate: string | null;
  /** Up to 3 earlier Latest updates, newest first. */
  priorUpdates: ContextUpdate[];
  changedSinceReport: boolean;
  changedFields: string[];
  lastReviewed: string | null;
  signals: ProjectSignals;
  /** BlockerSignals flags as words ("due before its blocker", ...). */
  blockerFlags: string[];
  blockedBy: ContextBlockerProject[];
  blocking: { id: string; name: string }[];
  external: ContextBlockerExternal[];
}

export interface GlossaryEntry {
  term: string;
  definition: string | null;
}

export interface PortfolioContextInput {
  today: string;
  serviceLine: string;
  userName: string | null;
  roleTitle: string | null;
  glossary: readonly GlossaryEntry[];
  lastReportDate: string | null;
  /** In ref order: projects[i] is P(i+1). */
  projects: readonly ContextProject[];
}

export interface PortfolioContextResult {
  /** The header (date, service line, user, glossary): goes in every prompt. */
  header: string;
  /** One JSON object per project line, with its ref. */
  projects: string;
  /** Header and projects together, as one block. */
  text: string;
  /** Rough token count of `text` (characters / 4). */
  tokens: number;
  /** How the budget was met, in order (empty when nothing was cut). */
  cuts: string[];
  /** Projects left out entirely to meet the budget (their refs). */
  omitted: string[];
}

const TO_ASSIGN = "To assign";

/**
 * buildPortfolioContext (Tracker AI overhaul item A): the one context every AI feature reads. Pure: the loader
 * (PortfolioContextService) gathers the facts; this renders them as compact JSON lines within a token budget.
 * Truncation order: oldest prior updates first, then long descriptions, then done milestones, then closed projects
 * with no blockers, then long Latest updates, then projects from the end of the list. Refs stay P1..Pn so every reply
 * parser maps a ref back to the same project.
 */
export class PortfolioContext {
  /** Most projects in one context (a full service line). */
  static readonly MAX_PROJECTS = 500;
  /** Default budget in tokens (rough: characters / 4). */
  static readonly DEFAULT_TOKENS = 60_000;
  static readonly DESCRIPTION_CAP = 160;
  static readonly UPDATE_CAP = 600;
  static readonly PRIOR_UPDATES = 3;

  static ref(i: number): string {
    return `P${i + 1}`;
  }

  static tokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  static header(input: PortfolioContextInput): string {
    const lines = [`Today: ${input.today}`, `Service line: ${input.serviceLine}`];
    if (input.userName) lines.push(`User: ${input.userName}${input.roleTitle ? `, ${input.roleTitle}` : ""}`);
    if (input.lastReportDate) lines.push(`Last report frozen: ${input.lastReportDate}`);
    lines.push(`"${TO_ASSIGN}" means nobody is assigned. Never invent a name, date or number that is not in this data.`);
    const terms = input.glossary.filter((g) => g.term.trim());
    if (terms.length) {
      lines.push("Glossary:");
      for (const g of terms) lines.push(`- ${g.term}${g.definition?.trim() ? `: ${g.definition.trim()}` : " (no definition yet)"}`);
    }
    return lines.join("\n");
  }

  private static person(v: string | null | undefined): string {
    return v?.trim() ? v.trim() : TO_ASSIGN;
  }

  /** One project's JSON object (only keys with something to say, to save tokens). */
  static project(p: ContextProject, i: number, opts: { priorUpdates: number; descriptionCap: number | null; doneMilestones: boolean; updateCap: number | null }): Record<string, unknown> {
    const o: Record<string, unknown> = { ref: PortfolioContext.ref(i), name: p.name };
    if (p.reqNumber) o.req = `REQ-${p.reqNumber}`;
    o.department = p.department ?? "Unassigned";
    if (p.description) o.description = opts.descriptionCap && p.description.length > opts.descriptionCap ? `${p.description.slice(0, opts.descriptionCap)}...` : p.description;
    if (p.isMfi) o.mfi = true;
    if (!p.inReport) o.inReport = false;
    o.owner = PortfolioContext.person(p.owner);
    o.requester = p.requesterNotApplicable ? "Not applicable" : PortfolioContext.person(p.requester);
    o.contractsLead = PortfolioContext.person(p.contractsLead);
    o.status = ProjectStatusInfo.label(p.status);
    if (p.statusSince) o.statusSince = p.statusSince;
    if (p.signals.daysInStatus !== null) o.daysInStatus = p.signals.daysInStatus;
    if (p.nextMilestone) o.nextMilestone = p.nextMilestone;
    if (p.dueDate) o.dueDate = p.dueDate;
    if (p.targetCompletion) o.targetCompletion = p.targetCompletion;
    if (p.milestones.length) {
      const done = p.milestones.filter((m) => m.done).length;
      o.milestoneProgress = `${done} of ${p.milestones.length}`;
      o.milestoneOwner = PortfolioContext.person(p.milestoneOwner);
      const shown = opts.doneMilestones ? p.milestones : p.milestones.filter((m) => !m.done);
      o.milestones = shown.map((m) => {
        const x: Record<string, unknown> = { name: m.name, done: m.done };
        if (m.owner) x.owner = m.owner;
        if (m.due) x.due = m.due;
        return x;
      });
    }
    if (p.latestUpdate) o.latestUpdate = opts.updateCap && p.latestUpdate.length > opts.updateCap ? `${p.latestUpdate.slice(0, opts.updateCap)}...` : p.latestUpdate;
    const prior = p.priorUpdates.slice(0, opts.priorUpdates);
    if (prior.length) o.priorUpdates = prior.map((u) => ({ on: u.on, text: u.text }));
    o.changedSinceLastReport = p.changedSinceReport;
    if (p.changedFields.length) o.changedFields = p.changedFields;
    if (p.lastReviewed) o.lastReviewed = p.lastReviewed;
    const flags = [...PortfolioSignals.words(p.signals), ...p.blockerFlags];
    if (flags.length) o.flags = flags;
    if (p.blockedBy.length) o.blockedBy = p.blockedBy.map((b) => ({ project: b.name, status: ProjectStatusInfo.label(b.status), ...(b.note ? { waitingOn: b.note } : {}), since: b.since, ...(b.days !== null ? { daysBlocked: b.days } : {}) }));
    if (p.external.length)
      o.externalBlockers = p.external.map((b) => ({ waitingOn: b.waitingOn, what: b.description, since: b.since, ...(b.days !== null ? { daysBlocked: b.days } : {}), ...(b.followUpOn ? { followUpOn: b.followUpOn } : {}), ...(b.followUpOwner ? { followUpOwner: b.followUpOwner } : {}) }));
    if (p.blocking.length) o.blocking = p.blocking.map((b) => b.name);
    return o;
  }

  /** Renders the context within `maxTokens`, cutting in the documented order until it fits. */
  static build(input: PortfolioContextInput, maxTokens: number = PortfolioContext.DEFAULT_TOKENS): PortfolioContextResult {
    const header = PortfolioContext.header(input);
    const all = input.projects.slice(0, PortfolioContext.MAX_PROJECTS);
    const cuts: string[] = [];
    let opts = { priorUpdates: PortfolioContext.PRIOR_UPDATES, descriptionCap: null as number | null, doneMilestones: true, updateCap: null as number | null };
    let keep = all.map((_, i) => i);
    const render = () => keep.map((i) => JSON.stringify(PortfolioContext.project(all[i], i, opts))).join("\n");
    let body = render();
    const fits = () => PortfolioContext.tokens(header) + PortfolioContext.tokens(body) + 8 <= maxTokens;
    const step = (label: string, change: () => void) => {
      if (fits()) return;
      change();
      body = render();
      cuts.push(label);
    };
    for (let n = PortfolioContext.PRIOR_UPDATES - 1; n >= 0; n--) step(`prior updates cut to ${n}`, () => (opts = { ...opts, priorUpdates: n }));
    step("descriptions shortened", () => (opts = { ...opts, descriptionCap: PortfolioContext.DESCRIPTION_CAP }));
    step("done milestones left out", () => (opts = { ...opts, doneMilestones: false }));
    step("closed projects with no blockers left out", () => (keep = keep.filter((i) => !ProjectStatusInfo.isClosed(all[i].status) || all[i].blocking.length > 0 || all[i].blockedBy.length > 0)));
    step("latest updates shortened", () => (opts = { ...opts, updateCap: PortfolioContext.UPDATE_CAP }));
    while (!fits() && keep.length > 1) {
      keep = keep.slice(0, Math.max(1, Math.floor(keep.length * 0.9)));
      body = render();
      if (!cuts.includes("projects at the end of the list left out")) cuts.push("projects at the end of the list left out");
    }
    const kept = new Set(keep);
    const omitted = all.map((_, i) => i).filter((i) => !kept.has(i)).map(PortfolioContext.ref);
    const text = `${header}\nProjects (one JSON object per line; ref is the id to use):\n${body}`;
    return { header, projects: body, text, tokens: PortfolioContext.tokens(text), cuts, omitted };
  }
}
