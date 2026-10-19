import { describe, expect, it } from "vitest";
import { AiGlossaryService, type GlossaryDb, type GlossaryHistoryRow, type GlossaryTermRow } from "@/lib/services/AiGlossaryService";

// Item A: org glossary and role title (Admin > AI settings > Context). Example data only.
const ADMIN = { email: "admin@example.org", isAdmin: true };
const MEMBER = { email: "member@example.org", isAdmin: false };

class FakeGlossaryDb implements GlossaryDb {
  terms: GlossaryTermRow[] = [];
  role: { id: string; roleTitle: string | null } | null = null;
  log: GlossaryHistoryRow[] = [];
  aiGlossaryTerm = {
    findMany: async () => [...this.terms].sort((a, b) => a.position - b.position),
    findUnique: async (a: { where: { id: string } | { termKey: string } }) => this.terms.find((t) => ("id" in a.where ? t.id === a.where.id : t.termKey === a.where.termKey)) ?? null,
    create: async (a: { data: GlossaryTermRow }) => this.terms.push({ ...a.data }),
    update: async (a: { where: { id: string }; data: Partial<GlossaryTermRow> }) => Object.assign(this.terms.find((t) => t.id === a.where.id)!, a.data),
  };
  aiContextSetting = {
    findUnique: async () => this.role,
    upsert: async (a: { create: { id: string; roleTitle: string | null }; update: { roleTitle: string | null } }) => (this.role = this.role ? { ...this.role, roleTitle: a.update.roleTitle } : { id: a.create.id, roleTitle: a.create.roleTitle }),
  };
  aiContextHistory = { create: async (a: { data: GlossaryHistoryRow }) => this.log.push(a.data), findMany: async () => this.log };
}

describe("AiGlossaryService (item A)", () => {
  it("admins add a term, write its definition, remove it and add it back; every change is in history", async () => {
    const db = new FakeGlossaryDb();
    expect(await AiGlossaryService.addTerm(db, ADMIN, "  Example  Board ", "")).toEqual({ ok: true });
    expect(await AiGlossaryService.addTerm(db, ADMIN, "example board")).toEqual({ ok: false, error: '"Example Board" is already in the glossary.' });
    const id = db.terms[0].id;
    expect(db.terms[0]).toMatchObject({ term: "Example Board", termKey: "example board", definition: null, position: 1 });
    expect(await AiGlossaryService.setDefinition(db, ADMIN, id, "A fictional review board.")).toEqual({ ok: true });
    expect((await AiGlossaryService.view(db)).terms).toEqual([{ id, term: "Example Board", definition: "A fictional review board." }]);
    expect(await AiGlossaryService.removeTerm(db, ADMIN, id)).toEqual({ ok: true });
    expect((await AiGlossaryService.view(db)).terms).toEqual([]);
    expect(db.terms).toHaveLength(1);
    expect(await AiGlossaryService.addTerm(db, ADMIN, "Example board")).toEqual({ ok: true });
    expect(db.terms).toHaveLength(1);
    expect(db.terms[0].removedAt).toBeNull();
    expect(db.log.map((h) => h.field)).toEqual(["glossary_added", "glossary_definition", "glossary_removed", "glossary_added"]);
  });

  it("checks lengths, refuses non-admins and never writes on a no-op", async () => {
    const db = new FakeGlossaryDb();
    expect(await AiGlossaryService.addTerm(db, MEMBER, "X")).toEqual({ ok: false, error: "Not authorized." });
    expect((await AiGlossaryService.addTerm(db, ADMIN, "x".repeat(61))).ok).toBe(false);
    expect((await AiGlossaryService.addTerm(db, ADMIN, "Y", "d".repeat(501))).ok).toBe(false);
    expect(await AiGlossaryService.setRoleTitle(db, ADMIN, "Director of an example line")).toEqual({ ok: true });
    expect(await AiGlossaryService.setRoleTitle(db, ADMIN, "Director of an example line")).toEqual({ ok: true });
    expect(db.log.filter((h) => h.field === "role_title")).toHaveLength(1);
    expect((await AiGlossaryService.view(db)).roleTitle).toBe("Director of an example line");
    expect((await AiGlossaryService.setRoleTitle(db, ADMIN, "r".repeat(121))).ok).toBe(false);
  });
});
