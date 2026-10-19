import type { ProjectStatus } from "@/generated/prisma/enums";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { DisplayName } from "@/lib/auth/DisplayName";
import { PortfolioContext, type ContextProject, type GlossaryEntry, type PortfolioContextInput, type PortfolioContextResult } from "@/lib/ai/context/PortfolioContext";
import { PortfolioSignals, type ReportedState } from "@/lib/ai/context/PortfolioSignals";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import { DateOnly } from "@/lib/domain/DateOnly";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { BlockerSignals, type RowBlockers } from "@/lib/projects/BlockerSignals";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/** The project columns the context reads beyond the AI tools list. Every one optional: a test fake may return fewer. */
interface RichRow {
  id: string;
  inforRequestNumber?: number | null;
  departmentId?: string | null;
  description?: string | null;
  isMfi?: boolean | null;
  includeInReport?: boolean | null;
  hiddenFromReport?: boolean | null;
  owner?: string | null;
  physicianChampion?: string | null;
  requesterNotApplicable?: boolean | null;
  contractsLead?: string | null;
  reviewedAt?: Date | null;
  createdAt?: Date | null;
}

interface StepRow {
  projectId: string;
  name: string;
  dueDate: Date | null;
  done: boolean;
  position: number;
  owner: string | null;
}

interface HistoryRow {
  projectId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
}

type Finder<T> = { findMany(args: object): Promise<T[]> };

/** The optional Prisma delegates the loader reads (all read-only). A missing one reads as empty. */
interface ContextDb {
  project?: Finder<RichRow>;
  projectMilestone?: Finder<StepRow>;
  projectHistory?: Finder<HistoryRow>;
  reportSnapshot?: Finder<{ generatedAt: Date; rowsJson: unknown }>;
  projectDependency?: Finder<{ projectId: string; blockedById: string; createdAt: Date; note: string | null }>;
  projectBlocker?: Finder<{ projectId: string; description: string; waitingOn: string; since: Date; followUpOn: Date | null; followUpOwner: string | null }>;
  aiGlossaryTerm?: Finder<{ term: string; definition: string | null }>;
  aiContextSetting?: { findUnique(args: object): Promise<{ roleTitle: string | null } | null> };
  appUser?: { findUnique(args: object): Promise<{ name: string | null } | null> };
}

/**
 * Loads the facts for buildPortfolioContext (Tracker AI overhaul item A): server side, read-only, scoped to the
 * projects the caller already listed for the viewer (AiToolsService.projects: the active line and the viewer's
 * departments). Reads frozen report rows only to count streaks; never writes anything and never touches FreezeService,
 * stored PDFs or handoff.json.
 */
export class PortfolioContextService {
  /** How many frozen reports back the streaks look. */
  static readonly REPORTS_BACK = 6;
  /** History older than this is not read for prior updates or the status-entered date. */
  static readonly HISTORY_DAYS = 400;

  private static async safe<T>(fn: (() => Promise<T>) | null, fallback: T): Promise<T> {
    if (!fn) return fallback;
    try {
      return await fn();
    } catch {
      return fallback;
    }
  }

  static async glossary(db: unknown): Promise<GlossaryEntry[]> {
    const d = db as ContextDb;
    return PortfolioContextService.safe(d.aiGlossaryTerm ? () => d.aiGlossaryTerm!.findMany({ where: { removedAt: null }, orderBy: [{ position: "asc" }, { term: "asc" }], select: { term: true, definition: true } }) : null, []);
  }

  static async roleTitle(db: unknown): Promise<string | null> {
    const d = db as ContextDb;
    const row = await PortfolioContextService.safe(d.aiContextSetting ? () => d.aiContextSetting!.findUnique({ where: { id: "default" } }) : null, null);
    return row?.roleTitle?.trim() || null;
  }

  /** The facts for `projects` (in ref order). */
  static async load(args: { db: unknown; scope: ServiceLineScope; viewer: Viewer | null; projects: readonly AiToolProject[]; now?: Date }): Promise<PortfolioContextInput> {
    const d = args.db as ContextDb;
    const now = args.now ?? new Date();
    const today = DateOnly.inZone(now);
    const ids = args.projects.map((p) => p.id);
    const since = new Date(now.getTime() - PortfolioContextService.HISTORY_DAYS * 86_400_000);
    const s = PortfolioContextService.safe;
    const [rich, steps, history, snapshots, deps, blockers, glossary, roleTitle, user] = await Promise.all([
      s(ids.length && d.project ? () => d.project!.findMany({ where: { id: { in: ids } }, select: { id: true, inforRequestNumber: true, departmentId: true, description: true, isMfi: true, includeInReport: true, hiddenFromReport: true, owner: true, physicianChampion: true, requesterNotApplicable: true, contractsLead: true, reviewedAt: true, createdAt: true } }) : null, [] as RichRow[]),
      s(ids.length && d.projectMilestone ? () => d.projectMilestone!.findMany({ where: { projectId: { in: ids } }, orderBy: [{ projectId: "asc" }, { position: "asc" }] }) : null, [] as StepRow[]),
      s(ids.length && d.projectHistory ? () => d.projectHistory!.findMany({ where: { projectId: { in: ids }, changedAt: { gte: since } }, select: { projectId: true, field: true, oldValue: true, newValue: true, changedAt: true }, orderBy: { changedAt: "desc" } }) : null, [] as HistoryRow[]),
      s(d.reportSnapshot ? () => d.reportSnapshot!.findMany({ where: { serviceLineId: args.scope.id }, orderBy: { generatedAt: "desc" }, take: PortfolioContextService.REPORTS_BACK, select: { generatedAt: true, rowsJson: true } }) : null, []),
      s(d.projectDependency ? () => d.projectDependency!.findMany({ where: { serviceLineId: args.scope.id, removedAt: null }, select: { projectId: true, blockedById: true, createdAt: true, note: true }, orderBy: { createdAt: "asc" } }) : null, []),
      s(ids.length && d.projectBlocker ? () => d.projectBlocker!.findMany({ where: { serviceLineId: args.scope.id, resolvedAt: null, projectId: { in: ids } }, select: { projectId: true, description: true, waitingOn: true, since: true, followUpOn: true, followUpOwner: true }, orderBy: { since: "asc" } }) : null, []),
      PortfolioContextService.glossary(d),
      PortfolioContextService.roleTitle(d),
      s(args.viewer && d.appUser ? () => d.appUser!.findUnique({ where: { email: args.viewer!.email } }) : null, null),
    ]);
    const richById = new Map((Array.isArray(rich) ? rich : []).map((r) => [r.id, r]));
    const stepsBy = PortfolioContextService.group(Array.isArray(steps) ? steps : []);
    const historyBy = PortfolioContextService.group(Array.isArray(history) ? history : []);
    const lastReport = snapshots[0]?.generatedAt ?? null;
    const reportRows = snapshots.map((snap) => {
      const rows = Array.isArray(snap.rowsJson) ? (snap.rowsJson as { projectId?: string; status?: ProjectStatus; changed?: boolean }[]) : [];
      return new Map(rows.filter((r) => typeof r?.projectId === "string").map((r) => [r.projectId!, { status: r.status as ProjectStatus, changed: r.changed === true }]));
    });
    const departmentName = (id: string | null | undefined) => (id ? (args.scope.departments.find((x) => x.id === id)?.name ?? null) : null);

    const projects: ContextProject[] = args.projects.map((p) => {
      const r = richById.get(p.id) ?? { id: p.id };
      const st = stepsBy.get(p.id) ?? [];
      const hist = historyBy.get(p.id) ?? [];
      const status = p.status as ProjectStatus;
      const derived = MilestoneProgress.derive(st, { nextMilestone: p.nextMilestone, dueDate: p.dueDate });
      const historyRecords = hist.map((h) => ({ projectId: h.projectId, field: h.field, changedAt: h.changedAt }));
      const updatedOn = ReportBuilder.updatedOn(p.id, historyRecords);
      const statusRow = hist.find((h) => h.field === "status");
      const statusSince = statusRow ? DateOnly.inZone(statusRow.changedAt) : r.createdAt ? DateOnly.inZone(r.createdAt) : null;
      const reports: (ReportedState | null)[] = reportRows.map((m) => m.get(p.id) ?? null);
      const signals = PortfolioSignals.compute(
        { status, dueDate: derived.dueDate, updatedOn, owner: r.owner ?? null, hasOpenStep: st.some((x) => !x.done), nextStepOwner: derived.owner, statusSince, reports },
        today,
      );
      const changedRows = hist.filter((h) => VisibilityPolicy.isPublicUpdateField(h.field) && (!lastReport || h.changedAt.getTime() > lastReport.getTime()));
      const reviewed = ReportBuilder.isReviewed({ id: p.id, reviewedAt: r.reviewedAt ?? null }, historyRecords);
      const priorUpdates = hist
        .filter((h) => h.field === "note" && h.oldValue)
        .slice(0, PortfolioContext.PRIOR_UPDATES)
        .map((h) => ({ on: DateOnly.inZone(h.changedAt), text: h.oldValue! }));
      return {
        id: p.id,
        name: p.name,
        reqNumber: r.inforRequestNumber ?? null,
        department: departmentName(r.departmentId),
        description: r.description ?? null,
        isMfi: r.isMfi === true,
        inReport: r.includeInReport !== false && r.hiddenFromReport !== true,
        owner: r.owner ?? null,
        requester: r.physicianChampion ?? null,
        requesterNotApplicable: r.requesterNotApplicable === true,
        contractsLead: r.contractsLead ?? null,
        milestoneOwner: derived.owner,
        status,
        statusSince,
        nextMilestone: derived.nextMilestone,
        dueDate: derived.dueDate,
        targetCompletion: p.targetCompletion,
        milestones: MilestoneProgress.ordered(st).map((x) => ({ name: x.name, owner: x.owner?.trim() || null, due: DateOnly.fromDbDate(x.dueDate), done: x.done })),
        latestUpdate: p.note,
        priorUpdates,
        changedSinceReport: changedRows.length > 0 && !reviewed,
        changedFields: [...new Set(changedRows.map((h) => h.field))],
        lastReviewed: r.reviewedAt ? DateOnly.inZone(r.reviewedAt) : null,
        signals,
        blockerFlags: [],
        blockedBy: [],
        blocking: [],
        external: [],
      };
    });

    // Blockers: only between projects in this list (the viewer's scope), both directions.
    const ctx = new Map(projects.map((p) => [p.id, p]));
    for (const e of deps) {
      const blocked = ctx.get(e.projectId);
      const blocker = ctx.get(e.blockedById);
      if (!blocked || !blocker) continue;
      const sinceDay = DateOnly.inZone(e.createdAt);
      blocked.blockedBy.push({ id: blocker.id, name: blocker.name, status: blocker.status, note: e.note ?? null, since: sinceDay, days: PortfolioSignals.days(sinceDay, today) });
      blocker.blocking.push({ id: blocked.id, name: blocked.name });
    }
    for (const b of blockers) {
      const p = ctx.get(b.projectId);
      if (!p) continue;
      const sinceDay = DateOnly.fromDbDate(b.since)!;
      p.external.push({ description: b.description, waitingOn: b.waitingOn, since: sinceDay, days: PortfolioSignals.days(sinceDay, today), followUpOn: DateOnly.fromDbDate(b.followUpOn), followUpOwner: b.followUpOwner ?? null });
    }
    for (const p of projects) {
      if (!p.blockedBy.length && !p.external.length) continue;
      const rb: RowBlockers = {
        blockedBy: p.blockedBy.map((b) => ({ id: b.id, name: b.name, status: b.status, dueDate: ctx.get(b.id)?.dueDate ?? null, since: b.since, prompt: false })),
        external: p.external.map((e) => ({ waitingOn: e.waitingOn, description: e.description, since: e.since, followUpOn: e.followUpOn })),
        blocking: p.blocking.length,
      };
      p.blockerFlags = BlockerSignals.flags({ status: p.status, dueDate: p.dueDate }, rb, today).map((f) => f.text);
    }
    return {
      today,
      serviceLine: args.scope.name ?? args.scope.shortName ?? "",
      userName: user?.name?.trim() || (args.viewer ? DisplayName.fromEmail(args.viewer.email) : null),
      roleTitle,
      glossary,
      lastReportDate: lastReport ? DateOnly.inZone(lastReport) : null,
      projects,
    };
  }

  private static group<T extends { projectId: string }>(rows: readonly T[]): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const r of rows) {
      const list = out.get(r.projectId);
      if (list) list.push(r);
      else out.set(r.projectId, [r]);
    }
    return out;
  }

  /** Load and render in one call (the AI features use this). */
  static async build(args: { db: unknown; scope: ServiceLineScope; viewer: Viewer | null; projects: readonly AiToolProject[]; now?: Date; maxTokens?: number }): Promise<PortfolioContextResult & { input: PortfolioContextInput }> {
    const input = await PortfolioContextService.load(args);
    return { ...PortfolioContext.build(input, args.maxTokens), input };
  }
}
