import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { PortfolioContext } from "@/lib/ai/context/PortfolioContext";
import { AiPlaybookModel, type AiMeetingType, type AiPlaybook, type AiPlaybookLength, type AiPlaybookRecord, type AiPlaybookScope } from "@/lib/ai/playbook/AiPlaybookModel";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiToolsService, type AiToolsDb } from "@/lib/services/AiToolsService";
import { PortfolioContextService } from "@/lib/services/PortfolioContextService";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

interface PlaybookRow {
  id: string;
  serviceLineId: string;
  userEmail: string;
  meetingType: string;
  scopeLabel: string;
  scope: unknown;
  lengthMinutes: number;
  focus: string | null;
  content: unknown;
  provider: string | null;
  model: string | null;
  createdAt: Date;
}

export interface AiPlaybookDb extends AiToolsDb {
  aiPlaybook: {
    create(args: { data: Omit<PlaybookRow, "scope" | "content"> & { scope: object; content: object } }): Promise<unknown>;
    findMany(args: object): Promise<PlaybookRow[]>;
    findUnique(args: { where: { id: string } }): Promise<PlaybookRow | null>;
  };
}

export type AiPlaybookResult = { ok: true; playbook: AiPlaybookRecord } | { ok: false; message: string };

/**
 * Meeting Playbook item (replaces the pre-meeting brief): makes a structured playbook for one meeting type, scope and
 * length from the shared context (item A) on the meeting_brief feature's routed model (item D), checks it
 * (AiPlaybookModel.parse), and saves it so it can be reopened. Read-only for projects: nothing is applied from here.
 * Never touches snapshots, PDFs, report_artifacts or handoff.json.
 */
export class AiPlaybookService {
  static readonly FEATURE = "meeting_brief" as const;
  static readonly LIST_MAX = 30;

  static record(r: PlaybookRow): AiPlaybookRecord | null {
    const meetingType = AiPlaybookModel.meetingType(r.meetingType);
    const lengthMinutes = AiPlaybookModel.lengthOf(r.lengthMinutes);
    const scope = AiPlaybookModel.scope(r.scope);
    if (!meetingType || !lengthMinutes || !scope || !r.content || typeof r.content !== "object") return null;
    return { id: r.id, meetingType, lengthMinutes, scope, scopeLabel: r.scopeLabel, focus: r.focus, content: r.content as AiPlaybook, createdAt: r.createdAt.toISOString() };
  }

  static async generate(args: {
    db: AiPlaybookDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    meetingType: unknown;
    playbookScope: unknown;
    length: unknown;
    focus: unknown;
    env?: Env;
    fetchImpl?: FetchLike;
    keys?: AiProviderKeySource;
    now?: () => Date;
  }): Promise<AiPlaybookResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const meetingType: AiMeetingType | null = AiPlaybookModel.meetingType(args.meetingType);
    const length: AiPlaybookLength | null = AiPlaybookModel.lengthOf(args.length);
    const pScope: AiPlaybookScope | null = AiPlaybookModel.scope(args.playbookScope);
    if (!meetingType || !length || !pScope) return { ok: false, message: AiToolsCopy.PLAYBOOK_INVALID };
    const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim().slice(0, AiPlaybookModel.FOCUS_MAX) : null;

    const all = await AiToolsService.projects(args.db, args.scope);
    const input = await PortfolioContextService.load({ db: args.db, scope: args.scope, viewer: args.viewer, projects: all, now: args.now?.() });
    const scoped = { ...input, projects: AiPlaybookModel.inScope(input.projects, pScope) };
    if (!scoped.projects.length) return { ok: false, message: AiToolsCopy.PLAYBOOK_NO_PROJECTS };
    const context = PortfolioContext.build(scoped).text;

    const r = await AiToolsService.call({
      db: args.db,
      viewer: args.viewer,
      feature: AiPlaybookService.FEATURE,
      input: AiPlaybookModel.user(focus),
      build: (u) => ({ system: AiPlaybookModel.system(meetingType, length, context), user: u, maxTokens: AiPlaybookModel.MAX_TOKENS }),
      env: args.env,
      fetchImpl: args.fetchImpl,
      keys: args.keys,
      now: args.now,
    });
    if (!r.ok) return { ok: false, message: r.message };
    const content = AiPlaybookModel.parse(r.text, scoped, length);
    if (!content) {
      await r.log("failed");
      return { ok: false, message: AiToolsCopy.PARSE_FAILED };
    }
    const createdAt = args.now?.() ?? new Date();
    const scopeLabel = AiPlaybookModel.scopeLabel(pScope, args.scope.name);
    const id = randomUUID();
    await args.db.aiPlaybook.create({ data: { id, serviceLineId: args.scope.id, userEmail: args.viewer.email, meetingType, scopeLabel, scope: pScope, lengthMinutes: length, focus, content: content as unknown as object, provider: null, model: null, createdAt } });
    await r.log("proposed", { outputLength: content.decisions.length + content.talkingPoints.length });
    return { ok: true, playbook: { id, meetingType, scopeLabel, scope: pScope, lengthMinutes: length, focus, content, createdAt: createdAt.toISOString() } };
  }

  /** The viewer's saved playbooks for the active line, newest first (summaries are the full records; at most 30). */
  static async list(db: AiPlaybookDb, viewer: Viewer | null, scope: ServiceLineScope): Promise<AiPlaybookRecord[]> {
    if (!viewer?.isAdmin) return [];
    const rows = await db.aiPlaybook.findMany({ where: { userEmail: viewer.email, serviceLineId: scope.id }, orderBy: { createdAt: "desc" }, take: AiPlaybookService.LIST_MAX });
    return rows.map(AiPlaybookService.record).filter((x): x is AiPlaybookRecord => x !== null);
  }

  /** One saved playbook, only for the person who made it, in the active line. */
  static async get(db: AiPlaybookDb, viewer: Viewer | null, scope: ServiceLineScope, id: unknown): Promise<AiPlaybookRecord | null> {
    if (!viewer?.isAdmin || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const row = await db.aiPlaybook.findUnique({ where: { id } });
    if (!row || row.userEmail !== viewer.email || row.serviceLineId !== scope.id) return null;
    return AiPlaybookService.record(row);
  }

}
