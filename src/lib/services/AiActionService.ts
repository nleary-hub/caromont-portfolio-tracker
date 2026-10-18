import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags, type AiLiveFeature, type AiToolFeature } from "@/lib/ai/AiFeatureFlags";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiToolsModel, type AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiActionTools } from "@/lib/ai/actions/AiActionTools";
import { AiActionModel, type AiActionField, type AiActionLine, type AiActionLists, type AiActionProject, type AiActionRefusal } from "@/lib/ai/actions/AiActionModel";
import { AiActionSearch } from "@/lib/ai/actions/AiActionSearch";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { OwnerNameLists } from "@/lib/people/OwnerNameLists";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { AiModelService } from "@/lib/services/AiModelService";
import type { AiToolsDb, AiToolUsageRow } from "@/lib/services/AiToolsService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { PortfolioContextService } from "@/lib/services/PortfolioContextService";

type Env = Record<string, string | undefined>;

/** The features that apply changes through the action layer (the history tag is "ai:<source>"). */
export type AiActionFeature = AiToolFeature | AiLiveFeature;
/** Where a change came from, for the history tag. "command" is the typed command bar (it runs as quick_capture). */
export type AiActionSource = AiActionFeature | "command";

/** How to put one applied line back (stored in ai_applies.lines). Values are in saved form. */
export type AiUndo =
  | { kind: "field"; field: AiActionField; before: string; after: string }
  | { kind: "steps"; before: MilestoneDraft[]; after: MilestoneDraft[] }
  | { kind: "reviewed"; at: string }
  | { kind: "blocker_added"; blockerId: string }
  | { kind: "blocker_updated"; blockerId: string; before: AiBlockerFields; after: AiBlockerFields }
  | { kind: "dependency_added"; otherId: string }
  | { kind: "dependency_removed"; otherId: string; note: string | null }
  | { kind: "none"; why: string };

export interface AiBlockerFields {
  description: string;
  waitingOn: string;
  followUpOn: string | null;
  followUpOwner: string | null;
}

export interface AiAppliedLine {
  line: number;
  projectId: string;
  projectName: string;
  label: string;
  after: string;
  undo: AiUndo;
}

/**
 * The writes the action layer makes, each through the same service a manual edit uses (validation, permissions, history,
 * Changed). `comment` is the source tag on the history rows ("ai:voice_chat"). Tests pass an in-memory fake.
 */
export interface AiActionPorts {
  update(projectId: string, patch: Record<string, string | boolean | null>, comment: string): Promise<void>;
  people(projectId: string, field: "owner" | "physicianChampion" | "requesterNotApplicable" | "contractsLead" | "serviceArea", value: string, comment: string): Promise<void>;
  saveSteps(projectId: string, drafts: MilestoneDraft[], comment: string): Promise<void>;
  /** Returns the review time (ISO) or null when not allowed. */
  markReviewed(projectId: string): Promise<string | null>;
  undoReviewed(projectId: string, at: string): Promise<boolean>;
  addBlocker(projectId: string, input: AiBlockerFields, comment: string): Promise<string>;
  updateBlocker(projectId: string, blockerId: string, input: AiBlockerFields, comment: string): Promise<void>;
  resolveBlocker(projectId: string, blockerId: string, resolution: string, comment: string): Promise<void>;
  addDependency(projectId: string, blockedById: string, note: string | null, comment: string): Promise<void>;
  removeDependency(projectId: string, blockedById: string, comment: string): Promise<void>;
}

interface ProposalRow {
  id: string;
  serviceLineId: string;
  userEmail: string;
  feature: string;
  lines: unknown;
  createdAt: Date;
}

interface ApplyRow {
  id: string;
  proposalId: string;
  serviceLineId: string;
  userEmail: string;
  feature: string;
  lines: unknown;
  appliedAt: Date;
  undoneAt: Date | null;
  undoneBy: string | null;
}

/** The tables the action layer reads and writes (Prisma in the app; tests pass a fake). */
export interface AiActionDb extends AiToolsDb {
  aiProposal: {
    create(args: { data: Omit<ProposalRow, "lines"> & { lines: object } }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<ProposalRow | null>;
  };
  aiApply: {
    create(args: { data: Omit<ApplyRow, "lines" | "undoneAt" | "undoneBy"> & { lines: object } }): Promise<unknown>;
    findFirst(args: object): Promise<ApplyRow | null>;
    update(args: { where: { id: string }; data: { undoneAt: Date; undoneBy: string } }): Promise<unknown>;
  };
}

export type AiProposeResult = { ok: true; proposalId: string; lines: AiActionLine[]; refused: AiActionRefusal[]; summary: string } | { ok: false; message: string; refused?: AiActionRefusal[] };
export type AiApplyResult = { ok: true; applyId: string | null; applied: { line: number; text: string }[]; failed: { line: number; message: string }[]; summary: string } | { ok: false; message: string };
export type AiUndoResult = { ok: true; undone: string[]; skipped: string[]; summary: string } | { ok: false; message: string };

type Row = Record<string, unknown>;
const iso = (d: unknown): string | null => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : typeof d === "string" && d ? d.slice(0, 10) : null);

/**
 * Item B: the shared AI action layer. Voice chat, the command bar, quick capture, meeting notes and bulk edit all
 * propose through `propose` (checked against the stored project and the line's pick lists, never inventing a person)
 * and apply through `apply` after a person confirms (a click or a spoken yes). Every write goes through the normal
 * project services with a source tag on its history rows, so it is validated, permission-checked, logged and marks the
 * project Changed exactly like a manual edit. `undoLast` puts the last apply back the same way. Never touches
 * snapshots, PDFs, report_artifacts or handoff.json.
 */
export class AiActionService {
  /** Applies older than this can't be undone by voice or the command bar (use the drawer). */
  static readonly UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

  static tag(source: AiActionSource): string {
    return `ai:${source}`;
  }

  /** The line's pick lists plus the milestone owner names. */
  static async lists(db: unknown, scope: ServiceLineScope): Promise<AiActionLists> {
    const d = db as { milestoneOwnerName?: { findMany(a: object): Promise<{ name: string }[]> } };
    let extra: string[] = [];
    try {
      extra = d.milestoneOwnerName ? (await d.milestoneOwnerName.findMany({ where: { serviceLineId: scope.id }, select: { name: true } })).map((r) => r.name) : [];
    } catch {
      extra = [];
    }
    return {
      owners: PeopleDirectory.merge(scope.owners ?? []),
      requesters: PeopleDirectory.merge(scope.requesters ?? []),
      contractsLeads: PeopleDirectory.merge(scope.contractsLeads ?? []),
      stepOwners: OwnerNameLists.combined({ owners: scope.owners ?? [], requesters: scope.requesters ?? [], contractsLeads: scope.contractsLeads ?? [] }, PeopleDirectory.merge(extra)),
      departments: scope.departments ?? [],
    };
  }

  /** The listed projects (ref order) with what the checks need: people, steps, open blockers and dependencies. */
  static async load(db: unknown, scope: ServiceLineScope, projects: readonly AiToolProject[]): Promise<AiActionProject[]> {
    const d = db as Record<string, { findMany(a: object): Promise<Row[]> } | undefined>;
    const ids = projects.map((p) => p.id);
    const safe = async (fn: (() => Promise<Row[]>) | null) => {
      if (!fn) return [] as Row[];
      try {
        return await fn();
      } catch {
        return [] as Row[];
      }
    };
    const [rich, steps, blockers, deps] = await Promise.all([
      safe(ids.length && d.project ? () => d.project!.findMany({ where: { id: { in: ids } }, select: { id: true, owner: true, physicianChampion: true, requesterNotApplicable: true, contractsLead: true, departmentId: true } }) : null),
      safe(ids.length && d.projectMilestone ? () => d.projectMilestone!.findMany({ where: { projectId: { in: ids } }, orderBy: { position: "asc" } }) : null),
      safe(ids.length && d.projectBlocker ? () => d.projectBlocker!.findMany({ where: { serviceLineId: scope.id, resolvedAt: null, projectId: { in: ids } } }) : null),
      safe(d.projectDependency ? () => d.projectDependency!.findMany({ where: { serviceLineId: scope.id, removedAt: null } }) : null),
    ]);
    const byId = new Map(rich.map((r) => [String(r.id), r]));
    return projects.map((p) => {
      const r = byId.get(p.id) ?? {};
      const own = steps.filter((s) => s.projectId === p.id).sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
      return {
        id: p.id,
        name: p.name,
        status: p.status,
        nextMilestone: p.nextMilestone,
        dueDate: p.dueDate,
        targetCompletion: p.targetCompletion,
        note: p.note,
        owner: (r.owner as string | null) ?? null,
        requester: (r.physicianChampion as string | null) ?? null,
        requesterNotApplicable: Boolean(r.requesterNotApplicable),
        contractsLead: (r.contractsLead as string | null) ?? null,
        departmentId: (r.departmentId as string | null) ?? null,
        steps: own.map((s) => ({ id: String(s.id), name: String(s.name), dueDate: iso(s.dueDate) ?? "", done: Boolean(s.done), sourceTemplateId: (s.sourceTemplateId as string | null) ?? null, owner: (s.owner as string | null) ?? null })),
        blockers: blockers
          .filter((b) => b.projectId === p.id && b.id)
          .map((b) => ({ id: String(b.id), description: String(b.description ?? ""), waitingOn: String(b.waitingOn ?? ""), followUpOn: iso(b.followUpOn), followUpOwner: (b.followUpOwner as string | null) ?? null })),
        blockedBy: deps.filter((x) => x.projectId === p.id).map((x) => String(x.blockedById)),
        dependencyNotes: Object.fromEntries(deps.filter((x) => x.projectId === p.id).map((x) => [String(x.blockedById), (x.note as string | null) ?? null])),
      };
    });
  }

  private static guard(viewer: Viewer | null): { ok: false; message: string } | null {
    return viewer?.isAdmin ? null : { ok: false, message: AiCopy.NOT_AUTHORIZED };
  }

  /** search_projects: fuzzy match on name, REQ number, vendor (who a blocker waits on), department and owner. */
  static async search(args: { db: unknown; viewer: Viewer | null; scope: ServiceLineScope; projects: readonly AiToolProject[]; query: unknown; filters?: unknown }) {
    if (!args.viewer?.isAdmin) return { ok: false as const, message: AiCopy.NOT_AUTHORIZED };
    const built = await PortfolioContextService.build({ db: args.db, scope: args.scope, viewer: args.viewer, projects: args.projects });
    return { ok: true as const, results: AiActionSearch.run(built.input.projects, typeof args.query === "string" ? args.query : "", args.filters) };
  }

  /** get_project: one project's full context (people, every milestone, updates, blockers, flags). */
  static async get(args: { db: unknown; viewer: Viewer | null; scope: ServiceLineScope; projects: readonly AiToolProject[]; ref: unknown }) {
    if (!args.viewer?.isAdmin) return { ok: false as const, message: AiCopy.NOT_AUTHORIZED };
    const i = AiActionModel.byRef(args.ref, args.projects);
    if (i < 0) return { ok: false as const, message: "Unknown project ref." };
    const built = await PortfolioContextService.build({ db: args.db, scope: args.scope, viewer: args.viewer, projects: args.projects, maxTokens: Number.MAX_SAFE_INTEGER });
    const project = built.input.projects[i];
    return { ok: true as const, project: AiActionSearch.detail(project, i) };
  }

  /**
   * propose_changes: checks a model's change list and stores the checked lines for review. Saves nothing to projects.
   * One ai_proposals row and one "proposed" usage row (line count). Lines that fail a check come back as `refused`.
   */
  static async propose(args: {
    db: AiActionDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    feature: AiActionFeature;
    projects: readonly AiToolProject[];
    changes: unknown;
    meta?: { provider?: string | null; model?: string | null; suggestionId?: string };
    env?: Env;
    now?: Date;
  }): Promise<AiProposeResult> {
    const denied = AiActionService.guard(args.viewer);
    if (denied) return denied;
    const env = args.env ?? process.env;
    if (!(await AiModelService.featureOn(args.db, args.feature, env))) return { ok: false, message: AiToolsCopy.FEATURE_OFF };
    const state = await AiActionService.load(args.db, args.scope, args.projects);
    const lists = await AiActionService.lists(args.db, args.scope);
    const parsed = AiActionModel.parse(args.changes, state, lists);
    if (!parsed) return { ok: false, message: AiToolsCopy.PARSE_FAILED };
    if (!parsed.lines.length) return { ok: false, message: AiActionService.refusedText(parsed.refused), refused: parsed.refused };
    const now = args.now ?? new Date();
    const id = args.meta?.suggestionId ?? randomUUID();
    await args.db.aiProposal.create({ data: { id, serviceLineId: args.scope.id, userEmail: args.viewer!.email, feature: args.feature, lines: parsed.lines as unknown as object, createdAt: now } });
    await args.db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: id, userEmail: args.viewer!.email, projectId: parsed.lines.length === 1 ? parsed.lines[0].projectId : null, feature: args.feature, event: "proposed", provider: args.meta?.provider ?? null, model: args.meta?.model ?? null, inputLength: JSON.stringify(args.changes ?? "").length, outputLength: parsed.lines.length, numberCheckPassed: null, suggestedText: null, createdAt: now },
    });
    return { ok: true, proposalId: id, lines: parsed.lines, refused: parsed.refused, summary: AiActionModel.summary(parsed.lines) };
  }

  static refusedText(refused: readonly AiActionRefusal[]): string {
    if (!refused.length) return "No changes to make.";
    return `No changes to make: ${refused.slice(0, 3).map((r) => r.why).join("; ")}.`;
  }

  private static async proposal(db: AiActionDb, viewer: Viewer, scope: ServiceLineScope, proposalId: unknown): Promise<{ row: ProposalRow; lines: AiActionLine[]; feature: AiActionFeature } | null> {
    if (typeof proposalId !== "string" || !/^[0-9a-f-]{36}$/i.test(proposalId)) return null;
    const row = await db.aiProposal.findUnique({ where: { id: proposalId } });
    const feature = AiFeatureFlags.parseReviewableTool(row?.feature);
    if (!row || !feature || row.userEmail !== viewer.email || row.serviceLineId !== scope.id || !Array.isArray(row.lines)) return null;
    return { row, lines: row.lines as AiActionLine[], feature };
  }

  private static async closed(db: AiActionDb, viewer: Viewer, proposalId: string, line: number): Promise<boolean> {
    return Boolean(await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: { in: ["applied", "rejected"] }, lineIndex: line } }));
  }

  private static decision(db: AiActionDb, viewer: Viewer, proposalId: string, feature: string, event: "applied" | "rejected" | "undone", line: number, projectId: string | null, now: Date) {
    const data: AiToolUsageRow = { id: randomUUID(), suggestionId: proposalId, userEmail: viewer.email, projectId, feature, event, provider: null, model: null, inputLength: 0, outputLength: null, numberCheckPassed: null, suggestedText: null, unverifiedCount: null, lineIndex: line, createdAt: now };
    return db.aiUsageLog.create({ data });
  }

  private static pick(lines: readonly AiActionLine[], which: unknown): AiActionLine[] {
    if (which === "all" || which === undefined || which === null) return [...lines];
    const wanted = new Set((Array.isArray(which) ? which : [which]).map(Number).filter((n) => Number.isInteger(n)));
    return lines.filter((l) => wanted.has(l.line));
  }

  /** The saved-form value of a field now (the same form AiActionModel.check stores in `value`). */
  static saved(p: AiActionProject, field: AiActionField): string {
    switch (field) {
      case "requester":
        return p.requesterNotApplicable ? "Not applicable" : (p.requester ?? "");
      case "department":
        return p.departmentId ?? "";
      default:
        return (p[field] as string | null) ?? "";
    }
  }

  private static async setField(ports: AiActionPorts, projectId: string, field: AiActionField, value: string, comment: string): Promise<void> {
    if (field === "owner" || field === "contractsLead") return ports.people(projectId, field, value, comment);
    if (field === "department") return ports.people(projectId, "serviceArea", value, comment);
    if (field === "requester") return value === "Not applicable" ? ports.people(projectId, "requesterNotApplicable", "true", comment) : ports.people(projectId, "physicianChampion", value, comment);
    await ports.update(projectId, AiActionModel.patch(field, value), comment);
  }

  /** Runs one line against the project as stored now. Returns its undo record, or a plain-words error. */
  private static async run(l: AiActionLine, p: AiActionProject, ports: AiActionPorts, comment: string): Promise<AiUndo | string> {
    switch (l.op) {
      case "set_field": {
        const field = l.field!;
        const before = AiActionService.saved(p, field);
        await AiActionService.setField(ports, p.id, field, l.value ?? "", comment);
        return { kind: "field", field, before, after: l.value ?? "" };
      }
      case "complete_milestone":
      case "add_milestone":
      case "move_milestone":
      case "skip_milestone":
      case "milestone_owner":
      case "milestone_due": {
        const next = AiActionModel.planSteps(p.steps, l);
        if (typeof next === "string") return next;
        await ports.saveSteps(p.id, next, comment);
        return { kind: "steps", before: p.steps, after: next };
      }
      case "mark_reviewed": {
        const at = await ports.markReviewed(p.id);
        return at ? { kind: "reviewed", at } : "Not allowed to mark this project reviewed.";
      }
      case "add_blocker": {
        const id = await ports.addBlocker(p.id, { description: l.description!, waitingOn: l.waitingOn!, followUpOn: l.followUpOn ?? null, followUpOwner: l.followUpOwner ?? null }, comment);
        return { kind: "blocker_added", blockerId: id };
      }
      case "update_blocker": {
        const b = p.blockers.find((x) => x.id === l.blockerId);
        if (!b) return "That blocker is no longer open.";
        const after = { description: l.description!, waitingOn: l.waitingOn!, followUpOn: l.followUpOn ?? null, followUpOwner: l.followUpOwner ?? null };
        await ports.updateBlocker(p.id, b.id, after, comment);
        return { kind: "blocker_updated", blockerId: b.id, before: { description: b.description, waitingOn: b.waitingOn, followUpOn: b.followUpOn, followUpOwner: b.followUpOwner }, after };
      }
      case "resolve_blocker":
        await ports.resolveBlocker(p.id, l.blockerId!, l.resolution!, comment);
        return { kind: "none", why: "a resolved blocker stays resolved (add it again if needed)" };
      case "add_dependency":
        await ports.addDependency(p.id, l.otherId!, l.note ?? null, comment);
        return { kind: "dependency_added", otherId: l.otherId! };
      case "remove_dependency":
        await ports.removeDependency(p.id, l.otherId!, comment);
        return { kind: "dependency_removed", otherId: l.otherId!, note: p.dependencyNotes?.[l.otherId!] ?? null };
    }
  }

  /** Plain words for a failed write (validation messages pass through; anything else is generic). */
  static failure(e: unknown): string {
    const err = e as { errors?: Record<string, string[]>; message?: string; name?: string };
    if (err?.errors && typeof err.errors === "object") return Object.values(err.errors).flat()[0] ?? AiToolsCopy.APPLY_FAILED;
    if (err?.name && /Rule|Input|Milestone/.test(err.name) && err.message) return err.message;
    return AiToolsCopy.APPLY_FAILED;
  }

  /**
   * apply_changes: only after the person confirmed. Applies the chosen open lines of their own proposal, one at a time,
   * each through the normal service against the project as stored now. One "applied" usage row per line and one
   * ai_applies row (the undo record) per call.
   */
  static async apply(args: {
    db: AiActionDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    proposalId: unknown;
    lines?: unknown;
    ports: AiActionPorts;
    /** Ref order of the line's projects (to read the stored state). */
    projects: readonly AiToolProject[];
    source?: AiActionSource;
    env?: Env;
    now?: () => Date;
  }): Promise<AiApplyResult> {
    const denied = AiActionService.guard(args.viewer);
    if (denied) return denied;
    const viewer = args.viewer!;
    const now = args.now ?? (() => new Date());
    const found = await AiActionService.proposal(args.db, viewer, args.scope, args.proposalId);
    if (!found) return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    if (!(await AiModelService.featureOn(args.db, found.feature, args.env ?? process.env))) return { ok: false, message: AiToolsCopy.FEATURE_OFF };
    const comment = AiActionService.tag(args.source ?? found.feature);
    const applied: AiAppliedLine[] = [];
    const out: { line: number; text: string }[] = [];
    const failed: { line: number; message: string }[] = [];
    for (const l of AiActionService.pick(found.lines, args.lines)) {
      if (await AiActionService.closed(args.db, viewer, found.row.id, l.line)) continue;
      const listed = args.projects.find((p) => p.id === l.projectId);
      if (!listed) {
        failed.push({ line: l.line, message: AiCopy.PROJECT_GONE });
        continue;
      }
      // Fresh state per line: an earlier line of this apply may have changed the same project.
      const fresh = await AiToolsService.projects(args.db, args.scope, l.projectId);
      if (!fresh.length) {
        failed.push({ line: l.line, message: AiCopy.PROJECT_GONE });
        continue;
      }
      const [p] = await AiActionService.load(args.db, args.scope, fresh);
      let undo: AiUndo | string;
      try {
        undo = await AiActionService.run(l, p, args.ports, comment);
      } catch (e) {
        console.error("AI actions: apply failed", (e as Error)?.name);
        undo = AiActionService.failure(e);
      }
      if (typeof undo === "string") {
        failed.push({ line: l.line, message: undo });
        continue;
      }
      await AiActionService.decision(args.db, viewer, found.row.id, found.feature, "applied", l.line, l.projectId, now());
      applied.push({ line: l.line, projectId: l.projectId, projectName: l.projectName, label: l.label, after: l.after, undo });
      out.push({ line: l.line, text: `${l.label}: ${l.after || "done"} (${l.projectName})` });
    }
    let applyId: string | null = null;
    if (applied.length) {
      applyId = randomUUID();
      await args.db.aiApply.create({ data: { id: applyId, proposalId: found.row.id, serviceLineId: args.scope.id, userEmail: viewer.email, feature: found.feature, lines: applied as unknown as object, appliedAt: now() } });
    }
    const summary = applied.length ? `Applied ${applied.length} change${applied.length === 1 ? "" : "s"}${failed.length ? `; ${failed.length} not applied` : ""}.` : failed.length ? `Nothing applied: ${failed[0].message}` : "Nothing left to apply.";
    return { ok: true, applyId, applied: out, failed, summary };
  }

  /** Reject lines of a proposal: one "rejected" usage row each. Nothing changes. */
  static async reject(args: { db: AiActionDb; viewer: Viewer | null; scope: ServiceLineScope; proposalId: unknown; lines?: unknown; now?: Date }): Promise<{ ok: true; rejected: number } | { ok: false; message: string }> {
    const denied = AiActionService.guard(args.viewer);
    if (denied) return denied;
    const found = await AiActionService.proposal(args.db, args.viewer!, args.scope, args.proposalId);
    if (!found) return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    let n = 0;
    for (const l of AiActionService.pick(found.lines, args.lines)) {
      if (await AiActionService.closed(args.db, args.viewer!, found.row.id, l.line)) continue;
      await AiActionService.decision(args.db, args.viewer!, found.row.id, found.feature, "rejected", l.line, l.projectId, args.now ?? new Date());
      n += 1;
    }
    return { ok: true, rejected: n };
  }

  /**
   * undo_last_apply: puts this person's most recent apply on this line back (within a day), newest line first, through
   * the same services with an "ai:undo" tag. A line whose value changed again since is left as is and reported.
   */
  static async undoLast(args: { db: AiActionDb; viewer: Viewer | null; scope: ServiceLineScope; ports: AiActionPorts; projects: readonly AiToolProject[]; now?: () => Date }): Promise<AiUndoResult> {
    const denied = AiActionService.guard(args.viewer);
    if (denied) return denied;
    const viewer = args.viewer!;
    const now = args.now ?? (() => new Date());
    const row = await args.db.aiApply.findFirst({ where: { userEmail: viewer.email, serviceLineId: args.scope.id, undoneAt: null, appliedAt: { gte: new Date(now().getTime() - AiActionService.UNDO_WINDOW_MS) } }, orderBy: { appliedAt: "desc" } });
    if (!row || !Array.isArray(row.lines)) return { ok: false, message: "Nothing to undo." };
    const comment = `${AiActionService.tag(row.feature as AiActionSource)}:undo`;
    const undone: string[] = [];
    const skipped: string[] = [];
    for (const l of [...(row.lines as AiAppliedLine[])].reverse()) {
      const listed = args.projects.find((p) => p.id === l.projectId);
      const [p] = listed ? await AiActionService.load(args.db, args.scope, (await AiToolsService.projects(args.db, args.scope, l.projectId)).slice(0, 1)) : [];
      const what = `${l.label} on ${l.projectName}`;
      if (!p) {
        skipped.push(`${what} (project not found)`);
        continue;
      }
      try {
        const r = await AiActionService.revert(l.undo, p, args.ports, comment);
        if (r === true) undone.push(what);
        else skipped.push(`${what} (${r})`);
      } catch (e) {
        console.error("AI actions: undo failed", (e as Error)?.name);
        skipped.push(`${what} (${AiActionService.failure(e)})`);
      }
    }
    await args.db.aiApply.update({ where: { id: row.id }, data: { undoneAt: now(), undoneBy: viewer.email } });
    for (const l of row.lines as AiAppliedLine[]) await AiActionService.decision(args.db, viewer, row.proposalId, row.feature, "undone", l.line, l.projectId, now());
    const summary = undone.length ? `Undid ${undone.length} change${undone.length === 1 ? "" : "s"}${skipped.length ? `; left ${skipped.length} as is` : ""}.` : `Nothing undone: ${skipped[0] ?? "no changes"}.`;
    return { ok: true, undone, skipped, summary };
  }

  private static async revert(u: AiUndo, p: AiActionProject, ports: AiActionPorts, comment: string): Promise<true | string> {
    switch (u.kind) {
      case "field": {
        if (AiActionService.saved(p, u.field) !== u.after) return "changed again since";
        if (u.field === "requester" && u.before !== "Not applicable" && p.requesterNotApplicable) await ports.people(p.id, "requesterNotApplicable", "false", comment);
        await AiActionService.setField(ports, p.id, u.field, u.before, comment);
        return true;
      }
      case "steps": {
        if (!AiActionModel.sameSteps(p.steps, u.after)) return "milestones changed again since";
        const stored = new Set(p.steps.map((s) => s.id).filter((x): x is string => Boolean(x)));
        await ports.saveSteps(p.id, AiActionModel.restorable(u.before, stored), comment);
        return true;
      }
      case "reviewed":
        return (await ports.undoReviewed(p.id, u.at)) ? true : "reviewed again since";
      case "blocker_added":
        if (!p.blockers.some((b) => b.id === u.blockerId)) return "already resolved";
        await ports.resolveBlocker(p.id, u.blockerId, "Undone (added by mistake)", comment);
        return true;
      case "blocker_updated": {
        const b = p.blockers.find((x) => x.id === u.blockerId);
        if (!b) return "no longer open";
        if (b.description !== u.after.description || b.waitingOn !== u.after.waitingOn || b.followUpOn !== u.after.followUpOn || b.followUpOwner !== u.after.followUpOwner) return "changed again since";
        await ports.updateBlocker(p.id, u.blockerId, u.before, comment);
        return true;
      }
      case "dependency_added":
        if (!p.blockedBy.includes(u.otherId)) return "already removed";
        await ports.removeDependency(p.id, u.otherId, comment);
        return true;
      case "dependency_removed":
        if (p.blockedBy.includes(u.otherId)) return "already back";
        await ports.addDependency(p.id, u.otherId, u.note, comment);
        return true;
      case "none":
        return u.why;
    }
  }

  /**
   * Runs one tool call of the shared layer and returns what the model gets back (JSON text) plus what the screen needs
   * (the proposal to show, or that projects changed so the dashboard refreshes). Unknown tools and bad arguments come
   * back as {"ok":false,"error":...} for the model to explain.
   */
  static async runTool(args: {
    name: unknown;
    args: unknown;
    db: AiActionDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    feature: AiActionFeature;
    source?: AiActionSource;
    projects: readonly AiToolProject[];
    ports: AiActionPorts;
    meta?: { provider?: string | null; model?: string | null };
    env?: Env;
    now?: () => Date;
  }): Promise<{ output: string; proposal?: { proposalId: string; lines: AiActionLine[]; summary: string }; draft?: { proposalId: string; draft: unknown }; changed?: boolean }> {
    const out = (o: unknown) => JSON.stringify(o);
    let a: Record<string, unknown> = {};
    try {
      a = typeof args.args === "string" ? (args.args.trim() ? JSON.parse(args.args) : {}) : ((args.args as Record<string, unknown>) ?? {});
    } catch {
      return { output: out({ ok: false, error: "Arguments were not valid JSON." }) };
    }
    if (!AiActionTools.isName(args.name)) return { output: out({ ok: false, error: "Unknown tool." }) };
    const base = { db: args.db, viewer: args.viewer, scope: args.scope, projects: args.projects };
    switch (args.name) {
      case "search_projects":
        return { output: out(await AiActionService.search({ ...base, query: a.query, filters: a.filters })) };
      case "get_project":
        return { output: out(await AiActionService.get({ ...base, ref: a.ref })) };
      case "propose_changes":
      case "link_projects": {
        let changes: unknown = a.changes;
        if (args.name === "link_projects") {
          const l = AiActionTools.linkAsChange(a);
          if (!l.ok) return { output: out({ ok: false, error: l.why }) };
          changes = [l.change];
        }
        const r = await AiActionService.propose({ ...base, feature: args.feature, changes, meta: args.meta, env: args.env, now: args.now?.() });
        if (!r.ok) return { output: out({ ok: false, error: r.message, refused: r.refused ?? [] }) };
        const lines = r.lines.map((l) => ({ line: l.line, project: l.projectName, change: l.label, from: l.before, to: l.after }));
        return { output: out({ ok: true, proposalId: r.proposalId, lines, refused: r.refused, readBack: `${r.summary}. Apply?` }), proposal: { proposalId: r.proposalId, lines: r.lines, summary: r.summary } };
      }
      case "apply_changes": {
        const r = await AiActionService.apply({ ...base, proposalId: a.proposalId, lines: a.lines ?? "all", ports: args.ports, source: args.source, env: args.env, now: args.now });
        return { output: out(r), changed: r.ok && r.applied.length > 0 };
      }
      case "undo_last_apply": {
        const r = await AiActionService.undoLast({ ...base, ports: args.ports, now: args.now });
        return { output: out(r), changed: r.ok && r.undone.length > 0 };
      }
      case "draft_project": {
        if (!args.viewer?.isAdmin) return { output: out({ ok: false, error: AiCopy.NOT_AUTHORIZED }) };
        if (!(await AiModelService.featureOn(args.db, "request_to_project", args.env ?? process.env))) return { output: out({ ok: false, error: AiToolsCopy.FEATURE_OFF }) };
        const draft = AiToolsModel.cleanDraft(a);
        if (!draft) return { output: out({ ok: false, error: AiToolsCopy.DRAFT_INVALID }) };
        const id = randomUUID();
        await args.db.aiUsageLog.create({
          data: { id: randomUUID(), suggestionId: id, userEmail: args.viewer.email, projectId: null, feature: "request_to_project", event: "proposed", provider: args.meta?.provider ?? null, model: args.meta?.model ?? null, inputLength: JSON.stringify(a).length, outputLength: 1, numberCheckPassed: null, suggestedText: null, createdAt: args.now?.() ?? new Date() },
        });
        return { output: out({ ok: true, proposalId: id, draft, note: "Shown on screen for review; created only when the person confirms there." }), draft: { proposalId: id, draft } };
      }
    }
  }

}
