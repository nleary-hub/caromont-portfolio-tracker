import type { PrismaClient } from "@/generated/prisma/client";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLineAccess, ServiceLineAccessError } from "@/lib/access/ServiceLineAccess";
import { ProjectEditPolicy } from "@/lib/access/ProjectEditPolicy";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ProjectRows } from "@/lib/domain/ProjectRows";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { Permissions } from "@/lib/permissions/Permissions";
import type { GateUser } from "@/lib/permissions/RoleResolver";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { OwnerNamesService } from "@/lib/services/OwnerNamesService";
import { ProjectDependencyService, BlockerInputError, DependencyAccessError, DependencyRuleError } from "@/lib/services/ProjectDependencyService";
import { ProjectHistoryForms } from "@/lib/services/ProjectHistoryForms";
import { MilestoneError, ProjectArchivedError, ProjectNotFoundError, ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidationError, type ProjectInput } from "@/lib/validation/ProjectValidator";

/** A refusal or problem whose message is safe to show to the person (through Claude). */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpToolError";
  }
}

export interface McpToolContext {
  viewer: GateUser;
  scope: ServiceLineScope;
  lines: ServiceLineScope[];
  db: PrismaClient;
}

/** Statuses by the words people use ("on track", "OnTrack", "at-risk"). */
const STATUS_WORDS: Record<string, ProjectStatus> = Object.fromEntries(
  ProjectStatusInfo.all().flatMap((s) => [
    [s.toLowerCase(), s],
    [ProjectStatusInfo.label(s).toLowerCase().replace(/[^a-z]/g, ""), s],
  ]),
);

export type MilestoneAction =
  | { action: "complete"; milestone: string }
  | { action: "reopen"; milestone: string }
  | { action: "add"; name: string; dueDate?: string | null; owner?: string | null; position?: "next" | "end" }
  | { action: "rename"; milestone: string; name: string }
  | { action: "set_due_date"; milestone: string; dueDate: string | null }
  | { action: "set_owner"; milestone: string; owner: string | null }
  | { action: "remove"; milestone: string };

export interface ProjectChanges {
  name?: string;
  status?: string;
  percentComplete?: number | null;
  latestUpdate?: string;
  accomplishment?: string;
  description?: string;
  inforRequestNumber?: string | null;
  department?: string | null;
  startDate?: string;
  completedOn?: string | null;
}

/**
 * The Claude connector's tools over the core project services, never the in-app AI layer. Every write is the same
 * service call the drawer makes for the same manual edit (ProjectService.saveForm, saveMilestones, setPeopleField,
 * createFromForm; ProjectDependencyService for blockers), so validation, permissions, the completion rule, Changed
 * flags and History all behave exactly as in the app. History rows carry SOURCE ("ai:claude_connector"), shown as
 * "Claude connector" on the timeline. Reads use the viewer's line and department access.
 */
export class McpProjectTools {
  static readonly SOURCE = `${UpdateTimeline.AI_PREFIX}claude_connector`;
  static readonly LIST_MAX = 200;

  /** The viewer's line: the one named (id, short name or name) when they may use it, else their active line. */
  static async context(viewer: GateUser, serviceLine: string | undefined, db: PrismaClient = Db.client): Promise<McpToolContext> {
    const lines = await ServiceLineAccess.usableLines(viewer, db);
    let scope: ServiceLineScope;
    if (serviceLine?.trim()) {
      const want = serviceLine.trim().toLowerCase();
      const line = lines.find((l) => l.id === serviceLine.trim() || l.shortName.toLowerCase() === want || l.name.toLowerCase() === want);
      if (!line) throw new McpToolError(`Service line "${serviceLine}" is not one you can use. Yours: ${lines.map((l) => l.shortName).join(", ") || "none"}.`);
      scope = viewer.isAdmin ? line : await DepartmentAccess.apply(viewer, line, db);
    } else {
      scope = await ServiceLineAccess.activeFor(viewer, db);
    }
    return { viewer, scope, lines, db };
  }

  // ---------- helpers ----------

  private static date(d: Date | null | undefined): string | null {
    return DateOnly.fromDbDate(d ?? null);
  }

  private static department(scope: ServiceLineScope, key: string | null | undefined): string | null {
    return key ? (scope.departments.find((d) => d.id === key)?.name ?? null) : null;
  }

  /** A department by id, name or short name (open departments of the line); null clears it. */
  private static departmentKey(scope: ServiceLineScope, raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined || raw.trim() === "") return null;
    const want = raw.trim().toLowerCase();
    const d = scope.departments.find((x) => !x.archived && !x.deleted && (x.id === raw.trim() || x.name.toLowerCase() === want || x.shortName.toLowerCase() === want));
    if (!d) throw new McpToolError(`Unknown department "${raw}". Choose one of: ${McpProjectTools.departmentNames(scope).join(", ")}.`);
    return d.id;
  }

  private static departmentNames(scope: ServiceLineScope): string[] {
    return scope.departments.filter((d) => !d.archived && !d.deleted).map((d) => d.name);
  }

  static status(raw: string): ProjectStatus {
    const s = STATUS_WORDS[raw.trim().toLowerCase().replace(/[^a-z]/g, "")] ?? STATUS_WORDS[raw.trim().toLowerCase()];
    if (!s) throw new McpToolError(`Unknown status "${raw}". Use one of: ${ProjectStatusInfo.all().map((x) => ProjectStatusInfo.label(x)).join(", ")}.`);
    return s;
  }

  private static require(c: McpToolContext, key: Parameters<typeof Permissions.can>[1], what: string): void {
    if (!Permissions.can(c.viewer, key)) throw new McpToolError(`Your role does not allow ${what}.`);
  }

  /** Turns service errors into messages the person can act on. Anything unexpected is logged and stays generic. */
  static explain(e: unknown): McpToolError {
    if (e instanceof McpToolError) return e;
    if (e instanceof ProjectValidationError) {
      const lines = Object.entries(e.errors).map(([field, msgs]) => `${field}: ${(msgs ?? []).join(" ")}`);
      return new McpToolError(`Not saved. ${lines.join(" | ")}`);
    }
    if (e instanceof ProjectNotFoundError || e instanceof ProjectArchivedError || e instanceof DependencyAccessError) {
      return new McpToolError("Project not found in this service line, or it was deleted.");
    }
    if (e instanceof AdminRequiredError) return new McpToolError("Your role does not allow that change.");
    if (e instanceof ServiceLineAccessError) return new McpToolError("You don't have access to a service line in the tracker. Ask an admin to add you (Admin > People > Access).");
    if (e instanceof BlockerInputError || e instanceof DependencyRuleError || e instanceof MilestoneError) return new McpToolError(e.message);
    console.error("Claude connector tool failed", (e as Error)?.name, (e as Error)?.message);
    return new McpToolError("Could not complete that. Nothing further was changed.");
  }

  private static async row(c: McpToolContext, projectId: string) {
    const found = await c.db.project.findUnique({ where: { id: projectId } }).catch(() => null);
    if (!found || found.archivedAt || !ServiceLineAccess.inScope(found, c.scope) || !DepartmentAccess.allows(c.scope, found.departmentId)) {
      throw new McpToolError("Project not found in this service line, or it was deleted.");
    }
    return ProjectRows.fromDb(found);
  }

  private static summary(c: McpToolContext, p: ReturnType<typeof ProjectRows.fromDb<Record<string, unknown> & { departmentId?: string | null }>> & Record<string, unknown>) {
    const due = p.dueDate instanceof Date ? McpProjectTools.date(p.dueDate) : null;
    return {
      id: p.id as string,
      name: p.name as string,
      status: ProjectStatusInfo.label(p.status as ProjectStatus),
      department: McpProjectTools.department(c.scope, p.serviceArea),
      owner: (p.owner as string | null) ?? null,
      nextMilestone: (p.nextMilestone as string | null) ?? null,
      dueDate: due,
      overdue: Boolean(due && !ProjectStatusInfo.isClosed(p.status as ProjectStatus) && DateOnly.compare(due, DateOnly.today()) < 0),
      percentComplete: (p.percentComplete as number | null) ?? null,
      updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : null,
    };
  }

  // ---------- reads ----------

  static async whoami(c: McpToolContext) {
    return {
      email: c.viewer.email,
      name: c.viewer.name ?? null,
      role: c.viewer.roleId,
      serviceLine: { id: c.scope.id, name: c.scope.name, shortName: c.scope.shortName },
      otherServiceLines: c.lines.filter((l) => l.id !== c.scope.id).map((l) => ({ id: l.id, name: l.name, shortName: l.shortName })),
      departments: McpProjectTools.departmentNames(c.scope),
      statuses: ProjectStatusInfo.all().map((s) => ProjectStatusInfo.label(s)),
      people: { owners: c.scope.owners, requesters: c.scope.requesters, contractsLeads: c.scope.contractsLeads },
      can: {
        view: Permissions.can(c.viewer, "project.view"),
        edit: ProjectEditPolicy.canEditLine(c.viewer),
        changeStatus: Permissions.can(c.viewer, "status.change"),
        create: Permissions.can(c.viewer, "project.create"),
        editBlockers: Permissions.can(c.viewer, "project.edit"),
      },
    };
  }

  static async listProjects(
    c: McpToolContext,
    args: { query?: string; status?: string[]; department?: string; owner?: string; includeClosed?: boolean; overdueOnly?: boolean; limit?: number },
  ) {
    McpProjectTools.require(c, "project.view", "viewing projects");
    const rows = ProjectRows.fromDbAll(await c.db.project.findMany({ where: { ...ServiceLineAccess.projectWhere(c.scope), archivedAt: null }, orderBy: { name: "asc" } }));
    const statuses = args.status?.length ? new Set(args.status.map((s) => McpProjectTools.status(s))) : null;
    const dept = args.department ? McpProjectTools.departmentKey(c.scope, args.department) : undefined;
    const q = args.query?.trim().toLowerCase();
    const owner = args.owner?.trim().toLowerCase();
    const list = rows
      .filter((p) => (statuses ? statuses.has(p.status) : args.includeClosed || !ProjectStatusInfo.isClosed(p.status)))
      .filter((p) => dept === undefined || p.serviceArea === dept)
      .filter((p) => !owner || (p.owner ?? "").toLowerCase().includes(owner))
      .filter((p) => {
        if (!q) return true;
        const hay = [p.name, p.description, p.owner, p.physicianChampion, p.nextMilestone, p.note, p.inforRequestNumber ? `REQ-${p.inforRequestNumber}` : null, McpProjectTools.department(c.scope, p.serviceArea)];
        return hay.some((h) => typeof h === "string" && h.toLowerCase().includes(q));
      })
      .map((p) => McpProjectTools.summary(c, p as never))
      .filter((p) => !args.overdueOnly || p.overdue);
    const limit = Math.min(Math.max(1, args.limit ?? 100), McpProjectTools.LIST_MAX);
    return { serviceLine: c.scope.shortName, total: list.length, shown: Math.min(limit, list.length), projects: list.slice(0, limit) };
  }

  static async getProject(c: McpToolContext, projectId: string) {
    McpProjectTools.require(c, "project.view", "viewing projects");
    const p = await McpProjectTools.row(c, projectId);
    const steps = await MilestoneService.stepsFor(c.db, p.id);
    const deps = await ProjectDependencyService.view(c.viewer, c.scope, p.id, c.db, { readOnly: true }).catch(() => null);
    const history = await ProjectHistoryForms.load(c.viewer, p.id, c.scope, c.db);
    return {
      ...McpProjectTools.summary(c, p as never),
      description: p.description ?? null,
      latestUpdate: p.note ?? null,
      accomplishment: p.accomplishment ?? null,
      requester: p.requesterNotApplicable ? "Not applicable" : (p.physicianChampion ?? null),
      contractsLead: p.contractsLeadNotApplicable ? "Not applicable" : (p.contractsLead ?? null),
      leadRole: p.leadRole ?? null,
      inforRequestNumber: p.inforRequestNumber ? `REQ-${p.inforRequestNumber}` : null,
      startDate: McpProjectTools.date(p.startDate),
      targetCompletion: McpProjectTools.date(p.targetCompletion),
      completedOn: McpProjectTools.date(p.completedOn),
      canEdit: ProjectEditPolicy.canEdit(c.viewer, c.scope, p),
      milestones: steps.map((s) => {
        const d = MilestoneService.toDto(s);
        return { id: d.id, name: d.name, dueDate: d.dueDate, done: d.done, doneOn: d.doneAt, owner: d.owner };
      }),
      blockers: (deps?.blockers ?? []).map((b) => ({ id: b.id, description: b.description, waitingOn: b.waitingOn, since: b.since, followUpOn: b.followUpOn, followUpOwner: b.followUpOwner, milestone: b.milestone?.name ?? null })),
      blockedBy: (deps?.blockedBy ?? []).map((d) => ({ projectId: d.project.id, name: d.project.name, note: d.note })),
      blocking: (deps?.blocking ?? []).map((d) => ({ projectId: d.project.id, name: d.project.name })),
      recentHistory: (history?.entries ?? []).slice(0, 10).map((e) => `${e.meta}: ${e.text}`),
    };
  }

  static async projectHistory(c: McpToolContext, projectId: string, limit = 30) {
    McpProjectTools.require(c, "project.view", "viewing projects");
    await McpProjectTools.row(c, projectId);
    const t = await ProjectHistoryForms.load(c.viewer, projectId, c.scope, c.db);
    if (!t) throw new McpToolError("Could not load the history.");
    const n = Math.min(Math.max(1, limit), 200);
    return {
      changes: t.entries.slice(0, n).map((e) => ({ when: e.meta, change: e.text, ...(e.ai ? { source: "AI" } : {}) })),
      updateNotes: t.notes.slice(0, n).map((x) => ({ when: x.meta, by: x.who, text: x.text })),
    };
  }

  // ---------- writes ----------

  /** The drawer's Save (one history entry): any of the form fields, with the same validation and rules. */
  static async updateProject(c: McpToolContext, projectId: string, changes: ProjectChanges) {
    const p = await McpProjectTools.row(c, projectId);
    if (!ProjectEditPolicy.canEdit(c.viewer, c.scope, p)) throw new McpToolError("You can't edit this project.");
    const values: Partial<ProjectInput> & { isMfi?: boolean } = {};
    if (changes.name !== undefined) values.name = changes.name;
    if (changes.status !== undefined) {
      const s = McpProjectTools.status(changes.status);
      if (s === "Complete" && p.status !== "Complete") throw new McpToolError("A project completes when its last milestone is checked. Use update_milestones to complete the remaining milestones.");
      values.status = s;
    }
    if (changes.percentComplete !== undefined) values.percentComplete = changes.percentComplete as never;
    if (changes.latestUpdate !== undefined) values.note = changes.latestUpdate;
    if (changes.accomplishment !== undefined) values.accomplishment = changes.accomplishment;
    if (changes.description !== undefined) values.description = changes.description;
    if (changes.inforRequestNumber !== undefined) values.inforRequestNumber = (changes.inforRequestNumber ? String(changes.inforRequestNumber).replace(/^REQ-?/i, "") : null) as never;
    if (changes.department !== undefined) values.serviceArea = McpProjectTools.departmentKey(c.scope, changes.department) as never;
    if (changes.completedOn !== undefined) values.completedOn = changes.completedOn as never;
    if (changes.startDate !== undefined) values.startDate = changes.startDate as never;
    if (!Object.keys(values).length) throw new McpToolError("No changes given.");
    try {
      await ProjectService.saveForm(p.id, values, c.viewer, c.db, null, c.scope, McpProjectTools.SOURCE);
    } catch (e) {
      throw McpProjectTools.explain(e);
    }
    return McpProjectTools.getProject(c, p.id);
  }

  /** People fields (the drawer's People editor), one at a time. Names must be on the line's lists. */
  static async setPerson(c: McpToolContext, projectId: string, field: "owner" | "requester" | "contractsLead" | "leadRole", value: string | null) {
    const p = await McpProjectTools.row(c, projectId);
    if (!ProjectEditPolicy.canEdit(c.viewer, c.scope, p)) throw new McpToolError("You can't edit this project.");
    try {
      const notApplicable = typeof value === "string" && /^not applicable$|^n\/?a$/i.test(value.trim());
      if (field === "requester" && notApplicable) {
        await ProjectService.setPeopleField(p.id, "requesterNotApplicable", "true", c.viewer, c.db, c.scope, McpProjectTools.SOURCE);
      } else if (field === "contractsLead" && notApplicable) {
        await ProjectService.setPeopleField(p.id, "contractsLeadNotApplicable", "true", c.viewer, c.db, c.scope, McpProjectTools.SOURCE);
      } else {
        const target = field === "requester" ? "physicianChampion" : field;
        let text = (value ?? "").trim();
        if (target === "owner" || target === "physicianChampion") text = await OwnerNamesService.savedSpelling(c.scope, text, c.db);
        await ProjectService.setPeopleField(p.id, target, text, c.viewer, c.db, c.scope, McpProjectTools.SOURCE);
      }
    } catch (e) {
      throw McpProjectTools.explain(e);
    }
    return McpProjectTools.getProject(c, p.id);
  }

  /** Finds one step by id or by name (case-insensitive). Refuses an unknown or ambiguous name. */
  private static stepIndex(drafts: MilestoneDraft[], ref: string): number {
    const byId = drafts.findIndex((d) => d.id === ref);
    if (byId >= 0) return byId;
    const want = ref.trim().toLowerCase();
    const hits = drafts.map((d, i) => (d.name.trim().toLowerCase() === want ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return hits[0];
    const near = drafts.map((d, i) => (d.name.toLowerCase().includes(want) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 0 && near.length === 1) return near[0];
    if (hits.length > 1 || near.length > 1) throw new McpToolError(`More than one milestone matches "${ref}". Use its id.`);
    throw new McpToolError(`No milestone named "${ref}". Milestones: ${drafts.map((d) => d.name).join(", ") || "none"}.`);
  }

  private static iso(raw: string | null | undefined): string {
    if (raw === null || raw === undefined || raw === "") return "";
    if (!DateOnly.isIso(raw)) throw new McpToolError(`Dates must be YYYY-MM-DD (got "${raw}").`);
    return raw;
  }

  /** The drawer's checklist: the full list with the actions applied, saved in one go (one history row per action). */
  static async updateMilestones(c: McpToolContext, projectId: string, actions: MilestoneAction[]) {
    const p = await McpProjectTools.row(c, projectId);
    if (!ProjectEditPolicy.canEdit(c.viewer, c.scope, p)) throw new McpToolError("You can't edit this project.");
    if (!actions.length) throw new McpToolError("No milestone actions given.");
    const steps = await MilestoneService.stepsFor(c.db, p.id);
    const drafts: MilestoneDraft[] = steps.map((s) => ({
      id: s.id,
      name: s.name,
      dueDate: McpProjectTools.date(s.dueDate) ?? "",
      done: s.done,
      sourceTemplateId: s.sourceTemplateId ?? null,
      owner: s.owner ?? null,
    }));
    for (const a of actions) {
      switch (a.action) {
        case "complete":
          drafts[McpProjectTools.stepIndex(drafts, a.milestone)].done = true;
          break;
        case "reopen":
          drafts[McpProjectTools.stepIndex(drafts, a.milestone)].done = false;
          break;
        case "rename":
          drafts[McpProjectTools.stepIndex(drafts, a.milestone)].name = a.name;
          break;
        case "set_due_date":
          drafts[McpProjectTools.stepIndex(drafts, a.milestone)].dueDate = McpProjectTools.iso(a.dueDate);
          break;
        case "set_owner":
          drafts[McpProjectTools.stepIndex(drafts, a.milestone)].owner = a.owner?.trim() ? a.owner.trim() : null;
          break;
        case "remove":
          drafts.splice(McpProjectTools.stepIndex(drafts, a.milestone), 1);
          break;
        case "add": {
          const step: MilestoneDraft = { id: null, name: a.name, dueDate: McpProjectTools.iso(a.dueDate), done: false, sourceTemplateId: null, owner: a.owner?.trim() ? a.owner.trim() : null };
          const firstOpen = drafts.findIndex((d) => !d.done);
          if (a.position === "next" && firstOpen >= 0) drafts.splice(firstOpen, 0, step);
          else drafts.push(step);
          break;
        }
        default:
          throw new McpToolError(`Unknown milestone action "${(a as { action: string }).action}".`);
      }
    }
    try {
      const { edit, scope } = await OwnerNamesService.prepareMilestones(c.scope, { drafts, applied: null }, c.viewer, c.db);
      await ProjectService.saveMilestones(p.id, edit ?? { drafts }, c.viewer, c.db, scope, McpProjectTools.SOURCE);
    } catch (e) {
      throw McpProjectTools.explain(e);
    }
    return McpProjectTools.getProject(c, p.id);
  }

  private static async milestoneId(c: McpToolContext, projectId: string, ref: string | undefined): Promise<string | undefined> {
    if (!ref?.trim()) return undefined;
    const steps = (await MilestoneService.stepsFor(c.db, projectId)).filter((s) => !s.done);
    const drafts = steps.map((s) => ({ id: s.id, name: s.name, dueDate: "", done: false, sourceTemplateId: null }));
    return steps[McpProjectTools.stepIndex(drafts, ref)].id;
  }

  static async addBlocker(c: McpToolContext, projectId: string, input: { description: string; waitingOn: string; followUpOn?: string; followUpOwner?: string; milestone?: string }) {
    const p = await McpProjectTools.row(c, projectId);
    try {
      await ProjectDependencyService.addBlocker(
        c.viewer,
        c.scope,
        p.id,
        { description: input.description, waitingOn: input.waitingOn, followUpOn: input.followUpOn ?? null, followUpOwner: input.followUpOwner ?? null, blockedMilestoneId: await McpProjectTools.milestoneId(c, p.id, input.milestone) },
        c.db,
        new Date(),
        McpProjectTools.SOURCE,
      );
    } catch (e) {
      throw McpProjectTools.explain(e);
    }
    return McpProjectTools.getProject(c, p.id);
  }

  static async updateBlocker(c: McpToolContext, projectId: string, blockerId: string, input: { description?: string; waitingOn?: string; followUpOn?: string | null; followUpOwner?: string | null }) {
    const p = await McpProjectTools.row(c, projectId);
    const view = await ProjectDependencyService.view(c.viewer, c.scope, p.id, c.db, { readOnly: true });
    const open = view.blockers.find((b) => b.id === blockerId);
    if (!open) throw new McpToolError("That blocker is not open on this project.");
    try {
      await ProjectDependencyService.updateBlocker(
        c.viewer,
        c.scope,
        p.id,
        blockerId,
        {
          description: input.description ?? open.description,
          waitingOn: input.waitingOn ?? open.waitingOn,
          followUpOn: input.followUpOn !== undefined ? input.followUpOn : open.followUpOn,
          followUpOwner: input.followUpOwner !== undefined ? input.followUpOwner : open.followUpOwner,
          blockedMilestoneId: open.milestone?.id ?? null,
        },
        c.db,
        new Date(),
        McpProjectTools.SOURCE,
      );
    } catch (e) {
      throw McpProjectTools.explain(e);
    }
    return McpProjectTools.getProject(c, p.id);
  }

  static async resolveBlocker(c: McpToolContext, projectId: string, blockerId: string, resolution: string) {
    const p = await McpProjectTools.row(c, projectId);
    try {
      await ProjectDependencyService.resolveBlocker(c.viewer, c.scope, p.id, blockerId, resolution, c.db, new Date(), McpProjectTools.SOURCE);
    } catch (e) {
      throw McpProjectTools.explain(e);
    }
    return McpProjectTools.getProject(c, p.id);
  }

  /** The New project drawer: name and department required; milestones optional (otherwise the default one is added). */
  static async createProject(
    c: McpToolContext,
    input: { name: string; department: string; description?: string; latestUpdate?: string; status?: string; startDate?: string; milestones?: { name: string; dueDate?: string; owner?: string }[] },
  ) {
    McpProjectTools.require(c, "project.create", "creating projects");
    const values: Partial<ProjectInput> = {
      name: input.name,
      serviceArea: McpProjectTools.departmentKey(c.scope, input.department) as never,
      description: input.description ?? null,
      note: input.latestUpdate ?? null,
      status: input.status ? McpProjectTools.status(input.status) : "NotStarted",
      startDate: (input.startDate ?? DateOnly.today()) as never,
    };
    if (values.status === "Complete") throw new McpToolError("A new project can't start as Complete.");
    const drafts: MilestoneDraft[] = (input.milestones ?? []).map((m) => ({ id: null, name: m.name, dueDate: McpProjectTools.iso(m.dueDate), done: false, sourceTemplateId: null, owner: m.owner?.trim() ? m.owner.trim() : null }));
    try {
      const { edit, scope } = await OwnerNamesService.prepareMilestones(c.scope, drafts.length ? { drafts, applied: null } : null, c.viewer, c.db);
      const created = await ProjectService.createFromForm(values, c.viewer, c.db, edit, scope, McpProjectTools.SOURCE);
      return McpProjectTools.getProject(c, created.id);
    } catch (e) {
      throw McpProjectTools.explain(e);
    }
  }
}
