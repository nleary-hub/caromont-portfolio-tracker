import { randomUUID } from "node:crypto";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags, type AiToolFeature } from "@/lib/ai/AiFeatureFlags";
import { AiPhiGuard } from "@/lib/ai/AiPhiGuard";
import { AiProviderClient, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiProviders } from "@/lib/ai/AiProviders";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiToolsModel, type AiToolChange, type AiToolField, type AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiToolsPrompts } from "@/lib/ai/AiToolsPrompts";
import { AiTranscriptionClient, type AiTranscribeFetch } from "@/lib/ai/AiTranscriptionClient";
import { AppConfig } from "@/lib/config/AppConfig";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiModelService } from "@/lib/services/AiModelService";
import { AiSettingsService, type AiSettingsDb } from "./AiSettingsService";
import { AiWritingService, type AiUsageRow } from "./AiWritingService";

type Env = Record<string, string | undefined>;

export type AiToolUsageRow = AiUsageRow & { lineIndex?: number | null };

/** The narrow slice of Prisma the AI tools use (tests pass an in-memory fake). */
export interface AiToolsDb extends AiSettingsDb {
  aiUsageLog: {
    create(args: { data: AiToolUsageRow }): Promise<unknown>;
    findFirst(args: { where: Record<string, unknown> }): Promise<AiToolUsageRow | null>;
    count(args: { where: { userEmail: string; event: { in: string[] }; createdAt: { gte: Date } } }): Promise<number>;
  };
  project: {
    findMany(args: object): Promise<ProjectRowForTools[]>;
  };
}

export interface ProjectRowForTools {
  id: string;
  name: string;
  status: string;
  nextMilestone: string | null;
  dueDate: Date | null;
  targetCompletion: Date | null;
  note: string | null;
}

/** Saves one applied line through the normal project save (ProjectService.update: validation, history, Changed). */
export type AiToolSave = (projectId: string, patch: Record<string, string | null>) => Promise<void>;

export type AiToolFailure = { ok: false; kind: "off" | "feature_off" | "denied" | "empty" | "rate" | "timeout" | "provider" | "parse"; message: string };
export type AiToolProposeResult = { ok: true; proposalId: string; feature: AiToolFeature; changes: AiToolChange[] } | AiToolFailure;
export type AiToolLineResult = { ok: true } | { ok: false; message: string };

const RATE_EVENTS = ["suggested", "failed", "proposed"];

/** Which fields each change-suggesting tool may touch. */
const FIELDS: Partial<Record<AiToolFeature, readonly AiToolField[]>> = {
  meeting_notes: AiToolsModel.ALL_FIELDS,
  // Step 5 (decision D3): no note, owner, physician or department changes in bulk.
  bulk_edit: ["status", "nextMilestone", "dueDate", "targetCompletion"],
  quick_capture: ["status", "nextMilestone", "dueDate", "note"],
  next_step: ["nextMilestone", "dueDate"],
};

/** Extra read-only fields a tool sees (it can't change them). */
const CONTEXT_ONLY: Partial<Record<AiToolFeature, readonly AiToolField[]>> = {
  next_step: ["status", "note"],
};

/**
 * The AI tools engine (steps 4 to 9): the AI proposes, a person applies or rejects each line, nothing auto-applies.
 * Admin only (the same people who can edit projects). Every proposal, apply, reject and failure is one ai_usage_log
 * row (30-day retention). An applied line goes through ProjectService.update, so it is validated and written to
 * history exactly like a manual edit. Never touches snapshots, PDFs, report_artifacts or handoff.json.
 */
export class AiToolsService {
  private static readonly inFlight = new Set<string>();

  static fieldsOf(feature: AiToolFeature): readonly AiToolField[] {
    return FIELDS[feature] ?? [];
  }

  static toProject(r: ProjectRowForTools): AiToolProject {
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      nextMilestone: r.nextMilestone,
      dueDate: AiToolsModel.dateText(r.dueDate),
      targetCompletion: AiToolsModel.dateText(r.targetCompletion),
      note: r.note,
    };
  }

  /** Open (not archived) projects of the active line and the viewer's departments, by name. */
  static async projects(db: AiToolsDb, scope: ServiceLineScope, onlyId?: string): Promise<AiToolProject[]> {
    const rows = await db.project.findMany({
      where: { ...ServiceLineAccess.projectWhere(scope), archivedAt: null, ...(onlyId ? { id: onlyId } : {}) },
      select: { id: true, name: true, status: true, nextMilestone: true, dueDate: true, targetCompletion: true, note: true },
      orderBy: { name: "asc" },
      take: AiToolsModel.MAX_PROJECTS,
    });
    return rows.map(AiToolsService.toProject);
  }

  /** Shared guards and the provider call. Returns the reply text, or a failure to show. */
  static async call(args: {
    db: AiToolsDb;
    viewer: Viewer | null;
    feature: AiToolFeature;
    input: string;
    build: (input: string) => { system: string; user: string; maxTokens: number };
    projectId?: string | null;
    env?: Env;
    fetchImpl?: FetchLike;
    now?: () => Date;
  }): Promise<{ ok: true; text: string; log: (event: string, extra?: Partial<AiToolUsageRow>) => Promise<unknown>; proposalId: string } | AiToolFailure> {
    const { db, viewer, feature } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, kind: "denied", message: AiCopy.NOT_AUTHORIZED };
    if (!(await AiModelService.featureOn(db, feature, env))) return { ok: false, kind: "feature_off", message: AiToolsCopy.FEATURE_OFF };
    const input = args.input.slice(0, AiToolsService.INPUT_MAX);
    if (!input.trim()) return { ok: false, kind: "empty", message: AiToolsCopy.INPUT_EMPTY };

    const row = await AiSettingsService.row(db).catch(() => null);
    const saved = row?.enabled ? AiSettingsService.runtime(row, env) : null;
    if (!saved) return { ok: false, kind: "off", message: AiToolsCopy.AI_OFF };
    // Only models an admin turned on (ai_models). Never switched automatically.
    const config = { ...saved, allowedModels: await AiModelService.enabledIds(db) };
    if (!AiProviders.modelAllowed(config.model, config.allowedModels)) return { ok: false, kind: "provider", message: AiCopy.MODEL_NOT_ALLOWED };

    const user = viewer.email;
    if (AiToolsService.inFlight.has(user)) return { ok: false, kind: "rate", message: AiCopy.RATE_LIMITED };
    const recent = await db.aiUsageLog.count({ where: { userEmail: user, event: { in: RATE_EVENTS }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } } });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, kind: "rate", message: AiCopy.RATE_LIMITED };

    const proposalId = randomUUID();
    const log = (event: string, extra: Partial<AiToolUsageRow> = {}) =>
      db.aiUsageLog.create({
        data: { id: randomUUID(), suggestionId: proposalId, userEmail: user, projectId: args.projectId ?? null, feature, event, provider: config.provider, model: config.model, inputLength: input.length, outputLength: null, numberCheckPassed: null, suggestedText: null, createdAt: now(), ...extra },
      });
    AiToolsService.inFlight.add(user);
    try {
      const result = await AiProviderClient.complete(config, args.build(input), args.fetchImpl);
      if (!result.ok) {
        await log("failed");
        console.error("AI tools: provider call failed", { feature, kind: result.kind, status: result.status });
        return { ok: false, kind: result.kind === "timeout" ? "timeout" : "provider", message: result.kind === "timeout" ? AiToolsCopy.TIMEOUT : AiToolsCopy.PROVIDER_ERROR };
      }
      return { ok: true, text: result.text, log, proposalId };
    } finally {
      AiToolsService.inFlight.delete(user);
    }
  }

  static readonly INPUT_MAX = 20_000;

  /** A change-suggesting tool: returns checked lines for review. Saves nothing. */
  static async proposeChanges(args: {
    db: AiToolsDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    feature: AiToolFeature;
    input: unknown;
    /** Limits the context to one project (Next-step suggestion). */
    projectId?: string | null;
    env?: Env;
    fetchImpl?: FetchLike;
    now?: () => Date;
  }): Promise<AiToolProposeResult> {
    const fields = AiToolsService.fieldsOf(args.feature);
    // Next-step suggestion is always about one chosen project.
    if (args.feature === "next_step" && !args.projectId) return { ok: false, kind: "empty", message: AiToolsCopy.PICK_PROJECT };
    if (!args.viewer?.isAdmin || !fields.length) return { ok: false, kind: "denied", message: AiCopy.NOT_AUTHORIZED };
    if (args.projectId !== undefined && args.projectId !== null && !/^[0-9a-f-]{36}$/i.test(args.projectId)) return { ok: false, kind: "denied", message: AiCopy.PROJECT_GONE };
    const projects = await AiToolsService.projects(args.db, args.scope, args.projectId ?? undefined);
    if (args.projectId && !projects.length) return { ok: false, kind: "denied", message: AiCopy.PROJECT_GONE };
    const r = await AiToolsService.call({
      ...args,
      input: typeof args.input === "string" ? args.input : "",
      build: (input) => AiToolsPrompts.build(args.feature, input, AiToolsModel.context(projects, [...fields, ...(CONTEXT_ONLY[args.feature] ?? [])])),
    });
    if (!r.ok) return r;
    const parsed = AiToolsModel.parseChanges(r.text, projects, fields);
    // Quick capture is about one project: lines for any other project are dropped.
    const changes = parsed && args.feature === "quick_capture" ? AiToolsModel.oneProject(parsed) : parsed;
    if (!changes) {
      await r.log("failed");
      return { ok: false, kind: "parse", message: AiToolsCopy.PARSE_FAILED };
    }
    const kept = JSON.stringify(changes);
    await r.log("proposed", { outputLength: changes.length, suggestedText: AiPhiGuard.check(kept).ok ? kept.slice(0, AppConfig.NOTE_MAX_LENGTH * 10) : null });
    return { ok: true, proposalId: r.proposalId, feature: args.feature, changes };
  }

  /**
   * Apply one line: re-checks admin, the kill switch, that this user got the proposal and that the line is still
   * open, checks the (possibly edited) value, then saves through the normal project save. One "applied" row.
   */
  static async applyLine(args: {
    db: AiToolsDb;
    viewer: Viewer | null;
    proposalId: unknown;
    line: unknown;
    projectId: unknown;
    field: unknown;
    value: unknown;
    save: AiToolSave;
    env?: Env;
    now?: Date;
  }): Promise<AiToolLineResult> {
    const open = await AiToolsService.openLine(args.db, args.viewer, args.proposalId, args.line, args.env ?? process.env, true);
    if (!open.ok) return open;
    const field = AiToolsModel.ALL_FIELDS.find((f) => f === args.field);
    if (!field || !AiToolsService.fieldsOf(open.feature).includes(field)) return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    if (typeof args.projectId !== "string" || !/^[0-9a-f-]{36}$/i.test(args.projectId)) return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    const value = AiToolsModel.clean(field, args.value as unknown);
    if (value === null) return { ok: false, message: AiToolsCopy.VALUE_INVALID };
    try {
      await args.save(args.projectId, AiToolsModel.patch(field, value));
    } catch (e) {
      console.error("AI tools: apply failed", (e as Error)?.name);
      return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    }
    await AiToolsService.decision(args.db, open.row, "applied", open.line, args.projectId, value.length, args.now);
    return { ok: true };
  }

  /** Reject one line: one "rejected" row. Nothing changes. */
  static async rejectLine(db: AiToolsDb, viewer: Viewer | null, proposalId: unknown, line: unknown, env: Env = process.env, now?: Date): Promise<AiToolLineResult> {
    const open = await AiToolsService.openLine(db, viewer, proposalId, line, env, false);
    if (!open.ok) return open;
    await AiToolsService.decision(db, open.row, "rejected", open.line, open.row.projectId, null, now);
    return { ok: true };
  }

  private static async openLine(db: AiToolsDb, viewer: Viewer | null, proposalId: unknown, rawLine: unknown, env: Env, applying: boolean): Promise<{ ok: true; row: AiToolUsageRow; line: number; feature: AiToolFeature } | { ok: false; message: string }> {
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const line = Number(rawLine);
    if (typeof proposalId !== "string" || !/^[0-9a-f-]{36}$/i.test(proposalId) || !Number.isInteger(line) || line < 0 || line >= AiToolsModel.MAX_LINES) return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    const row = await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: "proposed" } });
    const feature = AiFeatureFlags.parseToolFeature(row?.feature);
    if (!row || !feature) return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    if (applying && !(await AiModelService.featureOn(db, feature, env))) return { ok: false, message: AiToolsCopy.FEATURE_OFF };
    const closed = await db.aiUsageLog.findFirst({ where: { suggestionId: proposalId, userEmail: viewer.email, event: { in: ["applied", "rejected"] }, lineIndex: line } });
    if (closed) return { ok: false, message: AiToolsCopy.APPLY_FAILED };
    return { ok: true, row, line, feature };
  }

  private static decision(db: AiToolsDb, proposed: AiToolUsageRow, event: "applied" | "rejected", line: number, projectId: string | null, outputLength: number | null, now: Date = new Date()) {
    return db.aiUsageLog.create({
      data: {
        id: randomUUID(),
        suggestionId: proposed.suggestionId,
        userEmail: proposed.userEmail,
        projectId,
        feature: proposed.feature,
        event,
        provider: proposed.provider,
        model: proposed.model,
        inputLength: proposed.inputLength,
        outputLength,
        numberCheckPassed: null,
        suggestedText: null,
        unverifiedCount: null,
        lineIndex: line,
        createdAt: now,
      },
    });
  }

  /**
   * Step 6: dictation. Audio to text with the dictation model (its own setting; must be admin-enabled). Returns text
   * for the person to read and edit; nothing is suggested or saved. One usage row (lengths and model, no text).
   */
  static async transcribe(args: { db: AiToolsDb; viewer: Viewer | null; audio: unknown; env?: Env; fetchImpl?: AiTranscribeFetch; now?: () => Date }): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
    const { db, viewer } = args;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    if (!viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    if (!(await AiModelService.featureOn(db, "dictation", env))) return { ok: false, message: AiToolsCopy.FEATURE_OFF };
    const audio = args.audio as Blob | null;
    if (!audio || typeof audio !== "object" || typeof audio.size !== "number" || typeof audio.type !== "string" || !AiTranscriptionClient.acceptable(audio.type, audio.size)) return { ok: false, message: AiToolsCopy.DICTATION_FAILED };
    const row = await AiSettingsService.row(db).catch(() => null);
    const saved = row?.enabled ? AiSettingsService.runtime(row, env) : null;
    if (!saved) return { ok: false, message: AiToolsCopy.AI_OFF };
    const model = await AiModelService.featureModel(db, "dictation");
    if (!model) return { ok: false, message: AiToolsCopy.DICTATION_NO_MODEL };
    if (!(await AiModelService.enabledIds(db)).includes(model)) return { ok: false, message: AiCopy.MODEL_NOT_ALLOWED };
    const user = viewer.email;
    const recent = await db.aiUsageLog.count({ where: { userEmail: user, event: { in: RATE_EVENTS }, createdAt: { gte: new Date(now().getTime() - AiWritingService.RATE_WINDOW_MS) } } });
    if (recent >= AiWritingService.RATE_LIMIT) return { ok: false, message: AiCopy.RATE_LIMITED };
    const r = await AiTranscriptionClient.transcribe(saved, model, audio, args.fetchImpl);
    await db.aiUsageLog.create({
      data: { id: randomUUID(), suggestionId: randomUUID(), userEmail: user, projectId: null, feature: "dictation", event: r.ok ? "proposed" : "failed", provider: saved.provider, model, inputLength: audio.size, outputLength: r.ok ? r.text.length : null, numberCheckPassed: null, suggestedText: null, createdAt: now() },
    });
    if (!r.ok) {
      console.error("AI tools: transcription failed", { kind: r.kind });
      return { ok: false, message: AiToolsCopy.DICTATION_FAILED };
    }
    return { ok: true, text: r.text.slice(0, AiToolsService.INPUT_MAX) };
  }
}
