import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DisplayName } from "@/lib/auth/DisplayName";
import { FiscalYearRows } from "@/lib/dashboard/FiscalYearRows";
import { FiscalYearSections } from "@/lib/dashboard/FiscalYearSections";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import type { HistoryEntryRecord, ProjectRecord } from "@/lib/domain/types";
import { ClosedProjects } from "@/lib/report/ClosedProjects";
import { YearEndLayout } from "@/lib/report/pdf/YearEndLayout";
import { SignedLink } from "@/lib/report/SignedLink";
import { YearEndCopy, YearEndReportData } from "@/lib/report/YearEndReportData";
import { FreezeService } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReportArchiveService } from "@/lib/services/ReportArchiveService";
import { YearEndReportService } from "@/lib/services/YearEndReportService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

type P = ProjectRecord & { createdAt: Date };
const TODAY = "2026-09-27";
const SRC = path.resolve(__dirname, "../src");

class R {
  static p(over: Omit<Partial<P>, "completedOn"> & { completedOn?: string } = {}): P {
    const { completedOn, ...rest } = over;
    return { ...Factory.project(), createdAt: new Date("2024-08-05T15:00:00Z"), ...rest, completedOn: completedOn ? Factory.date(completedOn) : null } as P;
  }
  static status(projectId: string, iso: string, oldValue: string, newValue: string): HistoryEntryRecord {
    return { projectId, changedAt: new Date(iso), field: "status", oldValue, newValue };
  }
  static src(rel: string): string {
    return readFileSync(path.join(SRC, rel), "utf8");
  }
}

afterEach(() => vi.restoreAllMocks());

describe("CHECK: one fiscal year per closed project, dashboard and PDF agree", () => {
  // Closed projects spread over FY25 to FY27, dated by completedOn, by the day they became Complete, and by cancellation.
  const list = [
    R.p({ name: "C27 entered", status: "Complete", completedOn: "2026-09-02" }),
    R.p({ name: "C27 Jul 1", status: "Complete", completedOn: "2026-07-01" }),
    R.p({ name: "C26 Jun 30", status: "Complete", completedOn: "2026-06-30" }),
    R.p({ name: "C26 in app", status: "Complete" }),
    R.p({ name: "C25", status: "Complete", completedOn: "2025-02-01" }),
    R.p({ name: "X27", status: "Cancelled" }),
    R.p({ name: "X26 twice", status: "Cancelled" }),
    R.p({ name: "Future", status: "Complete", completedOn: "2026-10-15" }),
    R.p({ name: "Open", status: "OnTrack" }),
  ];
  const id = (name: string) => list.find((p) => p.name === name)!.id;
  const history = [
    R.status(id("C26 in app"), "2026-05-20T15:00:00Z", "AtRisk", "Complete"),
    R.status(id("X27"), "2026-08-05T15:00:00Z", "OnHold", "Cancelled"),
    R.status(id("X26 twice"), "2025-10-01T15:00:00Z", "OnTrack", "Cancelled"),
    R.status(id("X26 twice"), "2025-11-01T15:00:00Z", "Cancelled", "OnHold"),
    R.status(id("X26 twice"), "2026-03-01T15:00:00Z", "OnHold", "Cancelled"),
  ];

  it("puts each closed project in exactly one FY section across every year", () => {
    const rows = FiscalYearRows.build({ projects: list, closedHistory: history, history: [], latestUpdates: [], previousSnapshotGeneratedAt: null, today: TODAY });
    const years = FiscalYearSections.years(rows, TODAY);
    expect(years).toEqual(["FY27", "FY26", "FY25"]);
    const seen = new Map<string, string[]>();
    for (const fy of years)
      for (const s of ClosedProjects.STATUSES)
        for (const r of FiscalYearSections.section(rows, fy, s)) seen.set(r.name, [...(seen.get(r.name) ?? []), `${s} ${fy}`]);
    expect(Object.fromEntries(seen)).toEqual({
      "C27 entered": ["Complete FY27"],
      "C27 Jul 1": ["Complete FY27"],
      "C26 Jun 30": ["Complete FY26"],
      "C26 in app": ["Complete FY26"],
      C25: ["Complete FY25"],
      X27: ["Cancelled FY27"],
      "X26 twice": ["Cancelled FY26"],
    });
  });

  it("dashboard sections and year-end PDF sections list the same projects for every year (same visibility inputs)", () => {
    const rows = FiscalYearRows.build({ projects: list, closedHistory: history, history: [], latestUpdates: [], previousSnapshotGeneratedAt: null, today: TODAY });
    for (const fy of ["FY27", "FY26", "FY25"]) {
      const pdf = YearEndReportData.build({ projects: list, history, fiscalYear: fy, today: TODAY, departments: ServiceAreaInfo.CVPSL, serviceLineName: null });
      const pdfIds = (kind: string) => pdf.sections.find((s) => s.kind === kind)!.groups.flatMap((g) => g.rows.map((r) => [r.projectId, r.date]));
      const dash = (s: "Complete" | "Cancelled") => FiscalYearSections.section(rows, fy, s).map((r) => [r.id, r.closedOn]);
      expect(pdfIds("completed").sort()).toEqual(dash("Complete").sort());
      expect(pdfIds("cancelled").sort()).toEqual(dash("Cancelled").sort());
    }
    // Both read the one shared method.
    expect(R.src("lib/dashboard/FiscalYearRows.ts")).toContain("ClosedProjects.closedIn(");
    expect(R.src("lib/report/YearEndReportData.ts")).toContain("ClosedProjects.closedIn(");
  });
});

describe("Review fixes: names, times, PDF copy", () => {
  it("shows the display name, falling back to the email only when there is none", () => {
    expect(DisplayName.of("Nick Leary", "nick.leary@example.org")).toBe("Nick Leary");
    expect(DisplayName.of(" ", "nick.leary@example.org")).toBe("nick.leary@example.org");
    expect(DisplayName.of(null, "nick.leary@example.org")).toBe("nick.leary@example.org");
    // A provider that echoes the email is not a name.
    expect(DisplayName.of("nick.leary@example.org", "nick.leary@example.org")).toBe("nick.leary@example.org");
    expect(DisplayName.nameOrNull("Nick.Leary@Example.org", "nick.leary@example.org")).toBeNull();
    expect(DisplayName.fromEmail("nick.leary@example.org")).toBe("Nick Leary");
  });

  it("stores the name (not the email), footer has the date only, list is newest first with the time", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = ServiceLine.defaultScope();
    const e1 = await YearEndReportService.generate({ ...Factory.ADMIN, name: "Nick Leary" }, "FY27", scope, db, new Date("2026-09-27T04:34:00Z"));
    const e2 = await YearEndReportService.generate({ ...Factory.ADMIN, name: Factory.ADMIN.email }, "FY26", scope, db, new Date("2026-09-27T14:05:00Z"));
    const e3 = await YearEndReportService.generate({ ...Factory.ADMIN, name: "Nick Leary" }, "FY27", scope, db, new Date("2026-09-26T20:00:00Z"));
    expect(fake.state.yearEndReports.map((r) => r.generatedByName)).toEqual(["Nick Leary", null, "Nick Leary"]);
    const list = await YearEndReportService.list(scope, db);
    expect(list.map((e) => e.id)).toEqual([e2.id, e1.id, e3.id]);
    expect(list.map((e) => YearEndReportService.listText(e))).toEqual([
      "FY26 Year-End Report, generated Sep 27, 2026, 10:05 AM ET by admin@example.org",
      "FY27 Year-End Report, generated Sep 27, 2026, 12:34 AM ET by Nick Leary",
      "FY27 Year-End Report, generated Sep 26, 2026, 4:00 PM ET by Nick Leary",
    ]);
    const layout = YearEndLayout.layout(
      YearEndReportData.build({ projects: [], history: [], fiscalYear: "FY27", today: TODAY, departments: ServiceAreaInfo.CVPSL, serviceLineName: null }),
      new Date("2026-09-27T04:34:00Z"),
      DisplayName.of("Nick Leary", "nick.leary@example.org"),
    );
    expect(layout.footerLeft).toBe("Generated Sep 27, 2026 by Nick Leary \u00b7 FY27 Year-End Report");
  }, 30000);

  it("carried table: Status and Latest update; blank updates are a gray en dash; summary head Carried into FY(n+1)", () => {
    expect(YearEndLayout.columnLabels("carried")).toEqual(["Project", "Owner", "Requester", "Status", "Latest update"]);
    expect(YearEndLayout.columnLabels("completed")).toEqual(["Project", "Owner", "Requester", "Completed", "Final update"]);
    expect(YearEndLayout.columnLabels("cancelled")).toEqual(["Project", "Owner", "Requester", "Cancelled", "Final update"]);
    const open = R.p({ name: "Open", status: "OnTrack", note: null });
    const d = YearEndReportData.build({ projects: [open], history: [], fiscalYear: "FY26", today: TODAY, departments: ServiceAreaInfo.CVPSL, serviceLineName: null });
    const layout = YearEndLayout.layout(d, new Date("2026-09-27T04:34:00Z"), "Nick Leary");
    expect(layout.summaryHeads).toEqual(["Completed", "Cancelled", "Carried into FY27"]);
    const row = layout.pages.flatMap((p) => p.blocks).find((b) => b.kind === "row");
    expect(row && row.kind === "row" && row.row.update).toEqual(["\u2013"]);
    expect(YearEndCopy.EMPTY_VALUE).toBe("\u2013");
    // Summary heads and numbers are right-aligned.
    const doc = R.src("lib/report/pdf/YearEndDocument.tsx");
    const summary = doc.slice(doc.indexOf("function Summary"), doc.indexOf("function Block"));
    expect(summary).not.toContain('align="center"');
    expect(summary.match(/align="right"/g)).toHaveLength(2);
  });
});

describe("Frank: year-end PDFs never reach the weekly pipeline", () => {
  const SECRET = "x".repeat(48);
  const ENV = { SHARE_LINK_SECRET: SECRET, APP_BASE_URL: "https://tracker.example.org/", GOOGLE_DRIVE_CLIENT_ID: "cid", GOOGLE_DRIVE_CLIENT_SECRET: "cs", GOOGLE_DRIVE_REFRESH_TOKEN: "rt" };

  it("no Drive upload, no archive entry, no snapshot files, no share link, and the newest frozen report stays the weekly one", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const uploads: string[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at" });
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return json({ files: [{ id: "folder1" }] });
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
        uploads.push(/"name":"([^"]+)"/.exec(Buffer.from(init!.body as Uint8Array).toString("latin1"))![1]);
        return json({ id: `f${uploads.length}`, webViewLink: "https://drive.example/x" });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ serviceArea: "Cath", owner: "A", status: "Complete", nextMilestone: "M", name: "Done", completedOn: "2026-08-01" }, { changedBy: "a@example.org" }, db);
    const scope = ServiceLine.defaultScope();

    // A year-end report before the freeze: nothing but its own row.
    const before = await YearEndReportService.generate({ ...Factory.ADMIN, name: "Nick Leary" }, "FY27", scope, db, new Date("2026-09-29T20:00:00Z"));
    expect(fetch).not.toHaveBeenCalled();
    expect(fake.writes.filter((w) => /^report/.test(w.model))).toEqual([]);
    expect(fake.writes.filter((w) => w.model === "yearEndReport")).toHaveLength(1);
    expect(fake.state.snapshots).toHaveLength(0);
    expect(fake.state.artifacts).toHaveLength(0);
    expect(fake.state.deliveries).toHaveLength(0);

    // The Tuesday freeze uploads exactly the weekly PDF and handoff.json to the Drive folder the Wednesday email reads.
    const r = await FreezeService.run({ trigger: "cron", actor: "cron", env: ENV, now: new Date("2026-09-29T21:30:00Z"), fetch }, db);
    expect(r.outcome).toBe("created");
    expect(uploads).toEqual(["cardiac-portfolio-report-2026-09-29.pdf", "handoff-2026-09-29.json"]);
    expect(uploads).not.toContain(before.fileName);

    // A year-end report after the freeze: still no upload, and the newest frozen report is the weekly snapshot.
    const after = await YearEndReportService.generate({ ...Factory.ADMIN, name: "Nick Leary" }, "FY27", scope, db, new Date("2026-09-29T22:00:00Z"));
    expect(uploads).toHaveLength(2);
    const newest = await db.reportSnapshot.findFirst({ where: { serviceLineId: scope.id }, orderBy: { generatedAt: "desc" } });
    expect(newest?.id).toBe(r.snapshotId);
    expect(fake.state.snapshots).toHaveLength(1);
    expect(fake.state.artifacts.map((a) => a.fileName).sort()).toEqual(["cardiac-portfolio-report-2026-09-29.pdf", "handoff-2026-09-29.json"]);

    // The weekly archive lists only the snapshot; year-end ids resolve to nothing there or through a share link.
    const archive = await ReportArchiveService.list(Factory.ADMIN, db, scope);
    expect(archive.map((a) => a.id)).toEqual([r.snapshotId]);
    for (const e of [before, after]) {
      expect(await ReportArchiveService.file(Factory.ADMIN, e.id, "pdf", db, scope)).toBeNull();
      const token = SignedLink.sign(e.id, new Date("2026-10-06T21:00:00Z"), SECRET);
      expect(await ReportArchiveService.shared(token, "pdf", db, ENV, new Date("2026-09-30T12:00:00Z"))).toBeNull();
    }
    // The share link still serves the weekly PDF (the lookup works; year-end files are simply not in it).
    const weekly = SignedLink.sign(r.snapshotId!, new Date("2026-10-06T21:00:00Z"), SECRET);
    expect((await ReportArchiveService.shared(weekly, "pdf", db, ENV, new Date("2026-09-30T12:00:00Z")))?.fileName).toBe("cardiac-portfolio-report-2026-09-29.pdf");
    vi.unstubAllGlobals();
  }, 60000);

  it("is enforced by separation: the year-end code never imports the weekly pipeline, and the pipeline never reads year_end_report", () => {
    const yearEnd = ["lib/services/YearEndReportService.ts", "lib/report/YearEndRenderer.ts", "lib/report/YearEndReportData.ts", "lib/report/pdf/YearEndLayout.ts", "app/reports/year-end/[id]/route.ts"];
    for (const f of yearEnd) {
      const s = R.src(f);
      for (const weekly of ["GoogleDriveClient", "ReportDeliveryService", "ServiceLineDrive", "SnapshotService", "FreezeService", "ReportArtifactService", "ReportArchiveService", "SignedLink", "HandoffBuilder"]) {
        expect(s, `${f} imports ${weekly}`).not.toContain(weekly);
      }
    }
    const pipeline = [
      "lib/report/GoogleDriveClient.ts",
      "lib/services/ReportDeliveryService.ts",
      "lib/services/FreezeService.ts",
      "lib/services/SnapshotService.ts",
      "lib/services/ReportArtifactService.ts",
      "lib/services/ReportArchiveService.ts",
      "lib/report/SignedLink.ts",
      "lib/report/HandoffBuilder.ts",
      "app/api/share/[token]/[file]/route.ts",
      "app/api/cron/freeze/route.ts",
      "app/reports/[id]/[file]/route.ts",
    ];
    for (const f of pipeline) expect(R.src(f), f).not.toMatch(/yearEnd|YearEnd|year_end/);
  });
});
