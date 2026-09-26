import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectCsv } from "@/lib/import/ProjectCsv";

describe("ProjectCsv", () => {
  it("committed docs/project-import-template.csv matches the downloadable template", () => {
    const committed = readFileSync(path.resolve(__dirname, "../docs/project-import-template.csv"), "utf8");
    expect(committed).toBe(ProjectCsv.templateCsv());
  });

  it("template has the documented columns and two fake example rows", () => {
    const parsed = ProjectCsv.parse(ProjectCsv.templateCsv(), ProjectCsv.REQUIRED_FOR_CREATE);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.columns).toEqual([
      "name",
      "description",
      "infor_request_number",
      "service_area",
      "owner",
      "requester",
      "contracts_lead",
      "status",
      "next_milestone",
      "due_date",
      "percent_complete",
      "note",
      "accomplishment",
      "completed_on",
      "include_in_report",
    ]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.every((r) => ProjectCsv.isExampleRow(r))).toBe(true);
    expect(ProjectCsv.templateCsv()).not.toContain("\u2014");
  });

  it("tolerates case and whitespace in enums and headers", () => {
    expect(ProjectCsv.resolveServiceArea(" cardio neuro ")).toBe("CardioNeuro");
    expect(ProjectCsv.resolveServiceArea("ep")).toBe("EP");
    expect(ProjectCsv.resolveServiceArea("Cardiology")).toBeNull();
    expect(ProjectCsv.resolveStatus("  on TRACK ")).toBe("OnTrack");
    expect(ProjectCsv.resolveStatus("OffTrack")).toBe("OffTrack");
    expect(ProjectCsv.resolveStatus("not_started")).toBe("NotStarted");
    expect(ProjectCsv.resolveStatus("Done")).toBeNull();
    expect(ProjectCsv.normalizeHeader(" Service Area ")).toBe("service_area");
  });

  it("accepts YYYY-MM-DD and M/D/YYYY dates and rejects everything else", () => {
    expect(ProjectCsv.resolveDate("2026-10-03")).toBe("2026-10-03");
    expect(ProjectCsv.resolveDate("10/3/2026")).toBe("2026-10-03");
    expect(ProjectCsv.resolveDate("01/09/2027")).toBe("2027-01-09");
    expect(ProjectCsv.resolveDate("")).toBeNull();
    expect(ProjectCsv.resolveDate("2/30/2026")).toBeUndefined();
    expect(ProjectCsv.resolveDate("2026-13-01")).toBeUndefined();
    expect(ProjectCsv.resolveDate("Oct 3 2026")).toBeUndefined();
    expect(ProjectCsv.resolveDate("10/3/26")).toBeUndefined();
  });

  it("reports missing required columns, duplicate columns, unknown columns and bad CSV", () => {
    expect(ProjectCsv.parse("name,owner\nA,B\n", ProjectCsv.REQUIRED_FOR_CREATE).fileErrors).toEqual([
      "Missing required column(s): service_area, status.",
    ]);
    const dup = ProjectCsv.parse("name,Name,service_area,owner,status,extra\nA,A,Cath,B,On track,x\n", ProjectCsv.REQUIRED_FOR_CREATE);
    expect(dup.fileErrors).toEqual(['Column "name" appears more than once.']);
    expect(dup.fileWarnings).toEqual(['Unknown column "extra" will be ignored.']);
    expect(ProjectCsv.parse('name,service_area\n"unterminated,Cath\n', ["name"]).fileErrors[0]).toMatch(/could not be read as CSV/);
    expect(ProjectCsv.parse("", ["name"]).fileErrors).toEqual(["The file is empty. Start from the template."]);
  });

  it("handles a UTF-8 BOM, quoted commas, multi-line cells and blank lines", () => {
    const csv = '\ufeffName,service_area,owner,status,note\n"Smith, J project",Cath,Owner A,On track,"line one\nline two"\n\n,,,,\n';
    const parsed = ProjectCsv.parse(csv, ProjectCsv.REQUIRED_FOR_CREATE);
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].cells.name).toBe("Smith, J project");
    expect(parsed.rows[0].cells.note).toBe("line one\nline two");
  });
});
