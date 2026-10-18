import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";

export interface GlossaryTermRow {
  id: string;
  term: string;
  termKey: string;
  definition: string | null;
  position: number;
  removedAt: Date | null;
  removedBy: string | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface GlossaryHistoryRow {
  id: string;
  field: "glossary_added" | "glossary_definition" | "glossary_removed" | "role_title";
  term: string | null;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
  changedBy: string;
}

/** The slice of Prisma the glossary uses (tests pass an in-memory fake). */
export interface GlossaryDb {
  aiGlossaryTerm: {
    findMany(args?: object): Promise<GlossaryTermRow[]>;
    findUnique(args: { where: { id: string } | { termKey: string } }): Promise<GlossaryTermRow | null>;
    create(args: { data: GlossaryTermRow }): Promise<unknown>;
    update(args: { where: { id: string }; data: Partial<GlossaryTermRow> }): Promise<unknown>;
  };
  aiContextSetting: {
    findUnique(args: { where: { id: string } }): Promise<{ id: string; roleTitle: string | null } | null>;
    upsert(args: { where: { id: string }; create: { id: string; roleTitle: string | null; updatedAt: Date; updatedBy: string }; update: { roleTitle: string | null; updatedAt: Date; updatedBy: string } }): Promise<unknown>;
  };
  aiContextHistory: {
    create(args: { data: GlossaryHistoryRow }): Promise<unknown>;
    findMany(args?: object): Promise<GlossaryHistoryRow[]>;
  };
}

export interface GlossaryView {
  roleTitle: string;
  terms: { id: string; term: string; definition: string }[];
}

export type GlossaryResult = { ok: true } | { ok: false; error: string };

/**
 * Admin > AI settings > Context (item A): the org glossary and the role title the AI context uses. Admin only. Terms
 * are never deleted (removing sets removedAt; adding the same term again brings it back). Every change writes one
 * ai_context_history row. Nothing here invents a definition: the seed terms ship blank for an admin to write.
 */
export class AiGlossaryService {
  static readonly TERM_MAX = 60;
  static readonly DEFINITION_MAX = 500;
  static readonly ROLE_MAX = 120;
  static readonly ID = "default";

  static key(term: string): string {
    return term.trim().toLowerCase();
  }

  static clean(v: unknown, max: number): string | null {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length <= max ? t : null;
  }

  static async view(db: GlossaryDb): Promise<GlossaryView> {
    const [terms, setting] = await Promise.all([
      db.aiGlossaryTerm.findMany({ where: { removedAt: null }, orderBy: [{ position: "asc" }, { term: "asc" }] }),
      db.aiContextSetting.findUnique({ where: { id: AiGlossaryService.ID } }),
    ]);
    return { roleTitle: setting?.roleTitle ?? "", terms: terms.filter((t) => !t.removedAt).map((t) => ({ id: t.id, term: t.term, definition: t.definition ?? "" })) };
  }

  private static deny(viewer: Viewer | null): GlossaryResult | null {
    return viewer?.isAdmin ? null : { ok: false, error: "Not authorized." };
  }

  private static history(db: GlossaryDb, viewer: Viewer, field: GlossaryHistoryRow["field"], term: string | null, oldValue: string | null, newValue: string | null, now: Date) {
    return db.aiContextHistory.create({ data: { id: randomUUID(), field, term, oldValue, newValue, changedAt: now, changedBy: viewer.email } });
  }

  static async addTerm(db: GlossaryDb, viewer: Viewer | null, rawTerm: unknown, rawDefinition: unknown = "", now: Date = new Date()): Promise<GlossaryResult> {
    const denied = AiGlossaryService.deny(viewer);
    if (denied) return denied;
    const term = AiGlossaryService.clean(rawTerm, AiGlossaryService.TERM_MAX);
    if (!term) return { ok: false, error: `Enter a term (${AiGlossaryService.TERM_MAX} characters or fewer).` };
    const definition = AiGlossaryService.clean(rawDefinition ?? "", AiGlossaryService.DEFINITION_MAX);
    if (definition === null) return { ok: false, error: `Definitions are ${AiGlossaryService.DEFINITION_MAX} characters or fewer.` };
    const termKey = AiGlossaryService.key(term);
    const found = await db.aiGlossaryTerm.findUnique({ where: { termKey } });
    if (found && !found.removedAt) return { ok: false, error: `"${found.term}" is already in the glossary.` };
    const all = await db.aiGlossaryTerm.findMany();
    const position = all.reduce((m, t) => Math.max(m, t.position), 0) + 1;
    if (found) await db.aiGlossaryTerm.update({ where: { id: found.id }, data: { term, definition: definition || null, position, removedAt: null, removedBy: null, updatedAt: now, updatedBy: viewer!.email } });
    else await db.aiGlossaryTerm.create({ data: { id: randomUUID(), term, termKey, definition: definition || null, position, removedAt: null, removedBy: null, createdAt: now, createdBy: viewer!.email, updatedAt: now, updatedBy: viewer!.email } });
    await AiGlossaryService.history(db, viewer!, "glossary_added", term, null, definition || null, now);
    return { ok: true };
  }

  static async setDefinition(db: GlossaryDb, viewer: Viewer | null, id: unknown, rawDefinition: unknown, now: Date = new Date()): Promise<GlossaryResult> {
    const denied = AiGlossaryService.deny(viewer);
    if (denied) return denied;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "That term is gone. Reload the page." };
    const definition = AiGlossaryService.clean(rawDefinition, AiGlossaryService.DEFINITION_MAX);
    if (definition === null) return { ok: false, error: `Definitions are ${AiGlossaryService.DEFINITION_MAX} characters or fewer.` };
    const row = await db.aiGlossaryTerm.findUnique({ where: { id } });
    if (!row || row.removedAt) return { ok: false, error: "That term is gone. Reload the page." };
    if ((row.definition ?? "") === definition) return { ok: true };
    await db.aiGlossaryTerm.update({ where: { id }, data: { definition: definition || null, updatedAt: now, updatedBy: viewer!.email } });
    await AiGlossaryService.history(db, viewer!, "glossary_definition", row.term, row.definition, definition || null, now);
    return { ok: true };
  }

  static async removeTerm(db: GlossaryDb, viewer: Viewer | null, id: unknown, now: Date = new Date()): Promise<GlossaryResult> {
    const denied = AiGlossaryService.deny(viewer);
    if (denied) return denied;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "That term is gone. Reload the page." };
    const row = await db.aiGlossaryTerm.findUnique({ where: { id } });
    if (!row || row.removedAt) return { ok: false, error: "That term is gone. Reload the page." };
    await db.aiGlossaryTerm.update({ where: { id }, data: { removedAt: now, removedBy: viewer!.email, updatedAt: now, updatedBy: viewer!.email } });
    await AiGlossaryService.history(db, viewer!, "glossary_removed", row.term, row.definition, null, now);
    return { ok: true };
  }

  static async setRoleTitle(db: GlossaryDb, viewer: Viewer | null, raw: unknown, now: Date = new Date()): Promise<GlossaryResult> {
    const denied = AiGlossaryService.deny(viewer);
    if (denied) return denied;
    const title = AiGlossaryService.clean(raw, AiGlossaryService.ROLE_MAX);
    if (title === null) return { ok: false, error: `The role title is ${AiGlossaryService.ROLE_MAX} characters or fewer.` };
    const before = (await db.aiContextSetting.findUnique({ where: { id: AiGlossaryService.ID } }))?.roleTitle ?? null;
    if ((before ?? "") === title) return { ok: true };
    await db.aiContextSetting.upsert({ where: { id: AiGlossaryService.ID }, create: { id: AiGlossaryService.ID, roleTitle: title || null, updatedAt: now, updatedBy: viewer!.email }, update: { roleTitle: title || null, updatedAt: now, updatedBy: viewer!.email } });
    await AiGlossaryService.history(db, viewer!, "role_title", null, before, title || null, now);
    return { ok: true };
  }
}
