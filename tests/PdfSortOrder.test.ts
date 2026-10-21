import { describe, expect, it } from "vitest";
import type { ProjectStatus } from "@/generated/prisma/enums";
import type { ReportRow } from "@/lib/domain/types";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { SampleReportData } from "@/lib/report/SampleReportData";

// Fictional rows only.
const row = (id: string, area: string, status: ProjectStatus, isMfi = false): ReportRow => ({
  ...SampleReportData.rows()[0],
  projectId: id,
  name: `Sample: ${id}`,
  serviceArea: area,
  status,
  statusLabel: status,
  changed: false,
  overdue: false,
  stale: false,
  ...(status === "Complete" ? { completedInPeriod: true as const } : {}),
  ...(isMfi ? { isMfi: true as const } : {}),
});

const rows: ReportRow[] = [
  row("ns", "Cath", "NotStarted"),
  row("hold", "Cath", "OnHold"),
  row("off", "Cath", "OffTrack"),
  row("risk", "Cath", "AtRisk"),
  row("track", "Cath", "OnTrack"),
  row("mfi-active", "Cath", "AtRisk", true),
  row("done", "Cath", "Complete"),
  row("done-mfi", "Cath", "Complete", true),
  row("ep-off", "EP", "OffTrack"),
  row("ep-track", "EP", "OnTrack"),
];

const listed = (input: Parameters<typeof ReportLayout.layout>[0]) =>
  ReportLayout.layout(input).pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === "row" ? [{ area: b.area, name: b.row.cells.find((c) => c.kind === "project") }] : []));

const base = () => SampleReportData.docInput({ rows, completed: [], viewSettings: ViewSettings.normalize("report", null) });

describe("PDF sort order (item 9)", () => {
  it("default order inside a department: completed MFI, completed, active MFI, on track, at risk, off track, on hold, not started", () => {
    expect(ReportLayout.pdfDefaultOrder(rows).map((r) => r.projectId)).toEqual(["done-mfi", "done", "mfi-active", "track", "risk", "off", "hold", "ns", "ep-track", "ep-off"]);
  });

  it("keeps the department order (Cath before EP) in the laid out PDF", () => {
    const areas = listed(base()).map((r) => r.area);
    expect(areas.indexOf("EP")).toBeGreaterThan(areas.lastIndexOf("Cath"));
  });

  it("a manual dashboard order for a department wins, exactly; other departments keep the default", () => {
    const input = { ...base(), layout: { columns: null, rows: { Cath: ["ns", "track", "done", "risk", "off", "hold", "mfi-active", "done-mfi"] } } };
    const ids = ReportLayout.layout(input).pages.flatMap((p) => p.blocks).flatMap((b) => (b.kind === "row" ? [b.row] : []));
    expect(ids.length).toBeGreaterThan(0);
    const order = ReportLayout.pdfDefaultOrder(rows);
    expect(order[0].projectId).toBe("done-mfi");
    const names = listed(input).map((r) => (r.name && r.name.kind === "project" ? r.name.lines.join(" ") : ""));
    expect(names.slice(0, 8)).toEqual(["ns", "track", "done", "risk", "off", "hold", "mfi-active", "done-mfi"].map((i) => `Sample: ${i}`));
    expect(names.slice(8)).toEqual(["Sample: ep-track", "Sample: ep-off"]);
  });

  it("never touches the input order (dashboard is never auto-reordered)", () => {
    const copy = rows.map((r) => r.projectId);
    ReportLayout.layout(base());
    expect(rows.map((r) => r.projectId)).toEqual(copy);
  });
});
