import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppConfig } from "@/lib/config/AppConfig";
import { ImportBlockedError, ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { ProjectService } from "@/lib/services/ProjectService";
import { FakeDb } from "./helpers/FakeDb";

const ADMIN = "nick.leary@example.org";
const HEADER = ProjectCsv.TEMPLATE_COLUMNS.join(",");

class Csv {
  static row(overrides: Partial<Record<string, string>> = {}): string {
    const base: Record<string, string> = {
      name: "Cath lab 3 refresh",
      description: "",
      service_area: "Cath",
      owner: "Owner A",
      physician_champion: "Dr. A",
      physician_champion_email: "dr.a@example.org",
      status: "On track",
      next_milestone: "Equipment install",
      due_date: "2026-10-21",
      percent_complete: "40",
      note: "Vendor install scheduled.",
      include_in_report: "yes",
      ...overrides,
    };
    return ProjectCsv.TEMPLATE_COLUMNS.map((c) => Csv.quote(base[c] ?? "")).join(",");
  }

  static file(...rows: string[]): string {
    return [HEADER, ...rows].join("\n") + "\n";
  }

  static quote(v: string): string {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }
}

describe("ImportService: new projects", () => {
  let fake: FakeDb;
  beforeEach(() => {
    fake = new FakeDb();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validFile = Csv.file(
    Csv.row(),
    Csv.row({ name: "PFA launch", service_area: " ep ", status: "at RISK", due_date: "11/4/2026", percent_complete: "" }),
    Csv.row({ name: "Echo reporting", service_area: "Echo", status: "Complete", next_milestone: "", include_in_report: "no" }),
  );

  it("valid file: dry run writes nothing, commit creates every row", async () => {
    const preview = await ImportService.previewCreate(validFile, fake.asClient());
    expect(preview.fileErrors).toEqual([]);
    expect(preview.counts).toEqual({ rows: 3, ready: 3, skipped: 0, errors: 0 });
    expect(preview.canCommit).toBe(true);
    expect(fake.writes).toHaveLength(0);

    const r = await ImportService.commitCreate(validFile, ADMIN, fake.asClient());
    expect(r.created).toBe(3);
    expect(fake.state.projects).toHaveLength(3);
    const pfa = fake.state.projects.find((p) => p.name === "PFA launch")!;
    expect(pfa).toMatchObject({ serviceArea: "EP", status: "AtRisk", percentComplete: null, updatedBy: ADMIN });
    expect((pfa.dueDate as Date).toISOString()).toBe("2026-11-04T00:00:00.000Z");
    const echo = fake.state.projects.find((p) => p.name === "Echo reporting")!;
    expect(echo).toMatchObject({ status: "Complete", nextMilestone: null, includeInReport: false });
    expect(fake.transactions).toBe(1);
    expect(new Set(fake.writes.map((w) => w.txId)).size).toBe(1);
  });

  it("writes a 'created' history row per project with the admin as actor and source csv_import", async () => {
    await ImportService.commitCreate(validFile, ADMIN, fake.asClient());
    expect(fake.state.history).toHaveLength(3);
    for (const p of fake.state.projects) {
      const rows = fake.state.history.filter((h) => h.projectId === p.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ field: "created", changedBy: ADMIN, comment: ImportService.SOURCE_CREATE });
      expect(JSON.parse(rows[0].newValue as string)).toMatchObject({ name: p.name, serviceArea: p.serviceArea });
    }
    expect(ImportService.SOURCE_CREATE).toBe("csv_import");
  });

  it("bad enum values are row errors with the allowed values", async () => {
    const preview = await ImportService.previewCreate(
      Csv.file(Csv.row({ service_area: "Cardiology" }), Csv.row({ name: "Other", status: "Done" })),
      fake.asClient(),
    );
    expect(preview.rows.map((r) => r.status)).toEqual(["error", "error"]);
    expect(preview.rows[0].errors.service_area?.[0]).toBe(
      '"Cardiology" is not a service area. Use one of: Cath, EP, Echo, CVSS, INU, CardioNeuro, IR',
    );
    expect(preview.rows[1].errors.status?.[0]).toMatch(/^"Done" is not a status\. Use one of: Not started, On track/);
    expect(preview.canCommit).toBe(false);
  });

  it("bad dates are row errors (wrong format and impossible dates)", async () => {
    const preview = await ImportService.previewCreate(
      Csv.file(Csv.row({ due_date: "Oct 21" }), Csv.row({ name: "B", due_date: "2/30/2026" })),
      fake.asClient(),
    );
    expect(preview.rows[0].errors.due_date).toEqual(['"Oct 21" is not a valid date. Use YYYY-MM-DD or M/D/YYYY']);
    expect(preview.rows[1].errors.due_date).toEqual(['"2/30/2026" is not a valid date. Use YYYY-MM-DD or M/D/YYYY']);
  });

  it("note longer than AppConfig.NOTE_MAX_LENGTH is a row error; exactly the max is fine", async () => {
    const preview = await ImportService.previewCreate(
      Csv.file(
        Csv.row({ note: "x".repeat(AppConfig.NOTE_MAX_LENGTH + 1) }),
        Csv.row({ name: "B", note: "x".repeat(AppConfig.NOTE_MAX_LENGTH) }),
      ),
      fake.asClient(),
    );
    expect(preview.rows[0].errors.note).toEqual(["Note must be at most 200 characters"]);
    expect(preview.rows[1].status).toBe("ready");
  });

  it("description is optional: blank is fine, it is imported when present, and max 200 applies", async () => {
    const file = Csv.file(
      Csv.row({ description: "Replace the cath lab 3 imaging system." }),
      Csv.row({ name: "B", description: "" }),
      Csv.row({ name: "C", description: "d".repeat(201) }),
      Csv.row({ name: "D", description: "d".repeat(200) }),
    );
    const preview = await ImportService.previewCreate(file, fake.asClient());
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "ready", "error", "ready"]);
    expect(preview.rows[2].errors.description).toEqual(["Description must be at most 200 characters"]);

    const ok = Csv.file(Csv.row({ description: "Replace the cath lab 3 imaging system." }), Csv.row({ name: "B", description: "  " }));
    await ImportService.commitCreate(ok, ADMIN, fake.asClient());
    expect(fake.state.projects.map((p) => p.description)).toEqual(["Replace the cath lab 3 imaging system.", null]);
    expect(JSON.parse(fake.state.history[0].newValue as string).description).toBe("Replace the cath lab 3 imaging system.");
  });

  it("a file without the description column still imports (description stays empty)", async () => {
    const cols = ProjectCsv.TEMPLATE_COLUMNS.filter((c) => c !== "description" && c !== "infor_request_number");
    const file = `${cols.join(",")}\nNo desc project,Cath,Owner A,,,On track,Kickoff,,,,\n`;
    const r = await ImportService.commitCreate(file, ADMIN, fake.asClient());
    expect(r.created).toBe(1);
    expect(fake.state.projects[0].description).toBeNull();
  });

  it("next milestone longer than 40 characters is a row error", async () => {
    const preview = await ImportService.previewCreate(Csv.file(Csv.row({ next_milestone: "m".repeat(41) })), fake.asClient());
    expect(preview.rows[0].errors.next_milestone).toEqual(["Next milestone must be at most 40 characters"]);
  });

  it("other ProjectValidator rules surface per column (milestone required, percent, email, required text)", async () => {
    const preview = await ImportService.previewCreate(
      Csv.file(
        Csv.row({ next_milestone: "" }),
        Csv.row({ name: "B", percent_complete: "140" }),
        Csv.row({ name: "C", physician_champion_email: "not-an-email" }),
        Csv.row({ name: "", owner: "" }),
        Csv.row({ name: "E", include_in_report: "maybe", percent_complete: "abc" }),
      ),
      fake.asClient(),
    );
    const [a, b, c, d, e] = preview.rows;
    expect(a.errors.next_milestone).toEqual(["Next milestone is required unless the project is Complete or Cancelled"]);
    expect(b.errors.percent_complete).toEqual(["Percent complete must be between 0 and 100"]);
    expect(c.errors.physician_champion_email).toEqual(["Physician champion email is not a valid email"]);
    expect(d.errors).toMatchObject({ name: ["Name is required"] });
    expect(d.errors).not.toHaveProperty("owner"); // owner is optional ("To assign")
    expect(e.errors).toMatchObject({ include_in_report: ['"maybe" is not yes or no'], percent_complete: ['"abc" is not a number'] });
    expect(preview.rows.map((r) => r.line)).toEqual([2, 3, 4, 5, 6]);
  });

  it("duplicates by (name, service area) against non-archived projects are skipped with a warning, never overwritten", async () => {
    const db = fake.asClient();
    const existing = await ProjectService.create(
      { name: "Cath Lab 3 Refresh", serviceArea: "Cath", owner: "Original owner", status: "OnHold", nextMilestone: "Original" },
      { changedBy: "someone@example.org" },
      db,
    );
    const archived = await ProjectService.create(
      { name: "PFA launch", serviceArea: "EP", owner: "Old", status: "OnTrack", nextMilestone: "Old" },
      { changedBy: "someone@example.org" },
      db,
    );
    await ProjectService.softDelete(archived.id, { email: "someone@example.org", isAdmin: true }, db);
    const historyBefore = fake.state.history.length;

    const file = Csv.file(
      Csv.row({ name: "  cath lab 3   refresh ", owner: "New owner" }), // same as existing (case/whitespace)
      Csv.row({ name: "Cath lab 3 refresh", service_area: "EP" }), // same name, different area: not a duplicate
      Csv.row({ name: "PFA launch", service_area: "EP" }), // only matches an archived project: not a duplicate
    );
    const preview = await ImportService.previewCreate(file, db);
    expect(preview.rows.map((r) => r.status)).toEqual(["skipped", "ready", "ready"]);
    expect(preview.rows[0].warnings[0]).toMatch(/already exists in Cath\. Skipped; the existing project is not changed\./);
    expect(preview.canCommit).toBe(true);

    const r = await ImportService.commitCreate(file, ADMIN, db);
    expect(r).toMatchObject({ created: 2, skipped: 1 });
    const stillThere = fake.state.projects.find((p) => p.id === existing.id)!;
    expect(stillThere).toMatchObject({ owner: "Original owner", status: "OnHold", nextMilestone: "Original" });
    expect(fake.state.history.filter((h) => h.projectId === existing.id)).toHaveLength(1);
    expect(fake.state.history.length).toBe(historyBefore + 2);
  });

  it("the same (name, service area) twice in one file is an error on the later row", async () => {
    const preview = await ImportService.previewCreate(Csv.file(Csv.row(), Csv.row({ name: "CATH LAB 3 REFRESH" })), fake.asClient());
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "error"]);
    expect(preview.rows[1].errors.name).toEqual(["Same name and service area as line 2 of this file"]);
  });

  it("template example rows are skipped with a warning", async () => {
    const preview = await ImportService.previewCreate(ProjectCsv.templateCsv(), fake.asClient());
    expect(preview.counts).toEqual({ rows: 2, ready: 0, skipped: 2, errors: 0 });
    expect(preview.canCommit).toBe(false);
  });

  it("any row error blocks the whole commit and nothing is written", async () => {
    const file = Csv.file(Csv.row(), Csv.row({ name: "B", status: "Nope" }));
    await expect(ImportService.commitCreate(file, ADMIN, fake.asClient())).rejects.toBeInstanceOf(ImportBlockedError);
    expect(fake.state.projects).toHaveLength(0);
    expect(fake.state.history).toHaveLength(0);
  });

  it("rolls back every row when a write fails mid-transaction", async () => {
    const real = ProjectService.createInTx.bind(ProjectService);
    let calls = 0;
    vi.spyOn(ProjectService, "createInTx").mockImplementation(async (tx, input, actor) => {
      calls += 1;
      if (calls === 3) throw new Error("connection reset");
      return real(tx, input, actor);
    });
    const file = Csv.file(Csv.row(), Csv.row({ name: "B" }), Csv.row({ name: "C" }), Csv.row({ name: "D" }));
    await expect(ImportService.commitCreate(file, ADMIN, fake.asClient())).rejects.toThrow("connection reset");
    expect(calls).toBe(3);
    expect(fake.writes.length).toBeGreaterThan(0); // two projects were written, then rolled back
    expect(fake.state.projects).toHaveLength(0);
    expect(fake.state.history).toHaveLength(0);
  });

  it("file-level problems block the import", async () => {
    const tooMany = Csv.file(...Array.from({ length: AppConfig.IMPORT_MAX_ROWS + 1 }, (_, i) => Csv.row({ name: `P${i}` })));
    const preview = await ImportService.previewCreate(tooMany, fake.asClient());
    expect(preview.fileErrors[0]).toMatch(/limit is 500 per import/);
    expect(preview.canCommit).toBe(false);
    const missing = await ImportService.previewCreate("name,owner\nA,B\n", fake.asClient());
    expect(missing.fileErrors).toEqual(["Missing required column(s): service_area, status."]);
    expect(missing.rows).toEqual([]);
  });
});
