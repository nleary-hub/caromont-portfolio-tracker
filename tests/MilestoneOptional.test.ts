import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ImportService } from "@/lib/import/ImportService";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type RowCell } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectValidator } from "@/lib/validation/ProjectValidator";
import { FakeDb } from "./helpers/FakeDb";

const base = { name: "P", serviceArea: "Cath", owner: "Owner A", nextMilestone: "" };
const actor = { changedBy: "owner@example.org" };

describe("Next milestone may be blank for Not started, On hold, Complete, Cancelled", () => {
  it("validator", () => {
    for (const status of ["NotStarted", "OnHold", "Complete", "Cancelled"]) {
      const r = ProjectValidator.validate({ ...base, status });
      expect(r.ok, status).toBe(true);
      expect(r.ok && r.data.nextMilestone).toBeNull();
    }
    for (const status of ["OnTrack", "AtRisk", "OffTrack"]) {
      const r = ProjectValidator.validate({ ...base, status });
      expect(r.ok, status).toBe(false);
      if (!r.ok) expect(r.errors.nextMilestone).toEqual([ProjectValidator.MILESTONE_REQUIRED_MESSAGE]);
    }
  });

  it("CSV create and ProjectService update follow the same rule", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const csv = "name,service_area,status,next_milestone\nA,Cath,Not started,\nB,Cath,On hold,\nC,Cath,On track,\nD,Cath,,\n";
    const preview = await ImportService.previewCreate(csv, db);
    expect(preview.rows.map((r) => r.status)).toEqual(["ready", "ready", "error", "error"]);
    expect(preview.rows[3].errors.next_milestone).toEqual([ProjectValidator.MILESTONE_REQUIRED_MESSAGE]); // blank status = On track
    const p = await ProjectService.create({ ...base, status: "OnHold" }, actor, db);
    await expect(ProjectService.update(p.id, { status: "OnTrack" }, actor, db)).rejects.toThrow();
    await ProjectService.update(p.id, { status: "NotStarted" }, actor, db);
    expect(fake.state.projects[0].status).toBe("NotStarted");
  });

  it("report renders a blank milestone as nothing (no dash)", () => {
    const m = new TextMeasure();
    const row = { ...SampleReportData.rows()[0], status: "OnHold" as const, nextMilestone: null };
    const r = ReportLayout.rowLayout(m, row, ViewSettings.defaults("report"), SampleReportData.REPORT_DATE);
    const cell = r.cells.find((c): c is Extract<RowCell, { kind: "nextMilestone" }> => c.kind === "nextMilestone")!;
    expect(cell.lines).toEqual([]);
  });

});
