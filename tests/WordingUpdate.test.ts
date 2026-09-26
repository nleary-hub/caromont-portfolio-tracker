import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { ExportService } from "@/lib/import/ExportService";
import { ImportBlockedError, ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { ProjectService } from "@/lib/services/ProjectService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const ADMIN = "nick.leary@example.org";
const seedActor = { changedBy: "owner@example.org" };

class Sheet {
  /** Parse an export into mutable rows keyed by column. */
  static rows(csv: string): Record<string, string>[] {
    const parsed = ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_WORDING);
    return parsed.rows.map((r) => ({ ...(r.cells as Record<string, string>) }));
  }

  static write(rows: Record<string, string>[], columns: readonly string[] = ProjectCsv.EXPORT_COLUMNS): string {
    const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return [columns.join(","), ...rows.map((r) => columns.map((c) => q(r[c] ?? "")).join(","))].join("\n") + "\n";
  }
}

describe("CSV export and wording update", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  let cathId: string;
  let epId: string;

  beforeEach(async () => {
    fake = new FakeDb();
    db = fake.asClient();
    const ep = await ProjectService.create(
      { name: "PFA launch", serviceArea: "EP", owner: "Owner D", status: "OnTrack", nextMilestone: "First cases", dueDate: "2026-10-28", note: "Two operators credentialed." },
      seedActor,
      db,
    );
    const cath = await ProjectService.create(
      {
        name: "Radial lounge expansion",
        description: "Add recovery bays to the radial lounge.",
        serviceArea: "Cath",
        owner: "Owner B",
        physicianChampion: "Dr. B",
        physicianChampionEmail: "dr.b@example.org",
        status: "AtRisk",
        nextMilestone: "Bid award",
        dueDate: "2026-10-19",
        percentComplete: 30,
        note: "Bids 18% over budget, rebid due 10/12.",
      },
      seedActor,
      db,
    );
    const archived = await ProjectService.create(
      { name: "Old project", serviceArea: "IR", owner: "Owner Z", status: "OnTrack", nextMilestone: "x" },
      seedActor,
      db,
    );
    await ProjectService.softDelete(archived.id, Factory.ADMIN, db);
    cathId = cath.id;
    epId = ep.id;
    fake.writes = [];
    fake.transactions = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  it("export writes id + template columns for non-archived projects in report order", async () => {
    const { csv, count } = await ExportService.exportCsv(db);
    expect(count).toBe(2);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(["id", ...ProjectCsv.TEMPLATE_COLUMNS].join(","));
    const rows = Sheet.rows(csv);
    expect(rows.map((r) => r.id)).toEqual([cathId, epId]);
    expect(lines[0].split(",").slice(0, 3)).toEqual(["id", "name", "description"]);
    expect(rows[1].description).toBe("");
    expect(rows[0]).toMatchObject({
      name: "Radial lounge expansion",
      description: "Add recovery bays to the radial lounge.",
      service_area: "Cath",
      status: "At risk",
      due_date: "2026-10-19",
      percent_complete: "30",
      note: "Bids 18% over budget, rebid due 10/12.",
      include_in_report: "yes",
    });
    expect(fake.writes).toHaveLength(0);
  });

  it("an unedited export round-trips as all unchanged (nothing to commit)", async () => {
    const preview = await ImportService.previewWording((await ExportService.exportCsv(db)).csv, db);
    expect(preview.fileErrors).toEqual([]);
    expect(preview.counts).toEqual({ rows: 2, changed: 0, unchanged: 2, errors: 0 });
    expect(preview.canCommit).toBe(false);
  });

  it("matches rows by id only (order and name edits do not matter for matching)", async () => {
    const rows = Sheet.rows((await ExportService.exportCsv(db)).csv).reverse();
    rows[0].note = "EP wording tightened.";
    rows[1].next_milestone = "Rebid award";
    const preview = await ImportService.previewWording(Sheet.write(rows), db);
    expect(preview.rows.map((r) => [r.id, r.name, r.status])).toEqual([
      [epId, "PFA launch", "change"],
      [cathId, "Radial lounge expansion", "change"],
    ]);

    const missingId = { ...rows[0], id: "" };
    const unknownId = { ...rows[0], id: "00000000-0000-4000-8000-000000000000" };
    const badId = { ...rows[0], id: "PFA launch" };
    const dupId = { ...rows[1] };
    const p2 = await ImportService.previewWording(Sheet.write([rows[1], missingId, unknownId, badId, dupId]), db);
    expect(p2.rows.map((r) => r.errors.id?.[0] ?? null)).toEqual([
      null,
      "id is required to match a project. Export a fresh CSV to get ids.",
      "No project has this id",
      '"pfa launch" is not a project id',
      "Same id as line 2 of this file",
    ]);
    expect(p2.canCommit).toBe(false);
  });

  it("rejects archived projects", async () => {
    const archived = fake.state.projects.find((p) => p.archivedAt)!;
    const row = { ...ProjectCsv.toCells(archived as never), note: "new" };
    const preview = await ImportService.previewWording(Sheet.write([row]), db);
    expect(preview.rows[0].errors.id).toEqual(["This project is archived and cannot be updated"]);
  });

  it("rejects a row when any column other than description / note / next_milestone / accomplishment differs from the database", async () => {
    const [cath] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    const variants: [string, string][] = [
      ["name", "Radial lounge expansion phase 2"],
      ["service_area", "EP"],
      ["owner", "Owner C"],
      ["requester", ""],
      ["requester", "Not applicable"],
      ["status", "On track"],
      ["due_date", "2026-10-20"],
      ["percent_complete", "35"],
      ["include_in_report", "no"],
      ["completed_on", "2026-09-20"],
    ];
    const rows = variants.map(([col, value]) => ({ ...cath, [col]: value, note: "Rewritten note." }));
    // Each variant needs its own file (same id twice is itself an error).
    for (const [i, row] of rows.entries()) {
      const preview = await ImportService.previewWording(Sheet.write([row]), db);
      const [col] = variants[i];
      expect(preview.rows[0].status, col).toBe("error");
      expect(preview.rows[0].errors[col as keyof (typeof preview.rows)[0]["errors"]]?.[0], col).toMatch(
        /A wording update may only change description, note, next_milestone and accomplishment\.$/,
      );
      expect(preview.canCommit).toBe(false);
    }
    const status = await ImportService.previewWording(Sheet.write([{ ...cath, status: "On track" }]), db);
    expect(status.rows[0].errors.status).toEqual([
      'Changed from "At risk" to "On track". A wording update may only change description, note, next_milestone and accomplishment.',
    ]);
    await expect(ImportService.commitWording(Sheet.write([rows[5]]), ADMIN, db)).rejects.toBeInstanceOf(ImportBlockedError);
    expect(fake.writes).toHaveLength(0);
  });

  it("treats equivalent formatting of other columns as unchanged (case, whitespace, M/D/YYYY)", async () => {
    const [cath] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    const row = {
      ...cath,
      service_area: " cath ",
      status: "atrisk",
      due_date: "10/19/2026",
      physician_champion_email: "DR.B@example.org",
      owner: " Owner B ",
      include_in_report: "Y",
    };
    const preview = await ImportService.previewWording(Sheet.write([row]), db);
    expect(preview.rows[0].status).toBe("unchanged");
  });

  it("dry run returns a per-row diff (old versus new) and writes nothing", async () => {
    const [cath, ep] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    cath.note = "  Scope cut to 6 bays; rebid due 10/12.  ";
    cath.next_milestone = "Rebid award";
    ep.note = "";
    const preview = await ImportService.previewWording(Sheet.write([cath, ep]), db);
    expect(preview.rows[0].changes).toEqual([
      { column: "note", old: "Bids 18% over budget, rebid due 10/12.", new: "Scope cut to 6 bays; rebid due 10/12." },
      { column: "next_milestone", old: "Bid award", new: "Rebid award" },
    ]);
    expect(preview.rows[1].changes).toEqual([{ column: "note", old: "Two operators credentialed.", new: null }]);
    expect(preview.counts).toEqual({ rows: 2, changed: 2, unchanged: 0, errors: 0 });
    expect(preview.canCommit).toBe(true);
    expect(fake.writes).toHaveLength(0);
  });

  it("enforces next_milestone max 40 and note max 200, and the milestone-required rule", async () => {
    const [cath] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    const p = await ImportService.previewWording(
      Sheet.write([{ ...cath, next_milestone: "m".repeat(41), note: "n".repeat(201) }]),
      db,
    );
    expect(p.rows[0].errors).toEqual({
      next_milestone: ["Next milestone must be at most 40 characters"],
      note: ["Note must be at most 200 characters"],
    });
    const ok = await ImportService.previewWording(Sheet.write([{ ...cath, next_milestone: "m".repeat(40) }]), db);
    expect(ok.rows[0].status).toBe("change");
    const blank = await ImportService.previewWording(Sheet.write([{ ...cath, next_milestone: "" }]), db);
    expect(blank.rows[0].errors.next_milestone).toEqual([
      "Next milestone is required unless the project is Not started, On hold, Complete or Cancelled",
    ]);
  });

  it("commit updates only note / next_milestone through ProjectService with history (source csv_wording_update)", async () => {
    const [cath, ep] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    cath.note = "Scope cut to 6 bays.";
    cath.next_milestone = "Rebid award";
    const before = { ...fake.state.projects.find((p) => p.id === cathId)! };
    const r = await ImportService.commitWording(Sheet.write([cath, ep]), ADMIN, db);
    expect(r).toMatchObject({ updated: 1, unchanged: 1 });

    const after = fake.state.projects.find((p) => p.id === cathId)!;
    expect(after).toMatchObject({ note: "Scope cut to 6 bays.", nextMilestone: "Rebid award", updatedBy: ADMIN });
    for (const k of ["name", "serviceArea", "owner", "status", "percentComplete", "includeInReport", "dueDate"]) {
      expect(after[k], k).toEqual(before[k]);
    }
    const history = fake.state.history.filter((h) => h.projectId === cathId && h.field !== "created");
    expect(history.map((h) => [h.field, h.oldValue, h.newValue])).toEqual([
      ["nextMilestone", "Bid award", "Rebid award"],
      ["note", "Bids 18% over budget, rebid due 10/12.", "Scope cut to 6 bays."],
    ]);
    expect(history.every((h) => h.changedBy === ADMIN && h.comment === "csv_wording_update")).toBe(true);
    expect(fake.state.history.filter((h) => h.projectId === epId && h.field !== "created")).toHaveLength(0);
    expect(fake.transactions).toBe(1);
  });

  it("commit is all-or-nothing: a failure on a later row rolls back earlier updates", async () => {
    const [cath, ep] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    cath.note = "Changed A";
    ep.note = "Changed B";
    const historyBefore = fake.state.history.length;
    const real = ProjectService.updateInTx.bind(ProjectService);
    let calls = 0;
    vi.spyOn(ProjectService, "updateInTx").mockImplementation(async (tx, id, patch, actor) => {
      calls += 1;
      if (calls === 2) throw new Error("deadlock detected");
      return real(tx, id, patch, actor);
    });
    await expect(ImportService.commitWording(Sheet.write([cath, ep]), ADMIN, db)).rejects.toThrow("deadlock detected");
    expect(fake.state.projects.find((p) => p.id === cathId)!.note).toBe("Bids 18% over budget, rebid due 10/12.");
    expect(fake.state.history).toHaveLength(historyBefore);
  });

  it("requires id, note and next_milestone columns; other columns are compared only when present", async () => {
    const missing = await ImportService.previewWording("id,note\nx,y\n", db);
    expect(missing.fileErrors).toEqual(["Missing required column(s): next_milestone."]);
    const slim = Sheet.write([{ id: cathId, note: "Only wording", next_milestone: "Bid award" }], ["id", "note", "next_milestone"]);
    const preview = await ImportService.previewWording(slim, db);
    expect(preview.rows[0]).toMatchObject({ status: "change", changes: [{ column: "note", new: "Only wording" }] });
  });

  it("export then import round trip keeps description (new projects into an empty database)", async () => {
    const { csv } = await ExportService.exportCsv(db);
    const target = new FakeDb();
    const r = await ImportService.commitCreate(csv, ADMIN, target.asClient());
    expect(r.created).toBe(2);
    const byName = new Map(target.state.projects.map((p) => [p.name, p]));
    expect(byName.get("Radial lounge expansion")!.description).toBe("Add recovery bays to the radial lounge.");
    expect(byName.get("PFA launch")!.description).toBeNull();
    // Exporting the copy gives the same CSV apart from the ids.
    const again = (await ExportService.exportCsv(target.asClient())).csv;
    const strip = (s: string) => s.split("\n").map((l) => l.replace(/^[^,]*,/, ""));
    expect(strip(again)).toEqual(strip(csv));
  });

  it("wording mode can change description, with an old versus new diff and a history row", async () => {
    const [cath, ep] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    cath.description = "Expand the radial lounge from 6 to 8 recovery bays.";
    ep.description = "Launch pulsed field ablation in EP lab 2.";
    const preview = await ImportService.previewWording(Sheet.write([cath, ep]), db);
    expect(preview.rows[0].changes).toEqual([
      {
        column: "description",
        old: "Add recovery bays to the radial lounge.",
        new: "Expand the radial lounge from 6 to 8 recovery bays.",
      },
    ]);
    expect(preview.rows[1].changes).toEqual([
      { column: "description", old: null, new: "Launch pulsed field ablation in EP lab 2." },
    ]);

    await ImportService.commitWording(Sheet.write([cath, ep]), ADMIN, db);
    const history = fake.state.history.filter((h) => h.field === "description");
    expect(history.map((h) => [h.projectId, h.oldValue, h.newValue, h.comment])).toEqual([
      [cathId, "Add recovery bays to the radial lounge.", "Expand the radial lounge from 6 to 8 recovery bays.", "csv_wording_update"],
      [epId, null, "Launch pulsed field ablation in EP lab 2.", "csv_wording_update"],
    ]);
    expect(fake.state.projects.find((p) => p.id === epId)!.description).toBe("Launch pulsed field ablation in EP lab 2.");
  });

  it("wording mode: description max 200, blank clears it, and an absent description column leaves it unchanged", async () => {
    const [cath] = Sheet.rows((await ExportService.exportCsv(db)).csv);
    const tooLong = await ImportService.previewWording(Sheet.write([{ ...cath, description: "d".repeat(201) }]), db);
    expect(tooLong.rows[0].errors.description).toEqual(["Description must be at most 200 characters"]);
    const blank = await ImportService.previewWording(Sheet.write([{ ...cath, description: "" }]), db);
    expect(blank.rows[0].changes).toEqual([{ column: "description", old: "Add recovery bays to the radial lounge.", new: null }]);
    const absent = Sheet.write([{ id: cathId, note: cath.note, next_milestone: cath.next_milestone }], ["id", "note", "next_milestone"]);
    const p = await ImportService.previewWording(absent, db);
    expect(p.rows[0].status).toBe("unchanged");
  });
});
