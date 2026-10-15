import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiLinksPanel } from "@/components/AiLinksPanel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { A, ADMIN, B, ENV, MEMBER, MockProvider, SCOPE, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiTools", () => ({ proposeAiRelatedLinks: vi.fn(), confirmAiRelatedLink: vi.fn(), rejectAiToolLine: vi.fn(), removeRelatedLink: vi.fn() }));

const REPLY = JSON.stringify({ links: [{ a: "P2", b: "P1", reason: "Same example vendor" }, { a: "P1", b: "P2", reason: "repeat" }, { a: "P1", b: "P1", reason: "self" }, { a: "P1", b: "P3", reason: "other line" }] });

describe("step 9: related-project links", () => {
  it("suggests, then links only on confirm (stored once per pair); remove keeps the row", async () => {
    const db = await toolsSetup();
    const r = await AiToolsService.proposeLinks({ db, viewer: ADMIN, scope: SCOPE, input: "", env: ENV, fetchImpl: new MockProvider(REPLY).fetch });
    if (!r.ok) throw new Error(r.message);
    expect(r.links.map((l) => [l.aId, l.bId, l.reason])).toEqual([[B, A, "Same example vendor"]]);
    expect(db.linkRows).toHaveLength(0);
    const l = r.links[0];
    expect((await AiToolsService.applyLink({ db, viewer: MEMBER, scope: SCOPE, proposalId: r.proposalId, line: 0, aId: l.aId, bId: l.bId, reason: l.reason, env: ENV })).ok).toBe(false);
    expect(await AiToolsService.applyLink({ db, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, line: 0, aId: l.aId, bId: l.bId, reason: l.reason, env: ENV })).toEqual({ ok: true });
    expect(db.linkRows).toMatchObject([{ projectAId: A, projectBId: B, reason: "Same example vendor", createdBy: ADMIN.email }]);
    expect((await AiToolsService.applyLink({ db, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, line: 0, aId: l.aId, bId: l.bId, reason: l.reason, env: ENV })).ok).toBe(false);
    expect(await AiToolsService.listLinks(db, SCOPE)).toEqual([{ id: db.linkRows[0].id, aId: A, aName: "Example Clinic refresh", bId: B, bName: "Sample Lab move", reason: "Same example vendor" }]);
    const again = await AiToolsService.proposeLinks({ db, viewer: ADMIN, scope: SCOPE, input: "", env: ENV, fetchImpl: new MockProvider(REPLY).fetch });
    expect(again.ok && again.links).toEqual([]);
    expect(await AiToolsService.removeLink(db, ADMIN, SCOPE, db.linkRows[0].id)).toEqual({ ok: true });
    expect(db.linkRows[0].removedAt).toBeInstanceOf(Date);
    expect(await AiToolsService.listLinks(db, SCOPE)).toEqual([]);
  });

  it("a project out of scope can't be linked; the kill switch stops it", async () => {
    const db = await toolsSetup();
    const r = await AiToolsService.proposeLinks({ db, viewer: ADMIN, scope: SCOPE, input: "", env: ENV, fetchImpl: new MockProvider(REPLY).fetch });
    if (!r.ok) throw new Error(r.message);
    expect((await AiToolsService.applyLink({ db, viewer: ADMIN, scope: SCOPE, proposalId: r.proposalId, line: 0, aId: A, bId: "20000000-0000-4000-8000-000000000001", reason: "", env: ENV })).ok).toBe(false);
    expect((await AiToolsService.proposeLinks({ db, viewer: ADMIN, scope: SCOPE, input: "", env: { ...ENV, AI_FEATURE_RELATED_LINKS: "off" }, fetchImpl: new MockProvider(REPLY).fetch })).ok).toBe(false);
  });

  it("panel lists confirmed links with project links", () => {
    const html = renderToStaticMarkup(createElement(AiLinksPanel, { disabledNote: null, saved: [{ id: "x", aId: A, aName: "Example Clinic refresh", bId: B, bName: "Sample Lab move", reason: "Same example vendor" }] }));
    expect(html).toContain(`href="/?project=${B}"`);
    expect(html).toContain(AiToolsCopy.LINK_REMOVE);
  });

  it("0047 creates the table add-only, with the delete trigger and the toggle seeded on (PGlite)", async () => {
    const dir = path.resolve(__dirname, "../prisma/migrations");
    const sql = readFileSync(path.join(dir, "0047_ai_tools_related_links", "migration.sql"), "utf8");
    expect(sql.split("\n").filter((l) => !l.startsWith("--")).join("\n")).not.toMatch(/\bDROP (TABLE|COLUMN)\b|\bDELETE FROM\b|\bUPDATE "/i);
    const db = await PGlite.create();
    for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
    expect((await db.query(`SELECT "feature" FROM "ai_feature_settings" WHERE "feature" = 'related_links' AND "enabled"`)).rows).toHaveLength(1);
    expect((await db.query(`SELECT tgname FROM pg_trigger WHERE tgname = 'project_related_links_no_delete'`)).rows).toHaveLength(1);
    const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'project_related_links' ORDER BY column_name`)).rows.map((r) => (r as { column_name: string }).column_name);
    expect(cols).toEqual(["createdAt", "createdBy", "id", "projectAId", "projectBId", "reason", "removedAt", "removedBy", "serviceLineId"]);
  });
});
