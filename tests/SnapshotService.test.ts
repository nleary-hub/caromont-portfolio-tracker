import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import type { MissingChampion, ReportHeader, ReportRow } from "@/lib/domain/types";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };
const period1 = { periodStart: "2026-09-23", periodEnd: "2026-10-07", generatedBy: "nick", now: new Date("2026-10-07T10:00:00Z") };
const period2 = { periodStart: "2026-10-07", periodEnd: "2026-10-21", generatedBy: "nick", now: new Date("2026-10-21T10:00:00Z") };

class Sum {
  static counts(h: ReportHeader): number {
    return Object.values(h.totals).reduce((s, n) => s + n, 0);
  }
}

describe("SnapshotService.create", () => {
  it("freezes only visible rows; counts equal visible rows; never touches projects or recipients", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ ...base, name: "Active", physicianChampion: "Dr. Missing" }, actor, db);
    await ProjectService.create({ ...base, name: "Done", status: "Complete", nextMilestone: null }, actor, db);
    fake.state.recipients.push({ id: "r1", name: "Dr. Present", email: "p@x.org", active: true });
    const projectsBefore = JSON.stringify(fake.state.projects);
    const historyBefore = fake.state.history.length;

    const s1 = await SnapshotService.create(period1, db);
    const rows1 = s1.rowsJson as unknown as ReportRow[];
    expect(rows1.map((r) => r.name)).toEqual(["Active"]);
    expect(rows1.every((r) => r.changed)).toBe(true);
    const header1 = s1.headerJson as unknown as ReportHeader;
    expect(header1.totals).toMatchObject({ OnTrack: 1, Complete: 0 });
    expect(Sum.counts(header1)).toBe(rows1.length);
    expect(header1.totalProjects).toBe(rows1.length);
    expect(JSON.stringify(s1)).not.toContain("Hidden:");
    expect((s1.missingChampionsJson as unknown as MissingChampion[]).map((m) => m.name)).toEqual(["Dr. Missing"]);
    expect(fake.state.recipients).toHaveLength(1);
    expect(JSON.stringify(fake.state.projects)).toBe(projectsBefore);
    expect(fake.state.history).toHaveLength(historyBefore);

    const s2 = await SnapshotService.create(period2, db);
    const rows2 = s2.rowsJson as unknown as ReportRow[];
    expect(rows2.map((r) => r.name)).toEqual(["Active"]);
    expect(rows2[0].changed).toBe(false);
    expect(s2.pdfStorageKey).toBeNull(); // rendering happens later, in FreezeService
  });

  it("excludes projects hidden from the report and deleted projects from rows, counts and champions", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ ...base, name: "Visible", physicianChampion: "Dr. Visible" }, actor, db);
    const hid = await ProjectService.create({ ...base, name: "Secret", physicianChampion: "Dr. Secret" }, actor, db);
    const del = await ProjectService.create({ ...base, name: "Gone", physicianChampion: "Dr. Gone" }, actor, db);
    const dashOnly = await ProjectService.create({ ...base, name: "DashHidden" }, actor, db);
    await ProjectService.setHidden(hid.id, "report", true, Factory.ADMIN, db);
    await ProjectService.setHidden(dashOnly.id, "dashboard", true, Factory.ADMIN, db);
    await ProjectService.softDelete(del.id, Factory.ADMIN, db);

    const s = await SnapshotService.create(period1, db);
    const rows = s.rowsJson as unknown as ReportRow[];
    expect(rows.map((r) => r.name).sort()).toEqual(["DashHidden", "Visible"]);
    const header = s.headerJson as unknown as ReportHeader;
    expect(Sum.counts(header)).toBe(2);
    expect(header.byArea.Cath.OnTrack).toBe(2);
    expect((s.missingChampionsJson as unknown as MissingChampion[]).map((m) => m.name)).toEqual(["Dr. Visible"]);
    const json = JSON.stringify({ rows: s.rowsJson, header: s.headerJson, champions: s.missingChampionsJson });
    expect(json).not.toMatch(/Secret|Gone/);
  });

  it("hide events after the previous report do not set the Changed flag", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ ...base, name: "Active" }, actor, db);
    await SnapshotService.create(period1, db);
    await ProjectService.setHidden(p.id, "dashboard", true, Factory.ADMIN, db);
    // Push the audit row after period1 so it falls in the window.
    fake.state.history.at(-1)!.changedAt = new Date("2026-10-10T10:00:00Z");
    const s2 = await SnapshotService.create(period2, db);
    expect((s2.rowsJson as unknown as ReportRow[])[0].changed).toBe(false);
  });

  it("captures the report view settings in effect at freeze (admin-only), unaffected by later changes", async () => {
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

    await ViewSettingsService.reset("report", actor, db);
    const frozen = fake.state.snapshots[0];
    expect(frozen.viewSettingsJson).toEqual(showClosed);
    const input = PdfReportRenderer.inputFromSnapshot(
      frozen as unknown as Parameters<typeof PdfReportRenderer.inputFromSnapshot>[0],
    );
    expect(input.viewSettings).toEqual(showClosed);

    // Admin-only: stripped for non-admins, kept for admins.
    expect(VisibilityPolicy.snapshotForViewer(frozen, Factory.MEMBER)).not.toHaveProperty("viewSettingsJson");
    expect(VisibilityPolicy.snapshotForViewer(frozen, Factory.ADMIN)).toHaveProperty("viewSettingsJson", showClosed);

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
