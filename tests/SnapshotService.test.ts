import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import type { MissingChampion, ReportHeader, ReportRow } from "@/lib/domain/types";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };
const period1 = { periodStart: "2026-09-23", periodEnd: "2026-10-07", generatedBy: "nick", now: new Date("2026-10-07T10:00:00Z") };
const period2 = { periodStart: "2026-10-07", periodEnd: "2026-10-21", generatedBy: "nick", now: new Date("2026-10-21T10:00:00Z") };

describe("SnapshotService.create", () => {
  it("freezes rows, header counts and missing champions; never touches projects or recipients", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ ...base, name: "Active", physicianChampion: "Dr. Missing" }, actor, db);
    await ProjectService.create({ ...base, name: "Done", status: "Complete", nextMilestone: null }, actor, db);
    fake.state.recipients.push({ id: "r1", name: "Dr. Present", email: "p@x.org", active: true });
    const projectsBefore = JSON.stringify(fake.state.projects);
    const historyBefore = fake.state.history.length;

    const s1 = await SnapshotService.create(period1, db);
    const rows1 = s1.rowsJson as unknown as ReportRow[];
    // Complete is hidden by default: not listed, but counted.
    expect(rows1.map((r) => r.name)).toEqual(["Active"]);
    expect(rows1.every((r) => r.changed)).toBe(true);
    const header1 = s1.headerJson as unknown as ReportHeader;
    expect(header1.totals).toMatchObject({ OnTrack: 1, Complete: 1 });
    expect(header1.byArea.Cath).toMatchObject({ OnTrack: 1, Complete: 1 });
    expect(header1.hiddenLine).toBe("Hidden: Complete (1), Cancelled (0)");
    expect((s1.missingChampionsJson as unknown as MissingChampion[]).map((m) => m.name)).toEqual(["Dr. Missing"]);
    expect(fake.state.recipients).toHaveLength(1); // never auto-adds recipients
    expect(JSON.stringify(fake.state.projects)).toBe(projectsBefore); // no closedReportedAt bookkeeping
    expect(fake.state.history).toHaveLength(historyBefore);

    const s2 = await SnapshotService.create(period2, db);
    const rows2 = s2.rowsJson as unknown as ReportRow[];
    expect(rows2.map((r) => r.name)).toEqual(["Active"]);
    expect(rows2[0].changed).toBe(false);
    expect((s2.headerJson as unknown as ReportHeader).totals.Complete).toBe(1); // closed projects keep counting
    expect(s2.pdfStorageKey).toBeNull(); // PDF renderer is a stub
  });

  it("captures the report view settings in effect at freeze, unaffected by later changes", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ ...base, name: "Active" }, actor, db);
    await ProjectService.create({ ...base, name: "Done", status: "Complete", nextMilestone: null }, actor, db);

    const showClosed = ViewSettings.normalize("report", {
      hiddenStatuses: [],
      hiddenColumns: ["note"],
      columnOrder: ["project", "status", "owner"],
    });
    await ViewSettingsService.update("report", showClosed, actor, db);

    const s1 = await SnapshotService.create(period1, db);
    expect(s1.viewSettingsJson).toEqual(showClosed);
    expect((s1.rowsJson as unknown as ReportRow[]).map((r) => r.name)).toEqual(["Active", "Done"]);

    // Changing settings afterwards does not change the frozen snapshot.
    await ViewSettingsService.reset("report", actor, db);
    const frozen = fake.state.snapshots[0];
    expect(frozen.viewSettingsJson).toEqual(showClosed);
    const input = PdfReportRenderer.inputFromSnapshot(
      frozen as unknown as Parameters<typeof PdfReportRenderer.inputFromSnapshot>[0],
    );
    expect(input.viewSettings).toEqual(showClosed);
    expect(input.rows.map((r) => r.name)).toEqual(["Active", "Done"]);

    const s2 = await SnapshotService.create(period2, db);
    expect(s2.viewSettingsJson).toEqual(ViewSettings.defaults("report"));
    expect((s2.rowsJson as unknown as ReportRow[]).map((r) => r.name)).toEqual(["Active"]);
  });

  it("uses report defaults when no settings row exists", async () => {
    const fake = new FakeDb();
    const s = await SnapshotService.create(period1, fake.asClient());
    expect(s.viewSettingsJson).toEqual(ViewSettings.defaults("report"));
  });
});
