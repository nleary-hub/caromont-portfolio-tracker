import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { ServiceLineLabel } from "@/components/ServiceLineLabel";
import { ServiceLine, ServiceLineValidationError } from "@/lib/domain/ServiceLine";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { PdfReportLayout } from "@/lib/report/PdfReportLayout";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ProjectService } from "@/lib/services/ProjectService";
import { ServiceLineForm } from "@/lib/services/ServiceLineForm";
import { ServiceLineService } from "@/lib/services/ServiceLineService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const ADMIN = Factory.ADMIN;
const MEMBER = { email: "member@example.org", isAdmin: false };
const SEED = { name: "Cardiovascular & Pulmonary Service Line", shortName: "CVPSL" };

describe("ServiceLine (pure rules)", () => {
  it("seeds the full and short names", () => {
    expect(ServiceLine.defaults()).toEqual(SEED);
    expect(ServiceLine.reportTitle(SEED)).toBe("Cardiovascular & Pulmonary Service Line: Project Status Report");
  });

  it("requires both names, trims and collapses spaces, and enforces max lengths (short up to 12)", () => {
    expect(ServiceLine.parse({ name: "  Heart   and Lung  ", shortName: " HL " })).toEqual({ name: "Heart and Lung", shortName: "HL" });
    expect(() => ServiceLine.parse({ name: " ", shortName: "X" })).toThrow(ServiceLineValidationError);
    expect(() => ServiceLine.parse({ name: "Name", shortName: "" })).toThrow(ServiceLineValidationError);
    expect(ServiceLine.parse({ name: "x".repeat(80), shortName: "A".repeat(12) }).shortName).toHaveLength(12);
    try {
      ServiceLine.parse({ name: "x".repeat(81), shortName: "A".repeat(13) });
      expect.unreachable();
    } catch (e) {
      expect((e as ServiceLineValidationError).errors).toEqual({
        name: "Service line name must be 80 characters or fewer.",
        shortName: "Short name must be 12 characters or fewer.",
      });
    }
  });

  it("normalize falls back to the seed for missing or invalid parts", () => {
    expect(ServiceLine.normalize(null)).toEqual(SEED);
    expect(ServiceLine.normalize({ name: "Heart", shortName: "" })).toEqual({ name: "Heart", shortName: "CVPSL" });
  });
});

describe("ServiceLineService", () => {
  it("falls back to the seed values when the settings row is unset", async () => {
    const fake = new FakeDb();
    expect(await ServiceLineService.get(fake.asClient())).toEqual(SEED);
  });

  it("admin update writes the row and one audit entry (old, new, who, when) in one transaction", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const before = Date.now();
    const saved = await ServiceLineService.update({ name: "Heart and Vascular Service Line", shortName: "HVSL" }, ADMIN, db);
    expect(saved).toEqual({ name: "Heart and Vascular Service Line", shortName: "HVSL" });
    expect(await ServiceLineService.get(db)).toEqual(saved);
    expect(fake.state.serviceLineSettings[0]).toMatchObject({ id: "service_line", updatedBy: ADMIN.email });
    expect(fake.state.serviceLineSettingsHistory).toHaveLength(1);
    const h = fake.state.serviceLineSettingsHistory[0];
    expect(h).toMatchObject({ oldValue: SEED, newValue: saved, changedBy: ADMIN.email });
    expect((h.changedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(fake.writes.filter((w) => w.model.startsWith("serviceLine")).every((w) => w.inTx)).toBe(true);

    const changes = await ServiceLineService.history(ADMIN, 20, db);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ oldValue: SEED, newValue: saved, changedBy: ADMIN.email });
  });

  it("an unchanged save writes nothing", async () => {
    const fake = new FakeDb();
    await ServiceLineService.update({ name: SEED.name, shortName: ` ${SEED.shortName} ` }, ADMIN, fake.asClient());
    expect(fake.state.serviceLineSettings).toHaveLength(0);
    expect(fake.state.serviceLineSettingsHistory).toHaveLength(0);
  });

  it("rejects non-admins (service and history) and writes nothing", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await expect(ServiceLineService.update({ name: "X", shortName: "X" }, MEMBER, db)).rejects.toThrow(AdminRequiredError);
    await expect(ServiceLineService.history(MEMBER, 20, db)).rejects.toThrow(AdminRequiredError);
    expect(fake.writes).toHaveLength(0);
  });
});

describe("ServiceLineForm.submit (the Server Action body)", () => {
  it("returns Not authorized for non-admins and no viewer, writing nothing", async () => {
    const fake = new FakeDb();
    expect(await ServiceLineForm.submit(MEMBER, { name: "X", shortName: "X" }, fake.asClient())).toEqual({ ok: false, message: "Not authorized." });
    expect(await ServiceLineForm.submit(null, { name: "X", shortName: "X" }, fake.asClient())).toEqual({ ok: false, message: "Not authorized." });
    expect(fake.writes).toHaveLength(0);
  });

  it("returns field errors for invalid input and saves valid input", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const bad = await ServiceLineForm.submit(ADMIN, { name: "", shortName: "WAYTOOLONGNAME" }, db);
    expect(bad).toMatchObject({ ok: false, errors: { name: "Service line name is required.", shortName: "Short name must be 12 characters or fewer." } });
    expect(fake.writes).toHaveLength(0);
    const good = await ServiceLineForm.submit(ADMIN, { name: "Heart", shortName: "H" }, db);
    expect(good).toMatchObject({ ok: true, value: { name: "Heart", shortName: "H" } });
  });
});

describe("report title and frozen snapshots", () => {
  const period1 = { periodStart: "2026-09-23", periodEnd: "2026-10-07", generatedBy: "nick", now: new Date("2026-10-07T10:00:00Z") };
  const period2 = { periodStart: "2026-10-07", periodEnd: "2026-10-21", generatedBy: "nick", now: new Date("2026-10-21T10:00:00Z") };

  it("a snapshot keeps the name it was frozen with after the setting changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ name: "P", serviceArea: "Cath", owner: "O", status: "OnTrack", nextMilestone: "M" }, { changedBy: "x" }, db);

    const s1 = await SnapshotService.create(period1, db);
    expect(s1.serviceLineJson).toEqual(SEED);

    await ServiceLineService.update({ name: "Heart and Vascular Service Line", shortName: "HVSL" }, ADMIN, db);
    const s2 = await SnapshotService.create(period2, db);

    const in1 = PdfReportRenderer.inputFromSnapshot(fake.state.snapshots.find((s) => s.id === s1.id) as never);
    const in2 = PdfReportRenderer.inputFromSnapshot(s2);
    expect(in1.serviceLine.name).toBe(SEED.name);
    expect(in2.serviceLine.name).toBe("Heart and Vascular Service Line");

    const m = new TextMeasure();
    const l1 = ReportLayout.layout(PdfReportRenderer.docInput(in1), m);
    const l2 = ReportLayout.layout(PdfReportRenderer.docInput(in2), m);
    expect(l1.header.title).toBe("Cardiovascular & Pulmonary Service Line: Project Status Report");
    expect(l2.header.title).toBe("Heart and Vascular Service Line: Project Status Report");
    vi.restoreAllMocks();
  });

  it("snapshots frozen before migration 0014 (no serviceLineJson) keep the legacy title", () => {
    expect(ServiceLine.fromSnapshot(null).name).toBe("Cardiac Service Line");
    const input = PdfReportRenderer.inputFromSnapshot({
      id: "old",
      rowsJson: [],
      headerJson: null,
      completedJson: null,
      viewSettingsJson: null,
      optionsJson: null,
      serviceLineJson: null,
      periodStart: new Date("2026-08-26T00:00:00Z"),
      periodEnd: new Date("2026-09-09T00:00:00Z"),
      generatedAt: new Date("2026-09-09T21:00:00Z"),
    });
    expect(PdfReportRenderer.docInput(input).serviceLineName).toBe("Cardiac Service Line");
    expect(PdfReportLayout.title(input.serviceLine.name)).toBe("Cardiac Service Line: Project Status Report");
    expect(PdfReportLayout.TITLE).toBe("Cardiac Service Line: Project Status Report");
  });

  it("drafts and samples: the layout title and footer use the given name; no name keeps the legacy title", () => {
    const m = new TextMeasure();
    const named = ReportLayout.layout(SampleReportData.docInput({ serviceLineName: "Heart" }), m);
    expect(named.header.title).toBe("Heart: Project Status Report");
    expect(named.header.footerLeft).toContain("Heart: Project Status Report");
    expect(ReportLayout.layout(SampleReportData.docInput(), m).header.title).toBe(PdfReportLayout.TITLE);
  });

  it("handoff.json title follows the frozen name", () => {
    const h = HandoffBuilder.build({
      snapshotId: "s",
      periodStart: "2026-09-15",
      periodEnd: "2026-09-29",
      reportDate: "2026-09-29",
      frozenAt: new Date("2026-09-29T21:00:00Z"),
      rows: [],
      header: null,
      pdf: { fileName: "r.pdf", sha256: "x", byteSize: 1 },
      baseUrl: null,
      reportRecipient: null,
      serviceLineName: "Heart",
    });
    expect(h.title).toBe("Heart: Project Status Report");
  });
});

describe("ServiceLineLabel (responsive top bar name)", () => {
  const html = renderToStaticMarkup(createElement(ServiceLineLabel, { value: SEED }));

  it("renders the full name (visible from the topbar breakpoint up, screen-reader text below it)", () => {
    expect(html).toContain('class="sr-only topbar:not-sr-only topbar:block topbar:truncate" data-service-line-full="">Cardiovascular &amp; Pulmonary Service Line</span>');
  });

  it("renders the short name below the breakpoint with the full name as its tooltip", () => {
    expect(html).toContain('<span aria-hidden="true" title="Cardiovascular &amp; Pulmonary Service Line" class="topbar:hidden" data-service-line-short="">CVPSL</span>');
  });
});
