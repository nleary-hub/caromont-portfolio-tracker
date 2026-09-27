import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { Assignee } from "@/lib/domain/Assignee";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import type { CompletedRow, ReportHeader, ReportRow } from "@/lib/domain/types";
import { ExportService } from "@/lib/import/ExportService";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { CompletedThisPeriod } from "@/lib/report/CompletedThisPeriod";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { CompletedBlockStyle, ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { stringify } from "csv-stringify/sync";
import { DraftReportService } from "@/lib/services/DraftReportService";
import { FreezeService } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "owner@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };
const m = new TextMeasure();

class Clock {
  /** Move every history entry of a project (optionally one field) to a fixed time. */
  static set(fake: FakeDb, projectId: string, at: string, field?: string): void {
    for (const h of fake.state.history) if (h.projectId === projectId && (!field || h.field === field)) h.changedAt = new Date(at);
  }
  static period(end: string, now: string) {
    return { periodStart: "2026-09-01", periodEnd: end, generatedBy: "nick", now: new Date(now) };
  }
}

class Csv {
  static write(rows: Record<string, string>[], columns: readonly string[]): string {
    return stringify([columns as string[], ...rows.map((r) => columns.map((c) => r[c] ?? ""))], { record_delimiter: "\n" });
  }
}

class Setup {
  static async db(): Promise<{ fake: FakeDb; db: PrismaClient }> {
    const fake = new FakeDb();
    return { fake, db: fake.asClient() };
  }
  static rows(s: { rowsJson: unknown }): string[] {
    return (s.rowsJson as ReportRow[]).map((r) => r.name);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("Completed this period: clock", () => {
  it("uses the status change to Complete from history, not completedOn", async () => {
    const { fake, db } = await Setup.db();
    const p = await ProjectService.create({ ...base, name: "Changed later", completedOn: "2026-01-05" }, actor, db);
    await ProjectService.update(p.id, { status: "Complete" }, actor, db);
    Clock.set(fake, p.id, "2026-09-10T15:00:00Z", "created");
    Clock.set(fake, p.id, "2026-09-20T15:00:00Z", "status");
    const project = fake.state.projects.find((x) => x.id === p.id)!;
    expect(CompletedThisPeriod.completedAt(project as never, fake.state.history as never)).toEqual(new Date("2026-09-20T15:00:00Z"));

    // Not yet Complete at the cutoff: not listed. After: a regular row in its department (Complete chip).
    const before = await SnapshotService.create(Clock.period("2026-09-15", "2026-09-15T21:00:00Z"), db);
    expect(Setup.rows(before)).toEqual([]);
    const after = await SnapshotService.create({ ...Clock.period("2026-09-29", "2026-09-29T21:00:00Z"), periodStart: "2026-09-15" }, db);
    expect((after.rowsJson as unknown as ReportRow[])[0]).toMatchObject({ name: "Changed later", status: "Complete", completedInPeriod: true });
    expect(after.completedJson).toEqual([]);
  });

  it("uses the creation or import time when the project was created as Complete", async () => {
    const { fake, db } = await Setup.db();
    const p = await ProjectService.create({ ...base, name: "Imported done", status: "Complete" }, actor, db);
    Clock.set(fake, p.id, "2026-09-12T14:00:00Z");
    const project = fake.state.projects.find((x) => x.id === p.id)!;
    expect(CompletedThisPeriod.completedAt(project as never, fake.state.history as never)).toEqual(new Date("2026-09-12T14:00:00Z"));
    const s = await SnapshotService.create(Clock.period("2026-09-15", "2026-09-15T21:00:00Z"), db);
    expect(Setup.rows(s)).toEqual(["Imported done"]);
  });

  it("CSV import of a Complete row starts the clock at the import", async () => {
    const { fake, db } = await Setup.db();
    const csv = Csv.write(
      [
        {
          ...Object.fromEntries(ProjectCsv.TEMPLATE_COLUMNS.map((c) => [c, ""])),
          name: "Import done",
          service_area: "EP",
          owner: "Owner B",
          status: "Complete",
          accomplishment: "  Go-live finished.  ",
          completed_on: "9/18/2026",
        },
      ],
      ProjectCsv.TEMPLATE_COLUMNS,
    );
    await ImportService.commitCreate(csv, Factory.ADMIN.email, db);
    const p = fake.state.projects[0];
    expect(p.accomplishment).toBe("Go-live finished.");
    expect(p.completedOn).toEqual(new Date("2026-09-18T00:00:00Z"));
    const at = CompletedThisPeriod.completedAt(p as never, fake.state.history as never);
    expect(at).toEqual(fake.state.history.find((h) => h.field === "created")!.changedAt);
  });
});

describe("Completed this period: once only", () => {
  it("lists a project in the first freeze after completion only; drafts never mark", async () => {
    const { fake, db } = await Setup.db();
    const p = await ProjectService.create({ ...base, name: "Done once", status: "Complete", accomplishment: "Shipped." }, actor, db);
    Clock.set(fake, p.id, "2026-09-10T14:00:00Z");

    // Draft ("Generate PDF now") shows it but does not mark it.
    const draft = await DraftReportService.render(Factory.ADMIN, db, new Date("2026-09-14T14:00:00Z"));
    expect(draft).not.toBeNull();
    expect(fake.state.projects[0].completionReportedAt).toBeNull();

    const s1 = await SnapshotService.create(Clock.period("2026-09-15", "2026-09-15T21:00:00Z"), db);
    expect(Setup.rows(s1)).toEqual(["Done once"]);
    expect(fake.state.projects[0].completionReportedAt).toEqual(new Date("2026-09-15T21:00:00Z"));

    const s2 = await SnapshotService.create({ ...Clock.period("2026-09-29", "2026-09-29T21:00:00Z"), periodStart: "2026-09-15" }, db);
    expect(Setup.rows(s2)).toEqual([]);
    // No history row for the bookkeeping stamp.
    expect(fake.state.history.some((h) => h.field === "completionReportedAt")).toBe(false);
  });

  it("reopening and completing again lists the project again in the next report", async () => {
    const { fake, db } = await Setup.db();
    const p = await ProjectService.create({ ...base, name: "Reopened", status: "Complete" }, actor, db);
    Clock.set(fake, p.id, "2026-09-10T14:00:00Z");
    await SnapshotService.create(Clock.period("2026-09-15", "2026-09-15T21:00:00Z"), db);
    expect(fake.state.projects[0].completionReportedAt).not.toBeNull();

    await ProjectService.update(p.id, { status: "AtRisk" }, actor, db);
    expect(fake.state.projects[0].completionReportedAt).toBeNull();
    await ProjectService.update(p.id, { status: "Complete" }, actor, db);
    Clock.set(fake, p.id, "2026-09-20T14:00:00Z", "status");
    const s2 = await SnapshotService.create({ ...Clock.period("2026-09-29", "2026-09-29T21:00:00Z"), periodStart: "2026-09-15" }, db);
    expect(Setup.rows(s2)).toEqual(["Reopened"]);
  });

  it("re-running the same freeze keeps the frozen rows; handoff.json lists no block", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    const p = await ProjectService.create({ ...base, name: "Frozen done", status: "Complete" }, actor, db);
    Clock.set(fake, p.id, "2026-09-20T14:00:00Z");
    const opts = {
      trigger: "cron" as const,
      actor: "cron",
      env: { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/" },
      now: new Date("2026-09-29T21:00:00Z"),
      fetch: vi.fn(),
    };
    const r1 = await FreezeService.run(opts, db);
    expect(r1.outcome).toBe("created");
    // Lose the artifacts to force the "complete missing steps" path; the frozen rows must survive.
    fake.state.artifacts.length = 0;
    const r2 = await FreezeService.run({ ...opts, trigger: "manual", actor: "admin@example.org", now: new Date("2026-09-29T22:00:00Z") }, db);
    expect(r2.outcome).toBe("already_frozen");
    expect(fake.state.snapshots).toHaveLength(1);
    expect(Setup.rows(fake.state.snapshots[0] as never)).toEqual(["Frozen done"]);
    const handoff = JSON.parse(Buffer.from(fake.state.artifacts.find((a) => a.kind === "handoff")!.bytes as Uint8Array).toString("utf8"));
    expect(handoff.completedThisPeriod).toEqual({ count: 0, projects: [] });
    expect(handoff.totals).toEqual({ projects: 1, byStatus: { Complete: 1 } });
    expect(handoff.byArea.find((a: { area: string }) => a.area === "Cath")).toMatchObject({ projects: 1, byStatus: { Complete: 1 } });
  });

  it("is not listed when hidden from the report; with Complete shown it is still listed only for its period", async () => {
    const { fake, db } = await Setup.db();
    const a = await ProjectService.create({ ...base, name: "Hidden done", status: "Complete" }, actor, db);
    await ProjectService.setHidden(a.id, "report", true, Factory.ADMIN, db);
    Clock.set(fake, a.id, "2026-09-10T14:00:00Z");
    const s1 = await SnapshotService.create(Clock.period("2026-09-15", "2026-09-15T21:00:00Z"), db);
    expect(Setup.rows(s1)).toEqual([]);

    const settings = ViewSettings.defaults("report");
    const shown = { ...settings, hiddenStatuses: settings.hiddenStatuses.filter((x) => x !== "Complete") };
    const project = Factory.project({ status: "Complete" });
    const { rows } = ReportBuilder.build({ projects: [project], history: [], previousSnapshotGeneratedAt: null, reportDate: "2026-09-15", viewSettings: shown, completedInPeriod: new Set([project.id]) });
    expect(rows).toHaveLength(1);
    expect(rows[0].completedInPeriod).toBe(true);
    // Showing Complete in the settings does not bring back a project completed before the period.
    expect(ReportBuilder.build({ projects: [project], history: [], previousSnapshotGeneratedAt: null, reportDate: "2026-09-15", viewSettings: shown }).rows).toEqual([]);
  });
});

describe("Completed this period: counts", () => {
  it("counts in its department, the totals and the projects line; the grid gets a Complete column", async () => {
    const { fake, db } = await Setup.db();
    await ProjectService.create({ ...base, name: "Active" }, actor, db);
    const p = await ProjectService.create({ ...base, name: "Done", status: "Complete" }, actor, db);
    Clock.set(fake, p.id, "2026-09-10T14:00:00Z");
    const s = await SnapshotService.create(Clock.period("2026-09-15", "2026-09-15T21:00:00Z"), db);
    const header = s.headerJson as unknown as ReportHeader;
    expect((s.rowsJson as unknown as ReportRow[]).map((r) => r.name)).toEqual(["Active", "Done"]);
    expect(header.totalProjects).toBe(2);
    expect(header.totals.Complete).toBe(1);
    const layout = ReportLayout.layout(
      SampleReportData.docInput({ rows: s.rowsJson as unknown as ReportRow[], header, completed: s.completedJson as unknown as CompletedRow[] }),
      m,
    );
    expect(layout.header.projectsLine).toBe("2 projects across 1 department");
    expect(layout.header.completedFy).toMatchObject({ label: expect.stringMatching(/^Completed FY\d\d to date$/), count: 1 });
    const total = layout.header.grid.rows.at(-1)!;
    expect(total.cells.at(-1)).toBe(2);
    expect(layout.header.grid.columns.map((c) => c.key)).toContain("Complete");
    const section = layout.pages[0].blocks.find((b) => b.kind === "section")!;
    expect(section.kind === "section" && section.count).toBe(2);
    expect(layout.pages.flatMap((pg) => pg.blocks).some((b) => b.kind === "completed")).toBe(false);
  });

  it("section head text omits the completed part when zero", () => {
    expect(ReportLayout.sectionCountText(2, 2)).toBe("2 projects \u00b7 2 completed this period");
    expect(ReportLayout.sectionCountText(1, 0)).toBe("1 project");
    expect(ReportLayout.sectionCountText(0, 1)).toBe("1 completed this period");
  });
});

describe("Completed this period: CSV", () => {
  it("round-trips accomplishment and completed_on; wording mode updates accomplishment only", async () => {
    const { fake, db } = await Setup.db();
    await ProjectService.create(
      { ...base, name: "Done", status: "Complete", accomplishment: "Go-live on all rooms.", completedOn: "2026-09-18" },
      actor,
      db,
    );
    const { csv } = await ExportService.exportCsv(db);
    const parsed = ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_WORDING);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.fileWarnings).not.toContainEqual(expect.stringMatching(/accomplishment|completed_on/));
    const cells = parsed.rows[0].cells as Record<string, string>;
    expect(cells.accomplishment).toBe("Go-live on all rooms.");
    expect(cells.completed_on).toBe("2026-09-18");

    const copy = new FakeDb();
    await ImportService.commitCreate(csv, Factory.ADMIN.email, copy.asClient());
    expect(copy.state.projects[0]).toMatchObject({ accomplishment: "Go-live on all rooms.", completedOn: new Date("2026-09-18T00:00:00Z") });

    const header = csv.split("\n")[0];
    const edit = (col: string, value: string) => {
      const cols = header.split(",");
      const i = cols.indexOf(col);
      return csv.split("\n").map((l, n) => (n === 1 ? l.split(",").map((c, j) => (j === i ? value : c)).join(",") : l)).join("\n");
    };
    const wording = await ImportService.previewWording(edit("accomplishment", "Go-live in all four rooms."), db);
    expect(wording.rows[0].changes).toEqual([{ column: "accomplishment", old: "Go-live on all rooms.", new: "Go-live in all four rooms." }]);
    const locked = await ImportService.previewWording(edit("completed_on", "2026-09-19"), db);
    expect(locked.rows[0].status).toBe("error");
    expect(locked.canCommit).toBe(false);
    await ImportService.commitWording(edit("accomplishment", "Go-live in all four rooms."), Factory.ADMIN.email, db);
    expect(fake.state.projects[0].accomplishment).toBe("Go-live in all four rooms.");
  });

  it("rejects an accomplishment over 200 characters and a bad completed_on date", async () => {
    const { db } = await Setup.db();
    const row = { name: "X", service_area: "EP", owner: "O", status: "Complete", next_milestone: "" };
    const csv = Csv.write([{ ...row, accomplishment: "a".repeat(201), completed_on: "Sept 18" }], ProjectCsv.TEMPLATE_COLUMNS);
    const preview = await ImportService.previewCreate(csv, db);
    expect(Object.keys(preview.rows[0].errors)).toEqual(expect.arrayContaining(["accomplishment", "completed_on"]));
    const ok = await ImportService.previewCreate(Csv.write([{ ...row, accomplishment: "a".repeat(200), completed_on: "2026-09-18" }], ProjectCsv.TEMPLATE_COLUMNS), db);
    expect(ok.rows[0].errors).toEqual({});
  });
});

describe("Completed this period: PDF layout", () => {
  const input = SampleReportData.docInput({});
  const layout = ReportLayout.layout(input, m);
  const blocks = layout.pages.flatMap((p) => p.blocks);
  const completed = blocks.filter((b) => b.kind === "completed");

  it("adds one block at the end of each department group with completed projects", () => {
    expect(completed.map((b) => b.area)).toEqual(["Cath", "EP"]);
    for (const b of completed) {
      const i = blocks.indexOf(b);
      const next = blocks[i + 1];
      expect(!next || next.kind === "section").toBe(true);
      expect(blocks.slice(0, i).filter((x) => x.kind === "row").at(-1)!.area).toBe(b.area);
    }
    const cath = blocks.find((b) => b.kind === "section" && b.area === "Cath")!;
    expect(cath.kind === "section" && ReportLayout.sectionCountText(cath.count, cath.completedCount)).toBe("4 projects \u00b7 2 completed this period");
  });

  it("never splits a block across pages", () => {
    for (const p of layout.pages) for (const b of p.blocks) if (b.kind === "completed") expect(b.y + b.height).toBeLessThanOrEqual(p.bodyHeight);
  });

  it("aligns columns: name in project, champion under owner, date in status, accomplishment from next milestone (max 2 lines)", () => {
    const cols = ReportLayout.columns(ViewSettings.defaults("report"));
    const x = (k: string) => cols.find((c) => c.key === k)!.x;
    const [cath] = completed;
    if (cath.kind !== "completed") throw new Error("expected a completed block");
    const [first, second] = cath.rows;
    expect(first.name.x).toBe(x("project") + CompletedBlockStyle.INSET);
    expect(first.req?.text).toBe("REQ-4871");
    expect(second.req).toBeNull();
    expect(first.owner).toMatchObject({ x: x("owner"), owner: "Owner C", champion: "Dr. Sample K" });
    expect(second.owner).toMatchObject({ owner: Assignee.TO_ASSIGN, ownerMissing: true });
    expect(second.owner!.champion).toBe(Assignee.TO_ASSIGN);
    expect(first.date).toMatchObject({ x: x("status"), text: "Sep 22" });
    expect(first.accomplishment!.x).toBe(x("nextMilestone"));
    const long = ReportLayout.completedRowLayout(m, { ...SampleReportData.completed()[0], accomplishment: "word ".repeat(80).trim() }, ViewSettings.defaults("report"), input.reportDate, 0);
    expect(long.accomplishment!.lines).toHaveLength(CompletedBlockStyle.ACCOMPLISHMENT_MAX_LINES);
  });

  it("hides the REQ slot with the Infor column", () => {
    const settings = ViewSettings.defaults("report");
    const hidden = { ...settings, hiddenColumns: [...settings.hiddenColumns, "inforNumber" as const] };
    const r = ReportLayout.completedRowLayout(m, SampleReportData.completed()[0], hidden, input.reportDate, 0);
    expect(r.req).toBeNull();
  });

  it("page 1 shows the FY-to-date count (not a period count); no block for snapshots without completedJson", () => {
    expect(layout.header.completedFy).toEqual({ label: "Completed FY27 to date", count: SampleReportData.FY_COMPLETED });
    expect(layout.header.completedAt).not.toBeNull();
    const old = ReportLayout.layout(SampleReportData.docInput({ completed: undefined }), m);
    expect(old.header.completedFy).not.toBeNull(); // the FY count lives in the header, not in completedJson
    expect(old.pages.flatMap((p) => p.blocks).some((b) => b.kind === "completed")).toBe(false);
  });

  it("renders the PDF with the block", async () => {
    const bytes = await PdfReportRenderer.renderDocument(input);
    expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(10_000);
  }, 60_000);
});
