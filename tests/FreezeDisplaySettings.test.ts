import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportDisplaySettings } from "@/lib/report/ReportDisplaySettings";
import { SampleReportData } from "@/lib/report/SampleReportData";

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
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
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
    expect(sha(await render(snapshot()))).toBe("0d29953e31f6fa5e41f399dc630e3407cd89c0d0a91d3280a78c8dbd8fceac1a");
    expect(sha(await render(snapshot(null)))).toBe("0d29953e31f6fa5e41f399dc630e3407cd89c0d0a91d3280a78c8dbd8fceac1a");
  }, 60000);

  it("recorded settings change the render (Updated hidden, PDF order, managers)", async () => {
    const saved = ReportDisplaySettings.forSnapshot(ReportDisplaySettings.CURRENT, { Cath: "Riley Sample" });
    const s = snapshot(saved);
    const doc = PdfReportRenderer.docInput(PdfReportRenderer.inputFromSnapshot(s as never));
    expect(doc).toMatchObject({ showUpdatedOn: false, pdfDefaultOrder: true, departmentManagers: { Cath: "Riley Sample" } });
    expect(sha(await render(s))).not.toBe("0d29953e31f6fa5e41f399dc630e3407cd89c0d0a91d3280a78c8dbd8fceac1a");
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
    expect(src).toContain("viewer.isAdmin && scope.isDefault");
  });
});
