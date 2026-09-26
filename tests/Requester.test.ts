import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RequesterText } from "@/components/ProjectDashboard";
import { ProjectPeopleEditor, RequesterPicker } from "@/components/ProjectPeopleEditor";
import { Requester } from "@/lib/domain/Requester";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { HistoryDiff } from "@/lib/history/HistoryDiff";
import { ExportService } from "@/lib/import/ExportService";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { ChampionCheck } from "@/lib/report/ChampionCheck";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type RowCell } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidator } from "@/lib/validation/ProjectValidator";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const m = new TextMeasure();
const actor = { changedBy: "owner@example.org" };
type OwnerCell = Extract<RowCell, { kind: "owner" }>;
const csv = (header: string, ...lines: string[]) => [header, ...lines].join("\n") + "\n";

/** The three requester states. */
const STATES = {
  named: { physicianChampion: "Dr. Sample A", requesterNotApplicable: false },
  na: { physicianChampion: null, requesterNotApplicable: true },
  unset: { physicianChampion: null, requesterNotApplicable: false },
} as const;

describe("Requester: domain", () => {
  it("recognizes Not applicable / N/A / NA in any case", () => {
    for (const v of ["Not applicable", "not  APPLICABLE", "N/A", "n/a", "NA", " na "]) expect(Requester.isNotApplicableText(v), v).toBe(true);
    for (const v of ["", "Nate", "N.A.", null]) expect(Requester.isNotApplicableText(v)).toBe(false);
  });

  it("display: name, blank for NA, muted To assign when not yet addressed", () => {
    expect(Requester.display("Dr. A", false)).toEqual({ text: "Dr. A", muted: false });
    expect(Requester.display(null, true)).toBeNull();
    expect(Requester.display(null, false)).toEqual({ text: "To assign", muted: true });
  });

  it("validator: a name wins over NA only when NA is not set; NA always clears the name", () => {
    const base = { name: "P", status: "NotStarted" };
    const r1 = ProjectValidator.validate({ ...base, physicianChampion: "n/a" });
    expect(r1.ok && [r1.data.physicianChampion, r1.data.requesterNotApplicable]).toEqual([null, true]);
    const r2 = ProjectValidator.validate({ ...base, physicianChampion: "Dr. A", requesterNotApplicable: true });
    expect(r2.ok && [r2.data.physicianChampion, r2.data.requesterNotApplicable]).toEqual([null, true]);
  });
});

describe("Requester: dashboard", () => {
  it("renders name, blank for NA, muted To assign; header reads Requester", () => {
    const html = (s: (typeof STATES)[keyof typeof STATES]) =>
      renderToStaticMarkup(createElement(RequesterText, { name: s.physicianChampion, notApplicable: s.requesterNotApplicable }));
    expect(html(STATES.named)).toBe("Dr. Sample A");
    expect(html(STATES.na)).toBe("");
    expect(html(STATES.unset)).toBe('<span class="font-normal text-muted">To assign</span>');
    expect(ViewSettings.columnLabel("dashboard", "physicianChampion")).toBe("Requester");
    expect(ViewSettings.columnLabel("report", "physicianChampion")).toBe("Requester (under Owner)");
  });
});

describe("Requester: report", () => {
  const cell = (row: ReportRow) =>
    ReportLayout.rowLayout(m, row, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE).cells.find((c): c is OwnerCell => c.kind === "owner")!;
  const base = SampleReportData.rows()[0];

  it("owner stack: name; To assign (muted); NA drops the line entirely", () => {
    expect(cell({ ...base, ...STATES.named })).toMatchObject({ champion: "Dr. Sample A", championMissing: false });
    expect(cell({ ...base, ...STATES.unset })).toMatchObject({ champion: "To assign", championMissing: true });
    expect(cell({ ...base, ...STATES.na }).champion).toBeNull();
    // Old snapshots without the flag behave as before (blank = To assign).
    const old: ReportRow = { ...base, ...STATES.unset };
    delete old.requesterNotApplicable;
    expect(cell(old).champion).toBe("To assign");
  });

  it("Completed block follows the same rule", () => {
    const done = SampleReportData.completed()[0];
    const lay = (over: object) =>
      ReportLayout.completedRowLayout(m, { ...done, ...over }, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE, 0).owner!;
    expect(lay(STATES.named).champion).toBe("Dr. Sample A");
    expect(lay(STATES.unset).champion).toBe("To assign");
    expect(lay(STATES.na).champion).toBeNull();
  });

  it("column header under OWNER reads Requester", () => {
    expect(ReportLayout.COLUMN_LABELS.owner.sub(ViewSettings.defaults("report"))).toBe("Requester");
  });
});

describe("Requester: import", () => {
  it("requester column (and physician_champion / champion aliases): name, NA words, blank", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const file = csv("name,department,status,next_milestone,requester", "A,Cath,,Kickoff,Dr. A", "B,Cath,,Kickoff,N/A", "C,Cath,,Kickoff,not applicable", "D,Cath,,Kickoff,");
    const p = await ImportService.previewCreate(file, db);
    expect(p.rows.map((r) => [r.input?.physicianChampion, r.input?.requesterNotApplicable])).toEqual([
      ["Dr. A", false],
      [null, true],
      [null, true],
      [null, false],
    ]);
    for (const header of ["physician_champion", "Champion", "Physician Champion"]) {
      const alias = await ImportService.previewCreate(csv(`name,department,status,next_milestone,${header}`, "A,Cath,,Kickoff,na"), db);
      expect(alias.rows[0].input, header).toMatchObject({ physicianChampion: null, requesterNotApplicable: true });
    }
    await ImportService.commitCreate(file, Factory.ADMIN.email, db);
    expect(fake.state.projects.map((x) => [x.physicianChampion, x.requesterNotApplicable])).toEqual([
      ["Dr. A", false],
      [null, true],
      [null, true],
      [null, false],
    ]);
    const { csv: out } = await ExportService.exportCsv(db);
    const header = out.split("\n")[0].split(",");
    expect(header).toContain("requester");
    expect(header).not.toContain("physician_champion_email");
    expect(out).toContain("Not applicable");
  });

  it("physician_champion_email is ignored with a note; the stored email is kept", async () => {
    const p = await ImportService.previewCreate(csv("name,department,status,next_milestone,physician_champion_email", "A,Cath,,Kickoff,x@example.org"), new FakeDb().asClient());
    expect(p.fileWarnings.join(" ")).toMatch(/physician_champion_email.*not imported/);
    expect(p.rows[0].input?.physicianChampionEmail).toBeUndefined();
    expect(ProjectCsv.TEMPLATE_COLUMNS).not.toContain("physician_champion_email");
  });

  it("wording mode treats a requester change (including to or from NA) as locked", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ImportService.commitCreate(csv("name,department,status,next_milestone,requester", "A,Cath,,Kickoff,NA"), Factory.ADMIN.email, db);
    const { csv: out } = await ExportService.exportCsv(db);
    expect((await ImportService.previewWording(out.replace("Not applicable", "n/a"), db)).rows[0].status).toBe("unchanged");
    expect((await ImportService.previewWording(out.replace("Not applicable", ""), db)).rows[0].status).toBe("error");
  });
});

describe("Requester: edit panel", () => {
  it("setting a name clears NA and setting NA clears the name; each change is in history", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ name: "P", serviceArea: "Cath", status: "OnTrack", nextMilestone: "M1" }, actor, db);
    await ProjectService.setPeopleField(p.id, "requesterNotApplicable", "true", Factory.ADMIN, db);
    expect(fake.state.projects[0]).toMatchObject({ physicianChampion: null, requesterNotApplicable: true });
    await ProjectService.setPeopleField(p.id, "physicianChampion", "Dr. A", Factory.ADMIN, db);
    expect(fake.state.projects[0]).toMatchObject({ physicianChampion: "Dr. A", requesterNotApplicable: false });
    await ProjectService.setPeopleField(p.id, "requesterNotApplicable", "true", Factory.ADMIN, db);
    expect(fake.state.projects[0]).toMatchObject({ physicianChampion: null, requesterNotApplicable: true });
    await ProjectService.setPeopleField(p.id, "physicianChampion", "", Factory.ADMIN, db); // Clear (To assign)
    expect(fake.state.projects[0]).toMatchObject({ physicianChampion: null, requesterNotApplicable: false });
    const h = fake.state.history.filter((x) => x.field !== "created").map((x) => [x.field, x.oldValue, x.newValue]);
    expect(h).toEqual([
      ["requesterNotApplicable", "false", "true"],
      ["physicianChampion", null, "Dr. A"],
      ["requesterNotApplicable", "true", "false"],
      ["physicianChampion", "Dr. A", null],
      ["requesterNotApplicable", "false", "true"],
      ["requesterNotApplicable", "true", "false"],
    ]);
    expect(HistoryDiff.label("physicianChampion")).toBe("Requester");
    expect(HistoryDiff.label("requesterNotApplicable")).toBe("Requester not applicable");
    expect(fake.state.projects[0].note).toBeNull(); // note untouched
  });

  it("closed combobox: name in primary text, Not applicable and To assign in gray; no email field", () => {
    const props = (s: (typeof STATES)[keyof typeof STATES]) => ({
      projectId: "p1",
      owner: null,
      contractsLead: null,
      serviceArea: "Cath" as const,
      ownerSuggestions: [],
      requesterSuggestions: ["Dr. Sample A", "Dr. Sample B"],
      saveAction: async () => null,
      ...s,
    });
    const closed = (s: (typeof STATES)[keyof typeof STATES]) => renderToStaticMarkup(createElement(RequesterPicker, props(s)));
    expect(closed(STATES.named)).toMatch(/role="combobox"[^>]*class="[^"]*text-fg[^"]*"[^>]*value="Dr\. Sample A"/);
    expect(closed(STATES.na)).toMatch(/placeholder="Not applicable"[^>]*class="[^"]*text-muted[^"]*"[^>]*value=""/);
    expect(closed(STATES.unset)).toMatch(/placeholder="To assign"[^>]*class="[^"]*text-muted[^"]*"[^>]*value=""/);
    const panel = renderToStaticMarkup(createElement(ProjectPeopleEditor, props(STATES.named)));
    expect(panel).toContain(">Requester<");
    expect(panel).not.toMatch(/email|Physician champion/i);
  });
});

describe("Requester: missing-requester check", () => {
  it("never flags NA rows, even when an old email is still stored", () => {
    const p = (name: string, over: object) => ({ ...Factory.project({ name, status: "OnTrack" }), ...over });
    const missing = ChampionCheck.findMissing(
      [p("A", { physicianChampion: "Dr. A" }), p("B", { requesterNotApplicable: true, physicianChampionEmail: "old@example.org" })],
      [],
    );
    expect(missing.map((x) => x.name)).toEqual(["Dr. A"]);
  });
});
