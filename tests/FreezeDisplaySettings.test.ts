import { describe, expect, it, vi, beforeEach } from "vitest";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportDisplaySettings } from "@/lib/report/ReportDisplaySettings";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { PdfCanonical } from "./helpers/PdfCanonical";

// Roles & Permissions: freeze, archive, report options and year-end storage are Owner-only; the admin here is the Owner.
beforeEach(() => {
  vi.stubEnv("OWNER_EMAIL", "admin@example.org");
});

// Fictional snapshot through the freeze's render path (inputFromSnapshot + render), clock pinned.
function snapshot(displaySettingsJson?: unknown) {
  const d = SampleReportData.docInput();
  const rows = d.rows.map((r) => (r.projectId === "sample-2" || r.projectId === "sample-6" ? { ...r, isMfi: true as const } : r));
  return {
    id: "00000000-0000-4000-8000-00000000f001",
    rowsJson: rows,
    headerJson: d.header,
    completedJson: d.completed,
    viewSettingsJson: d.viewSettings,
    optionsJson: { showKeyPage: true },
    serviceLineJson: d.serviceLine,
    layoutJson: { columns: null, rows: { IR: rows.filter((r) => r.serviceArea === "IR").map((r) => r.projectId).reverse() } },
    periodStart: new Date("2026-09-15T00:00:00Z"),
    periodEnd: new Date("2026-09-29T00:00:00Z"),
    generatedAt: SampleReportData.GENERATED_AT,
    ...(displaySettingsJson === undefined ? {} : { displaySettingsJson }),
  };
}
// Fingerprint of the PDF content, not its compressed bytes: Node's zlib compresses differently on different
// machines, so a raw byte hash failed everywhere except the machine that recorded it (see PdfCanonical).
const sha = (b: Buffer) => PdfCanonical.sha(b);
// Content fingerprint of the freeze PDF on main @ 4081287; its raw-byte hash was 0d29953e... when compressed with
// standard zlib (checked Nov 3, 2026: same render, same bytes once decompressed).
const MAIN_FREEZE_PDF = "631cdaf524e369e5a86f158643f58e553148ad2283ac724d43d281f3c77da2c5";
async function render(s: ReturnType<typeof snapshot>) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SampleReportData.GENERATED_AT);
  try {
    return await PdfReportRenderer.render(PdfReportRenderer.inputFromSnapshot(s as never));
  } finally {
    vi.useRealTimers();
  }
}

describe("Freeze display settings (0064)", () => {
  it("no saved settings: the freeze PDF is byte-identical to main @ 4081287 (same fixture and harness)", async () => {
    expect(sha(await render(snapshot()))).toBe(MAIN_FREEZE_PDF);
    expect(sha(await render(snapshot(null)))).toBe(MAIN_FREEZE_PDF);
  }, 60000);

  it("recorded settings change the render (Updated hidden, PDF order, managers)", async () => {
    const saved = ReportDisplaySettings.forSnapshot(ReportDisplaySettings.CURRENT, { Cath: "Riley Sample" });
    const s = snapshot(saved);
    const doc = PdfReportRenderer.docInput(PdfReportRenderer.inputFromSnapshot(s as never));
    expect(doc).toMatchObject({ showUpdatedOn: false, pdfDefaultOrder: true, departmentManagers: { Cath: "Riley Sample" } });
    expect(sha(await render(s))).not.toBe(MAIN_FREEZE_PDF);
  }, 60000);

  it("parse, toDoc and summary", () => {
    expect(ReportDisplaySettings.parse(null)).toBeNull();
    expect(ReportDisplaySettings.parse({ showUpdatedOn: "yes" })).toBeNull();
    expect(ReportDisplaySettings.toDoc(null)).toEqual({ showUpdatedOn: true, pdfDefaultOrder: false });
    expect(ReportDisplaySettings.forSnapshot({ ...ReportDisplaySettings.CURRENT, showDepartmentManagers: false }, { Cath: "Riley Sample" })).not.toHaveProperty("departmentManagers");
    expect(ReportDisplaySettings.summary(ReportDisplaySettings.CURRENT)).toBe("Next freeze will use: Updated dates hidden, PDF order within departments, department managers shown.");
    expect(ReportDisplaySettings.summary(null)).not.toContain("\u2014");
  });
});

describe("Reports page: Next freeze will use", () => {
  it("shows the summary in a compact dark glass line, admins and the scheduled line only", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/reports/page.tsx", "utf8");
    expect(src).toContain('data-testid="next-freeze-display"');
    expect(src).toContain("ReportDisplaySettings.summary(nextDisplay)");
    expect(src).toMatch(/backdrop-blur/);
    // Owner only (L1): the loader reads the next display only for the Owner, and only on the scheduled line.
    const loader = readFileSync("src/lib/report/ReportsPageData.ts", "utf8");
    expect(loader).toMatch(/if \(!OwnerPolicy\.isOwner\(viewer\)\) return \{ kind: "viewer"/);
    expect(loader).toContain("const nextDisplay = scope.isDefault");
  });
});
