import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectHistorySection, UpdateNotesSection } from "@/components/ProjectHistory";
import { AiCopy } from "@/lib/ai/AiCopy";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { UpdateHistoryCopy } from "@/lib/history/UpdateHistoryCopy";
import { type TimelineRow, UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { ProjectHistoryService } from "@/lib/services/ProjectHistoryService";
import { ProjectService } from "@/lib/services/ProjectService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const ROOT = path.resolve(__dirname, "..");
const SRC = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const ADMIN = Factory.ADMIN;
const AT = new Date("2026-10-08T15:00:00Z");
const LATER = new Date("2026-10-09T15:00:00Z");
const created = (snapshot: unknown, extra: Partial<TimelineRow> = {}): TimelineRow => ({
  field: "created",
  oldValue: null,
  newValue: typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
  changedAt: AT,
  changedBy: "nick.leary@example.org",
  comment: null,
  ...extra,
});
const files = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir)).flatMap((f) => {
    const rel = path.join(dir, f);
    return statSync(path.join(ROOT, rel)).isDirectory() ? files(rel) : [rel];
  });

describe("Update notes shows a new project's first note (read from the created row)", () => {
  it("the note in the created snapshot is listed; History still says Project created.", () => {
    const t = UpdateTimeline.build([created({ name: "Hybrid OR", note: "Quote received Oct 6." })], [], null);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatchObject({ text: "Quote received Oct 6.", who: "Nick Leary", shortened: false });
    expect(t.entries.map((e) => e.text)).toContain(UpdateHistoryCopy.PROJECT_CREATED);
    expect(UpdateTimeline.toDto(t).notes[0]).toEqual({ key: t.notes[0].key, meta: t.notes[0].meta, who: "Nick Leary", text: "Quote received Oct 6.", shortened: false });
  });

  it("no note, a blank note or an unreadable snapshot list nothing", () => {
    for (const s of [{ name: "x" }, { name: "x", note: "" }, { name: "x", note: "   " }, { name: "x", note: null }, "not json", "null"]) expect(UpdateTimeline.build([created(s)], [], null).notes).toEqual([]);
    expect(UpdateTimeline.createdNote(null)).toBeNull();
  });

  it("later note edits come first; the first note is last", () => {
    const t = UpdateTimeline.build([created({ note: "First." }), { ...created({}), field: "note", oldValue: "First.", newValue: "Second.", changedAt: LATER }], [], null);
    expect(t.notes.map((n) => n.text)).toEqual(["Second.", "First."]);
    expect(new Set(t.notes.map((n) => n.key)).size).toBe(2);
  });

  it("New project form end to end: the first note shows in Update notes and no stored row changes", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.createFromForm({ name: "Hybrid OR imaging upgrade", serviceArea: "Cath", status: "NotStarted", startDate: DateOnly.today(), note: "Vendor quote received Oct 6." }, ADMIN, db, null, ServiceLine.defaultScope());
    const rows = fake.state.history.filter((h) => h.projectId === p.id);
    const stored = JSON.stringify(rows);
    // Still one created row with the note in its snapshot, no separate note row, no comment.
    expect(rows.filter((h) => h.field === "note")).toHaveLength(0);
    const c = rows.find((h) => h.field === "created")!;
    expect(JSON.parse(String(c.newValue)).note).toBe("Vendor quote received Oct 6.");
    expect(c.comment ?? null).toBeNull();
    const t = await ProjectHistoryService.timeline(p.id, ADMIN, db);
    expect(t.notes.map((n) => n.text)).toEqual(["Vendor quote received Oct 6."]);
    const html = renderToStaticMarkup(createElement(UpdateNotesSection, { timeline: UpdateTimeline.toDto(t) }));
    expect(html).toContain("Vendor quote received Oct 6.");
    expect(renderToStaticMarkup(createElement(ProjectHistorySection, { timeline: UpdateTimeline.toDto(t), loading: false }))).toContain(UpdateHistoryCopy.PROJECT_CREATED);
    // Reading never writes.
    expect(JSON.stringify(fake.state.history.filter((h) => h.projectId === p.id))).toBe(stored);
  });

  it("the first note is a read-time view only: reports, PDFs, freezes and handoff.json never read the timeline", () => {
    const users = files("src")
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /UpdateTimeline|ProjectHistoryService\.timeline/.test(SRC(f)))
      .map((f) => f.replace(/\\/g, "/"));
    for (const f of users) expect(f).not.toMatch(/report|pdf|freeze|snapshot|handoff/i);
  });

  it("this PR changes no report, PDF, freeze, snapshot or handoff code (diff against the base commit)", () => {
    let changed: string[];
    try {
      changed = execFileSync("git", ["diff", "--name-only", "d3893fb", "--", "src"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    } catch {
      return; // no git history in this environment (e.g. a tarball); the read-time test above still holds
    }
    expect(changed.filter((f) => /report|pdf|freeze|snapshot|handoff/i.test(f))).toEqual([]);
  });
});

describe("no AI-assisted flag anywhere", () => {
  it("no tag, tooltip, comment or flag in the app code", () => {
    for (const f of files("src").filter((x) => /\.(ts|tsx)$/.test(x))) {
      const s = SRC(f);
      expect(s, f).not.toMatch(/AI-assisted|ai:assisted|aiAssisted|AI_ASSISTED|update-note-ai-assisted|assistedOnSave|aiSuggestionId/);
    }
    expect(Object.keys(AiCopy).filter((k) => k.includes("ASSISTED"))).toEqual([]);
  });

  it("saves and creates take no AI option; the history rows of an edit carry no AI comment", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "Closure device", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Vendor quote", dueDate: "2026-10-03" }, { changedBy: "owner@example.org" }, db);
    await ProjectService.saveForm(p.id, { note: "Quote received Oct 6." } as never, ADMIN, db, null, ServiceLine.defaultScope());
    expect(fake.state.history.filter((h) => h.projectId === p.id).every((h) => !h.comment || !/ai/i.test(String(h.comment)))).toBe(true);
    const admin = SRC("src/app/actions/admin.ts");
    expect(admin).not.toContain("AiWritingService");
    expect(SRC("src/components/ProjectEditForm.tsx")).toContain("const result = await onSubmit(changes, checklist);");
  });

  it("the usage log stays: Accept and Use this text still record their outcome for admin audit", () => {
    const a = SRC("src/components/AiNoteAssistant.tsx");
    expect(a).toContain('log(suggestion.suggestionId, "accepted");');
    expect(a).toContain('log(suggestion.suggestionId, "edited");');
    expect(a).toContain('log(suggestion.suggestionId, "accepted_with_override", numbers.missing.length);');
    expect(SRC("prisma/migrations/0033_ai_writing_assistant/migration.sql")).toContain('CREATE TABLE IF NOT EXISTS "ai_usage_log"');
  });
});
